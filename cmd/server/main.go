package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/jwtauth/v5"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite" // Pure Go SQLiteドライバ（CGO不要）

	"github.com/yourorg/shift-app/internal/billing"
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
	jwtSecret := os.Getenv("JWT_SECRET")
	if len(jwtSecret) < 32 {
		log.Fatal("JWT_SECRET が未設定か32文字未満です。32文字以上のランダム文字列を設定してください（生成例: openssl rand -base64 32）")
	}
	dbPath         := getEnv("DB_PATH",          "./shift.db")
	port           := getEnv("PORT",             "8989")
	vapidPublicKey  := getEnv("VAPID_PUBLIC_KEY",  "")
	vapidPrivateKey := getEnv("VAPID_PRIVATE_KEY", "")

	db, err := sqlx.Open("sqlite",
		dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
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
		log.Println("  キーを生成するには: docker run --rm golang:1.26-alpine sh -c '" +
			`go install github.com/SherClockHolmes/webpush-go/cmd/vapid@latest && vapid'`)
	}

	tokenAuth  := jwtauth.New("HS256", []byte(jwtSecret), nil)
	userRepo   := repository.NewUserRepository(db)
	shiftRepo  := repository.NewShiftRepository(db)
	reportRepo := repository.NewDailyReportRepository(db)
	siteRepo   := repository.NewSiteRepository(db)
	lockRepo   := repository.NewLockRepository(db)
	pushRepo    := repository.NewPushRepository(db)
	foremanRepo := repository.NewForemanRepository(db)
	cryptoRepo  := repository.NewCryptoRepository(db)
	billingRepo := repository.NewBillingRepository(db)
	shiftVal    := validator.New(shiftRepo)

	attendanceEnabled := getEnv("ATTENDANCE_ENABLED", "false") == "true"
	demoLoginEnabled  := getEnv("DEMO_LOGIN", "false") == "true"
	if demoLoginEnabled {
		log.Println("⚠ デモ用クイックログイン: 有効 (本番では DEMO_LOGIN を設定しないでください)")
	}

	// プッシュ送信者（キー未設定なら nil → 全送信がno-op）
	pushSender := push.NewSender(vapidPrivateKey, vapidPublicKey)

	authH    := handler.NewAuthHandler(userRepo, tokenAuth)
	shiftH   := handler.NewShiftHandler(shiftRepo, userRepo, foremanRepo, billingRepo, shiftVal)
	exportH  := handler.NewExportHandler(reportRepo, billingRepo)
	reportH  := handler.NewDailyReportHandler(reportRepo)
	siteH    := handler.NewSiteHandler(siteRepo)
	lockH    := handler.NewLockHandler(lockRepo)
	pushH    := handler.NewPushHandler(pushRepo, userRepo, pushSender)
	foremanH := handler.NewForemanHandler(foremanRepo, shiftRepo)
	cryptoH  := handler.NewCryptoHandler(cryptoRepo)

	// Stripeセルフサーブ課金（キー未設定なら無効。既存機能には影響しない）
	baseURL      := getEnv("BASE_URL", "http://localhost:"+port)
	stripeClient := billing.New(
		os.Getenv("STRIPE_SECRET_KEY"),
		os.Getenv("STRIPE_WEBHOOK_SECRET"),
		os.Getenv("STRIPE_PRICE_ENTRY"),
		os.Getenv("STRIPE_PRICE_BASIC"),
		os.Getenv("STRIPE_PRICE_PRO"),
	)
	billingH := handler.NewBillingHandler(billingRepo, stripeClient, baseURL)
	if billingH.Enabled() {
		log.Println("オンライン申込 (Stripe): 有効")
	} else {
		log.Println("オンライン申込 (Stripe): 無効 (STRIPE_SECRET_KEY 等の設定で有効化)")
	}

	var attendanceH *handler.AttendanceHandler
	if attendanceEnabled {
		attendanceRepo := repository.NewAttendanceRepository(db)
		photoStorage   := storage.New(getEnv("DATA_DIR", "./data"))
		attendanceH     = handler.NewAttendanceHandler(attendanceRepo, photoStorage)
		log.Println("出退勤打刻機能: 有効")
	} else {
		log.Println("出退勤打刻機能: 無効 (ATTENDANCE_ENABLED=true で有効化)")
	}

	// 毎日 19:00 JST に翌日シフトのリマインドを送信
	go startDailyReminder(db, pushRepo, pushSender)

	r := chi.NewRouter()
	r.Use(requestLogger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	// 静的ファイル
	r.Handle("/static/*", http.StripPrefix("/static/",
		http.FileServer(http.Dir("./frontend/static"))))

	// ローカル開発用 写真配信（ATTENDANCE_ENABLED かつ R2未設定時のみ有効）
	if attendanceEnabled && os.Getenv("R2_ACCOUNT_ID") == "" {
		dataDir := getEnv("DATA_DIR", "./data")
		r.Handle("/photos/*", http.StripPrefix("/photos/",
			http.FileServer(http.Dir(dataDir+"/photos"))))
	}

	// 認証不要
	r.Post("/api/auth/login", authH.Login)
	r.Get("/qr-login", authH.QRLogin) // QRコードスキャンによるログイン

	// フロント向け公開設定（ログイン画面が参照するため認証不要）
	r.Get("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"demo_login":%t,"billing_enabled":%t}`, demoLoginEnabled, billingH.Enabled())
	})

	// セルフサーブ申込（認証不要）
	r.Post("/api/signup/checkout", billingH.SignupCheckout)
	r.Get("/api/signup/complete",  billingH.SignupComplete)
	r.Post("/api/stripe/webhook",  billingH.Webhook)
	r.Get("/signup", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./frontend/static/signup.html")
	})
	r.Get("/signup/complete", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./frontend/static/signup-complete.html")
	})
	r.Get("/tokushoho", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./frontend/static/tokushoho.html")
	})
	r.Get("/terms", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./frontend/static/terms.html")
	})

	// 契約ポータル: 契約停止中でも管理者が支払いを直せるよう、状態チェックの外に置く
	r.Group(func(r chi.Router) {
		r.Use(jwtauth.Verifier(tokenAuth))
		r.Use(jwtauth.Authenticator(tokenAuth))
		r.Use(tenantMiddleware)
		r.Post("/api/admin/billing/portal", handler.RequireAdmin(billingH.Portal))
	})

	// 認証必要 + テナント自動注入 + 契約状態チェック
	r.Group(func(r chi.Router) {
		r.Use(jwtauth.Verifier(tokenAuth))
		r.Use(jwtauth.Authenticator(tokenAuth))
		r.Use(tenantMiddleware) // ★ JWTからtenant_idをContextに注入
		r.Use(handler.RequireActiveTenant(billingRepo)) // 停止・解約テナントを弾く

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
		r.Get("/api/reports/export",
			handler.RequireAdmin(exportH.MonthlyCSV))

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

		// 連絡先E2E暗号化設定（サーバは復号鍵を持たない）
		r.Get("/api/crypto-settings",         handler.RequireAdmin(cryptoH.Get))
		r.Post("/api/admin/crypto-settings",  handler.RequireAdmin(cryptoH.Create))

		// 職長自動提案（ロック時確認用）
		r.Get("/api/foreman/suggest", handler.RequireAdmin(foremanH.Suggest))

		// 職長によるチーム日報一括入力
		r.Get("/api/foreman/team-reports", foremanH.GetTeamReports)
		r.Put("/api/foreman/team-reports", foremanH.UpsertTeamReports)

		// 出退勤打刻（ATTENDANCE_ENABLED=true の場合のみ）
		if attendanceH != nil {
			r.Get("/api/attendance/today",      attendanceH.GetToday)
			r.Post("/api/attendance/clock-in",  attendanceH.ClockIn)
			r.Post("/api/attendance/clock-out", attendanceH.ClockOut)
		}
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
// schema_migrations テーブルで適用済みファイルを追跡し、再実行を防ぐ。
func runMigrations(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		filename   TEXT     PRIMARY KEY,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	// 追跡テーブル導入前に初期化済みの DB への後方互換対応:
	// attendance_logs が存在すれば 001〜010 は適用済みとみなして登録する。
	var hasAttendance int
	db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='attendance_logs'`).Scan(&hasAttendance)
	if hasAttendance > 0 {
		for _, m := range []string{
			"001_init.sql", "002_add_client_name.sql", "003_add_name_fields.sql",
			"004_add_push_subscriptions.sql", "005_add_foreman.sql", "006_seed_workers.sql",
			"007_seed_foreman_assignments.sql", "008_seed_foreman_priorities.sql",
			"009_add_qr_token.sql", "010_add_attendance.sql",
		} {
			db.Exec(`INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)`, m)
		}
	}

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
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE filename = ?`, name).Scan(&count); err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if count > 0 {
			log.Printf("migration %s: skipped (already applied)", name)
			continue
		}

		data, err := os.ReadFile("./db/migrations/" + name)
		if err != nil {
			return fmt.Errorf("ReadFile %s: %w", name, err)
		}
		applied := true
		if _, err := db.Exec(string(data)); err != nil {
			// 001_init.sql(v2スキーマ)が後続ALTER TABLEの内容を既に含むため、
			// フレッシュDBでは 003 等が duplicate column で失敗する。
			// このケースは適用済み相当とみなして記録のみ行う。
			if !strings.Contains(err.Error(), "duplicate column name") {
				return fmt.Errorf("migration %s: %w", name, err)
			}
			applied = false
		}
		if _, err := db.Exec(`INSERT INTO schema_migrations (filename) VALUES (?)`, name); err != nil {
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if applied {
			log.Printf("migration %s: applied", name)
		} else {
			log.Printf("migration %s: recorded (duplicate column — 001に含まれる)", name)
		}
	}
	return nil
}

// ── リクエストログ ───────────────────────────────────────────────
// chi の middleware.Logger の代替。/qr-login のクエリにはQRトークン(認証情報)が
// 含まれるため、アクセスログに残らないようマスクする。
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()
		next.ServeHTTP(ww, r)
		log.Printf("%s %s %d %dB %s from %s",
			r.Method, maskURI(r.URL), ww.Status(), ww.BytesWritten(), time.Since(start), r.RemoteAddr)
	})
}

// maskURI はログ出力用のリクエストURIを返す。/qr-login のクエリはマスクする。
func maskURI(u *url.URL) string {
	if u.Path == "/qr-login" && u.RawQuery != "" {
		return u.Path + "?token=***"
	}
	return u.RequestURI()
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
