package handler_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/jwtauth/v5"

	"github.com/yourorg/shift-app/internal/handler"
	"github.com/yourorg/shift-app/internal/repository"
	"github.com/yourorg/shift-app/internal/testutil"
)

// buildCryptoRouter は認証ミドルウェア込みのルーターを構築する
func buildCryptoRouter(h *handler.CryptoHandler) (http.Handler, *jwtauth.JWTAuth) {
	tokenAuth := jwtauth.New("HS256", []byte(testJWTSecret), nil)
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(jwtauth.Verifier(tokenAuth))
		r.Use(jwtauth.Authenticator(tokenAuth))
		r.Get("/api/crypto-settings", handler.RequireAdmin(h.Get))
		r.Post("/api/admin/crypto-settings", handler.RequireAdmin(h.Create))
	})
	return r, tokenAuth
}

func newCryptoHandler(t *testing.T) *handler.CryptoHandler {
	t.Helper()
	db := testutil.NewDB(t)
	if _, err := db.Exec(`
		CREATE TABLE tenant_crypto_settings (
			tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id),
			kdf_salt   TEXT NOT NULL,
			verifier   TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	return handler.NewCryptoHandler(repository.NewCryptoRepository(db))
}

func TestCryptoSettings_GetBeforeSetup_ReturnsDisabled(t *testing.T) {
	router, ta := buildCryptoRouter(newCryptoHandler(t))

	req := httptest.NewRequest("GET", "/api/crypto-settings", nil)
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["enabled"] != false {
		t.Errorf("enabled: got %v, want false", resp["enabled"])
	}
}

func TestCryptoSettings_CreateThenGet(t *testing.T) {
	router, ta := buildCryptoRouter(newCryptoHandler(t))

	body := `{"kdf_salt":"c2FsdA==","verifier":"enc.v1.aXY=.Y3Q="}`
	req := httptest.NewRequest("POST", "/api/admin/crypto-settings", bytes.NewBufferString(body))
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status: got %d, want 201 (body: %s)", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest("GET", "/api/crypto-settings", nil)
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status: got %d, want 200", rec.Code)
	}
	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["enabled"] != true {
		t.Errorf("enabled: got %v, want true", resp["enabled"])
	}
	if resp["kdf_salt"] != "c2FsdA==" {
		t.Errorf("kdf_salt: got %v", resp["kdf_salt"])
	}
	if resp["verifier"] != "enc.v1.aXY=.Y3Q=" {
		t.Errorf("verifier: got %v", resp["verifier"])
	}
}

func TestCryptoSettings_CreateTwice_Conflict(t *testing.T) {
	router, ta := buildCryptoRouter(newCryptoHandler(t))

	body := `{"kdf_salt":"c2FsdA==","verifier":"enc.v1.aXY=.Y3Q="}`
	for i, want := range []int{http.StatusCreated, http.StatusConflict} {
		req := httptest.NewRequest("POST", "/api/admin/crypto-settings", bytes.NewBufferString(body))
		req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("attempt %d: got %d, want %d", i+1, rec.Code, want)
		}
	}
}

func TestCryptoSettings_MissingFields_BadRequest(t *testing.T) {
	router, ta := buildCryptoRouter(newCryptoHandler(t))

	req := httptest.NewRequest("POST", "/api/admin/crypto-settings", bytes.NewBufferString(`{"kdf_salt":""}`))
	req.Header.Set("Authorization", bearerToken(t, ta, adminClaims()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
}

func TestCryptoSettings_WorkerForbidden(t *testing.T) {
	router, ta := buildCryptoRouter(newCryptoHandler(t))

	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/crypto-settings", ""},
		{"POST", "/api/admin/crypto-settings", `{"kdf_salt":"a","verifier":"b"}`},
	} {
		req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		req.Header.Set("Authorization", bearerToken(t, ta, workerClaims()))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}
