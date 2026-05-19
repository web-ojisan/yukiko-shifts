package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/jwtauth/v5"
	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"

	"github.com/yourorg/shift-app/internal/handler"
	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/push"
	"github.com/yourorg/shift-app/internal/repository"
	"github.com/yourorg/shift-app/internal/storage"
	"github.com/yourorg/shift-app/internal/validator"
)

// contextキー型（文字列キーの衝突防止）
type contextKey string

const (
	ctxTenantID contextKey = "tenant_id"
	ctxUserID   contextKey = "user_id"
	ctxRole     contextKey = "role"
)

func main() {
	jwtSecret      := getEnv("JWT_SECRET",       "change-me-in-production-32chars!!")
	dbPath         := getEnv("DB_PATH",          "./shift.db")
	port           := getEnv("PORT",             "8989")
	vapidPublicKey  := getEnv("VAPID_PUBLIC_KEY",  "")
	vapidPrivateKey := getEnv("VAPID_PRIVATE_KEY", "")

	db, err := sqlx.Open("sqlite3", dbPath+"?_foreign_keys=on&_journal_mode=WAL")
	if err != nil {
		log.Fatalf("DB open: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := runMigrations(db.DB); err != nil {
		log.Fatalf("migration: %v", err)
	}

	// VAPID キーが未設定の場合はヒントをログに出す
	if vapidPublicKey == "" || vapidPrivateKey == "" {
		log.Println("⚠ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です。プッシュ通知は無効になります。")
		log.Println("  キーを生成するには: docker run --rm golang:1.22-alpine sh -c '" +
			`go install github.com/SherClockHolmes/webpush-go/cmd/vapid@latest && vapid'`)
	}

	tokenAuth  := jwtauth.New("HS256", []byte(jwtSecret), nil)
	userRepo   := repository.NewUserRepository(db)
	shiftRepo  := repository.NewShiftRepository(db)
	reportRepo := repository.NewDailyReportRepository(db)
	siteRepo   := repository.NewSiteRepository(db)
	lockRepo   := repository.NewLockRepository(db)
	pushRepo       := repository.NewPushRepository(db)
	foremanRepo    := repository.NewForemanRepository(db)
	attendanceRepo := repository.NewAttendanceRepository(db)
	shiftVal       := validator.New(shiftRepo)

	photoStorage := storage.New(getEnv("DATA_DIR", "./data"))

	// プッシュ送信者（キー未設定なら nil → 全送信がno-op）
	pushSender := push.NewSender(vapidPrivateKey, vapidPublicKey)

	authH    := handler.NewAuthHandler(userRepo, tokenAuth)
	shiftH   := handler.NewShiftHandler(shiftRepo, userRepo, foremanRepo, shiftVal)
	reportH  := handler.NewDailyReportHandler(reportRepo)
	siteH    := handler.NewSiteHandler(siteRepo)
	lockH    := handler.NewLockHandler(lockRepo)
	pushH    := handler.NewPushHandler(pushRepo, userRepo, pushSender)
	foremanH    := handler.NewForemanHandler(foremanRepo, shiftRepo)
	attendanceH := handler.NewAttendanceHandler(attendanceRepo, photoStorage)

	// 毎日 19:00 JST に翌日シフトのリマインドを送信
	go startDailyReminder(db, pushRepo, pushSender)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(corsMiddleware)

	// 静的ファイル
	r.Handle("/static/*", http.StripPrefix("/static/",
		http.FileServer(http.Dir("./frontend/static"))))

	// ローカル開発用 写真配信（R2利用時は不要）
	dataDir := getEnv("DATA_DIR", "./data")
	r.Handle("/photos/*", http.StripPrefix("/photos/",
		http.FileServer(http.Dir(dataDir+"/photos"))))

	// 認証不要
	r.Post("/api/auth/login", authH.Login)
	r.Get("/qr-login", authH.QRLogin) // QRコードスキャンによるログイン

	// 認証必要 + テナント自動注入
	r.Group(func(r chi.Router) {
		r.Use(jwtauth.Verifier(tokenAuth))
		r.Use(jwtauth.Authenticator(tokenAuth))
		r.Use(tenantMiddleware) // ★ JWTからtenant_idをContextに注入

		r.Get("/api/workers",                    shiftH.GetWorkers)
		r.Post("/api/admin/workers",             handler.RequireAdmin(shiftH.CreateWorker))
		r.Put("/api/admin/workers/{id}",         handler.RequireAdmin(shiftH.UpdateWorker))
		r.Get("/api/admin/workers/qr-tokens",    handler.RequireAdmin(shiftH.GetWorkerQRTokens))
		r.Post("/api/admin/workers/{id}/regenerate-qr", handler.RequireAdmin(shiftH.RegenerateQR))
		r.Get("/api/shifts/board",  shiftH.GetBoard)
		r.Get("/api/shifts/my",     shiftH.GetMyShifts)

		r.Post("/api/sites/{siteID}/shifts/{date}/assign",
			handler.RequireAdmin(shiftH.CreateAssign))
		r.Delete("/api/shifts/assign/{id}",
			handler.RequireAdmin(shiftH.DeleteAssign))

		// 現場マスタ
		r.Get("/api/sites",        siteH.List)
		r.Get("/api/sites/{id}",   siteH.Get)
		r.Post("/api/sites",       handler.RequireAdmin(siteH.Create))
		r.Put("/api/sites/{id}",   handler.RequireAdmin(siteH.Update))

		r.Put("/api/reports/{date}",        reportH.Upsert)
		r.Get("/api/reports/my",            reportH.GetMyMonthly)
		r.Put("/api/reports/site-client",   reportH.UpdateSiteClient)
		r.Post("/api/reports/submit",       reportH.Submit)

		r.Get("/api/reports/summary",
			handler.RequireAdmin(reportH.GetSummary))

		// シフトロック
		r.Get("/api/shifts/lock",                  lockH.GetStatus)
		r.Post("/api/admin/shifts/lock",            handler.RequireAdmin(lockH.Lock))
		r.Delete("/api/admin/shifts/lock",          handler.RequireAdmin(lockH.Unlock))

		// Web Push
		r.Get("/api/push/vapid-key",    pushH.GetVapidKey)
		r.Post("/api/push/subscribe",   pushH.Subscribe)
		r.Delete("/api/push/subscribe", pushH.Unsubscribe)
		r.Post("/api/push/hope-submit", pushH.HopeSubmit)

		// 職長優先順位（現場別）
		r.Get("/api/sites/{siteID}/foreman-priorities", foremanH.GetPriorities)
		r.Put("/api/sites/{siteID}/foreman-priorities", handler.RequireAdmin(foremanH.SetPriorities))

		// 職長アサイン
		r.Get("/api/foreman/assignments",    foremanH.GetAssignments)
		r.Put("/api/foreman/assignments",    handler.RequireAdmin(foremanH.UpsertAssignment))
		r.Delete("/api/foreman/assignments", handler.RequireAdmin(foremanH.DeleteAssignment))

		// 職長自動提案（ロック時確認用）
		r.Get("/api/foreman/suggest", handler.RequireAdmin(foremanH.Suggest))

		// 職長によるチーム日報一括入力
		r.Get("/api/foreman/team-reports", foremanH.GetTeamReports)
		r.Put("/api/foreman/team-reports", foremanH.UpsertTeamReports)

		// 出退勤打刻
		r.Get("/api/attendance/today",      attendanceH.GetToday)
		r.Post("/api/attendance/clock-in",  attendanceH.ClockIn)
		r.Post("/api/attendance/clock-out", attendanceH.ClockOut)
	})

	// SPAフォールバック
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./frontend/templates/index.html")
	})

	log.Printf("起動: http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, r); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// ── テナントミドルウェア ─────────────────────────────────────────
// JWTのclaimsからtenant_idを取り出してContextに注入する。
// 全APIハンドラーはこのContextからtenant_idを取得するだけでOK。
func tenantMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, claims, err := jwtauth.FromContext(r.Context())
		if err != nil || claims == nil {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		tenantID := int64(claims["tenant_id"].(float64))
		userID   := int64(claims["user_id"].(float64))
		role, _  := claims["role"].(string)

		ctx := context.WithValue(r.Context(), ctxTenantID, tenantID)
		ctx  = context.WithValue(ctx,          ctxUserID,   userID)
		ctx  = context.WithValue(ctx,          ctxRole,     role)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ── マイグレーション ─────────────────────────────────────────────
// db/migrations/ 以下の *.sql をファイル名昇順で実行する。
// ALTER TABLE など冪等でないステートメントは "duplicate column" エラーを無視する。
func runMigrations(db *sql.DB) error {
	entries, err := os.ReadDir("./db/migrations")
	if err != nil {
		return fmt.Errorf("ReadDir migrations: %w", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		data, err := os.ReadFile("./db/migrations/" + name)
		if err != nil {
			return fmt.Errorf("ReadFile %s: %w", name, err)
		}
		if _, err := db.Exec(string(data)); err != nil {
			// SQLite の "duplicate column name" は冪等とみなして無視
			if !strings.Contains(err.Error(), "duplicate column name") {
				return fmt.Errorf("migration %s: %w", name, err)
			}
			log.Printf("migration %s: skipped (already applied)", name)
		} else {
			log.Printf("migration %s: applied", name)
		}
	}
	return nil
}

// ── CORS ─────────────────────────────────────────────────────────
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── 毎日 19:00 JST の翌日シフトリマインド ─────────────────────────
// reminderSender は sendTomorrowReminders が使う最小インターフェース（テスト用モックを差し込み可能）
type reminderSender interface {
	SendAll(subs []model.PushSubscription, title, body, url string)
}

func startDailyReminder(db *sqlx.DB, pushRepo *repository.PushRepository, sender *push.Sender) {
	// nil *push.Sender をインターフェースに変換すると non-nil interface になるため、
	// ここで明示的に nil チェックして早期 return する
	if sender == nil {
		log.Println("daily reminder: disabled (VAPID keys not configured)")
		return
	}
	jst, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		jst = time.FixedZone("JST", 9*60*60)
	}
	for {
		now := time.Now().In(jst)
		next := time.Date(now.Year(), now.Month(), now.Day(), 19, 0, 0, 0, jst)
		if !now.Before(next) {
			next = next.Add(24 * time.Hour)
		}
		log.Printf("daily reminder: 次回送信 %s", next.Format("2006-01-02 15:04 MST"))
		time.Sleep(time.Until(next))
		sendTomorrowReminders(db, pushRepo, sender)
	}
}

func sendTomorrowReminders(db *sqlx.DB, pushRepo *repository.PushRepository, sender reminderSender) {
	if sender == nil {
		return
	}
	ctx := context.Background()
	jst, _ := time.LoadLocation("Asia/Tokyo")
	tomorrow := time.Now().In(jst).Add(24 * time.Hour).Format("2006-01-02")

	type row struct {
		UserID   int64  `db:"user_id"`
		UserName string `db:"user_name"`
		SiteName string `db:"site_name"`
		TimeSlot string `db:"time_slot"`
	}
	var rows []row
	err := db.SelectContext(ctx, &rows, `
		SELECT sa.user_id, u.name AS user_name, s.name AS site_name, sa.time_slot
		FROM shift_assignments sa
		JOIN users u ON sa.user_id = u.id
		JOIN sites s ON sa.site_id = s.id
		WHERE sa.work_date = ?`, tomorrow)
	if err != nil {
		log.Printf("daily reminder: クエリエラー: %v", err)
		return
	}

	// ユーザーごとにまとめる
	type userInfo struct{ name string; slots []string }
	byUser := map[int64]*userInfo{}
	for _, r := range rows {
		if _, ok := byUser[r.UserID]; !ok {
			byUser[r.UserID] = &userInfo{name: r.UserName}
		}
		byUser[r.UserID].slots = append(byUser[r.UserID].slots, r.SiteName+"("+r.TimeSlot+")")
	}

	sent := 0
	for userID, info := range byUser {
		subs, err := pushRepo.GetByUserID(ctx, userID)
		if err != nil || len(subs) == 0 {
			continue
		}
		body := "明日のシフト: " + strings.Join(info.slots, " / ")
		sender.SendAll(subs, "シフトリマインド", body, "/")
		sent++
	}
	log.Printf("daily reminder: %s 分のリマインドを %d 人に送信", tomorrow, sent)
}
