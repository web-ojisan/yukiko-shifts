package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/jwtauth/v5"

	"github.com/yourorg/shift-app/internal/handler"
	"github.com/yourorg/shift-app/internal/repository"
	"github.com/yourorg/shift-app/internal/testutil"
)

// ─── テスト用ルーター ─────────────────────────────────────────

func buildQRRouter(authH *handler.AuthHandler, shiftH *handler.ShiftHandler, ta *jwtauth.JWTAuth) http.Handler {
	r := chi.NewRouter()

	// 認証不要
	r.Get("/qr-login", authH.QRLogin)

	// 認証必要
	r.Group(func(r chi.Router) {
		r.Use(jwtauth.Verifier(ta))
		r.Use(jwtauth.Authenticator(ta))
		r.Get("/api/admin/workers/qr-tokens",
			handler.RequireAdmin(shiftH.GetWorkerQRTokens))
		r.Post("/api/admin/workers/{id}/regenerate-qr",
			handler.RequireAdmin(shiftH.RegenerateQR))
	})

	return r
}

// ─── QRLogin ─────────────────────────────────────────────────

func TestQRLogin_ValidToken_Returns200HTML(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)
	ctx      := context.Background()

	// worker(id=2) に既知のQRトークンをセット
	const qrToken = "valid-qr-token-xyz"
	if err := userRepo.UpdateQRToken(ctx, 2, qrToken); err != nil {
		t.Fatalf("UpdateQRToken: %v", err)
	}

	req := httptest.NewRequest("GET", "/qr-login?token="+qrToken, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}

	body := rec.Body.String()

	// HTML レスポンスであること
	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type: got %q, want text/html", ct)
	}

	// localStorage.setItem が含まれること
	if !strings.Contains(body, "localStorage.setItem") {
		t.Error("レスポンスに localStorage.setItem が含まれていない")
	}

	// shift_user は JSON.stringify で文字列化されていること
	if !strings.Contains(body, "JSON.stringify(") {
		t.Error("shift_user が JSON.stringify で囲まれていない（[object Object]バグの可能性）")
	}

	// 正規のリダイレクト先が含まれること
	if !strings.Contains(body, "window.location.replace") {
		t.Error("レスポンスに window.location.replace が含まれていない")
	}

	// shift_token キーが含まれること
	if !strings.Contains(body, "shift_token") {
		t.Error("レスポンスに shift_token が含まれていない")
	}
}

func TestQRLogin_InvalidToken_Returns401(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)

	req := httptest.NewRequest("GET", "/qr-login?token=nonexistent-token", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d, want 401", rec.Code)
	}
}

func TestQRLogin_MissingToken_Returns400(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)

	req := httptest.NewRequest("GET", "/qr-login", nil) // token パラメータなし
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
}

// ─── RegenerateQR ────────────────────────────────────────────

func TestRegenerateQR_Admin_Returns200WithNewToken(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)
	ctx      := context.Background()

	// 初期トークンをセット
	const oldToken = "old-qr-token"
	if err := userRepo.UpdateQRToken(ctx, 2, oldToken); err != nil {
		t.Fatalf("UpdateQRToken: %v", err)
	}

	req := httptest.NewRequest("POST", "/api/admin/workers/2/regenerate-qr", nil)
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	// レスポンスに新しい qr_token が含まれること
	var resp map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	newToken := resp["qr_token"]
	if newToken == "" {
		t.Fatal("レスポンスに qr_token が含まれていない")
	}
	if newToken == oldToken {
		t.Error("再発行後もトークンが変わっていない")
	}

	// DB 上でも更新されていること
	u, _ := userRepo.FindByQRToken(ctx, newToken)
	if u == nil || u.ID != 2 {
		t.Error("新しいトークンで DB 検索できない")
	}

	// 古いトークンは無効になっていること
	old, _ := userRepo.FindByQRToken(ctx, oldToken)
	if old != nil {
		t.Error("古いトークンがまだ有効")
	}
}

func TestRegenerateQR_Worker_Returns403(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)

	req := httptest.NewRequest("POST", "/api/admin/workers/2/regenerate-qr", nil)
	req.Header.Set("Authorization", bearerToken(t, ta, workerClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status: got %d, want 403", rec.Code)
	}
}

// ─── GetWorkerQRTokens ───────────────────────────────────────

func TestGetWorkerQRTokens_ReturnsAllWorkers(t *testing.T) {
	db       := testutil.NewDB(t)
	userRepo := repository.NewUserRepository(db)
	ta       := jwtauth.New("HS256", []byte("test-secret"), nil)
	authH    := handler.NewAuthHandler(userRepo, ta)
	shiftH   := handler.NewShiftHandler(nil, userRepo, nil, nil, nil)
	router   := buildQRRouter(authH, shiftH, ta)
	ctx      := context.Background()

	// 2人の作業者にトークンをセット
	_ = userRepo.UpdateQRToken(ctx, 2, "token-w001")
	_ = userRepo.UpdateQRToken(ctx, 3, "token-w002")

	req := httptest.NewRequest("GET", "/api/admin/workers/qr-tokens", nil)
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}

	var rows []map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&rows); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	// 各行に必要なキーが含まれること
	for _, row := range rows {
		if row["id"] == nil {
			t.Error("id が含まれていない")
		}
		if row["name"] == nil {
			t.Error("name が含まれていない")
		}
		if row["employee_id"] == nil {
			t.Error("employee_id が含まれていない")
		}
		if row["qr_token"] == nil {
			t.Error("qr_token が含まれていない")
		}
	}
}
