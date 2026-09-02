package handler_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/jwtauth/v5"
	"github.com/jmoiron/sqlx"

	"github.com/yourorg/shift-app/internal/billing"
	"github.com/yourorg/shift-app/internal/handler"
	"github.com/yourorg/shift-app/internal/repository"
	"github.com/yourorg/shift-app/internal/testutil"
)

const testWebhookSecret = "whsec_handler_test"

func newBillingDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db := testutil.NewDB(t)
	if _, err := db.Exec(`
		ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
		ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;
		CREATE TABLE signup_provisions (
			checkout_session_id TEXT PRIMARY KEY,
			tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
			tenant_slug         TEXT    NOT NULL,
			admin_employee_id   TEXT    NOT NULL,
			initial_password    TEXT,
			created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`); err != nil {
		t.Fatalf("billing schema: %v", err)
	}
	return db
}

func newBillingHandler(t *testing.T) (*handler.BillingHandler, *repository.BillingRepository, *sqlx.DB) {
	t.Helper()
	db := newBillingDB(t)
	repo := repo(db)
	stripe := billing.New("sk_test_x", testWebhookSecret, "price_entry", "price_basic", "price_pro")
	return handler.NewBillingHandler(repo, stripe, "http://localhost:8989"), repo, db
}

func repo(db *sqlx.DB) *repository.BillingRepository { return repository.NewBillingRepository(db) }

func signPayload(payload []byte, ts int64) string {
	mac := hmac.New(sha256.New, []byte(testWebhookSecret))
	fmt.Fprintf(mac, "%d.%s", ts, payload)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func postWebhook(t *testing.T, h *handler.BillingHandler, payload string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/stripe/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", signPayload([]byte(payload), time.Now().Unix()))
	rec := httptest.NewRecorder()
	h.Webhook(rec, req)
	return rec
}

const checkoutCompleted = `{
	"type": "checkout.session.completed",
	"data": {"object": {
		"id": "cs_test_1",
		"customer": "cus_1",
		"subscription": "sub_1",
		"metadata": {"company_name": "テスト建設株式会社", "plan": "basic"}
	}}
}`

func TestWebhook_CheckoutCompleted_ProvisionsTenant(t *testing.T) {
	h, r, db := newBillingHandler(t)

	rec := postWebhook(t, h, checkoutCompleted)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook status: got %d", rec.Code)
	}

	// テナントが作成されている
	var tenant struct {
		ID         int64  `db:"id"`
		Name       string `db:"name"`
		Slug       string `db:"slug"`
		Plan       string `db:"plan"`
		MaxWorkers int    `db:"max_workers"`
		Status     string `db:"status"`
	}
	if err := db.Get(&tenant, `SELECT id, name, slug, plan, max_workers, status FROM tenants WHERE stripe_subscription_id = 'sub_1'`); err != nil {
		t.Fatalf("tenant not created: %v", err)
	}
	if tenant.Name != "テスト建設株式会社" || tenant.Plan != "basic" || tenant.MaxWorkers != 50 || tenant.Status != "active" {
		t.Errorf("tenant fields: %+v", tenant)
	}
	if len(tenant.Slug) != 6 {
		t.Errorf("slug length: got %q", tenant.Slug)
	}

	// 管理者ユーザーが作成されている
	var adminCount int
	db.Get(&adminCount, `SELECT COUNT(*) FROM users WHERE tenant_id = ? AND employee_id = 'admin' AND role = 'admin'`, tenant.ID)
	if adminCount != 1 {
		t.Errorf("admin user count: got %d", adminCount)
	}

	// provision が記録されている
	p, err := r.GetProvision(t.Context(), "cs_test_1")
	if err != nil || p == nil {
		t.Fatalf("provision not found: %v", err)
	}
	if p.InitialPassword == nil || len(*p.InitialPassword) != 12 {
		t.Errorf("initial password: %+v", p.InitialPassword)
	}
}

func TestWebhook_CheckoutCompleted_Idempotent(t *testing.T) {
	h, _, db := newBillingHandler(t)

	postWebhook(t, h, checkoutCompleted)
	postWebhook(t, h, checkoutCompleted) // Stripeの再送を想定

	var n int
	db.Get(&n, `SELECT COUNT(*) FROM tenants WHERE stripe_subscription_id = 'sub_1'`)
	if n != 1 {
		t.Errorf("再送でテナントが重複作成された: %d", n)
	}
}

func TestWebhook_InvalidSignature_Rejected(t *testing.T) {
	h, _, db := newBillingHandler(t)

	req := httptest.NewRequest("POST", "/api/stripe/webhook", strings.NewReader(checkoutCompleted))
	req.Header.Set("Stripe-Signature", "t=1,v1=deadbeef")
	rec := httptest.NewRecorder()
	h.Webhook(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("不正署名のstatus: got %d, want 400", rec.Code)
	}
	var n int
	db.Get(&n, `SELECT COUNT(*) FROM tenants WHERE stripe_subscription_id IS NOT NULL`)
	if n != 0 {
		t.Errorf("不正署名でテナントが作成された")
	}
}

func TestWebhook_SubscriptionDeleted_CancelsTenant(t *testing.T) {
	h, r, _ := newBillingHandler(t)
	postWebhook(t, h, checkoutCompleted)

	postWebhook(t, h, `{
		"type": "customer.subscription.deleted",
		"data": {"object": {"id": "sub_1"}}
	}`)

	p, _ := r.GetProvision(t.Context(), "cs_test_1")
	status, err := r.GetTenantStatus(t.Context(), p.TenantID)
	if err != nil || status != "cancelled" {
		t.Errorf("status: got %q (%v), want cancelled", status, err)
	}
}

func TestSignupComplete_DeliversPasswordOnce(t *testing.T) {
	h, _, _ := newBillingHandler(t)
	postWebhook(t, h, checkoutCompleted)

	get := func() map[string]any {
		req := httptest.NewRequest("GET", "/api/signup/complete?session_id=cs_test_1", nil)
		rec := httptest.NewRecorder()
		h.SignupComplete(rec, req)
		var resp map[string]any
		json.NewDecoder(rec.Body).Decode(&resp)
		return resp
	}

	first := get()
	if first["ready"] != true || first["initial_password"] == nil || first["company_code"] == "" {
		t.Fatalf("初回取得: %v", first)
	}
	second := get()
	if second["initial_password"] != nil {
		t.Errorf("初期パスワードが2回目も返された")
	}
	if second["company_code"] != first["company_code"] {
		t.Errorf("会社コードは再取得できるべき")
	}
}

func TestSignupComplete_UnknownSession_NotReady(t *testing.T) {
	h, _, _ := newBillingHandler(t)
	req := httptest.NewRequest("GET", "/api/signup/complete?session_id=cs_unknown", nil)
	rec := httptest.NewRecorder()
	h.SignupComplete(rec, req)
	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["ready"] != false {
		t.Errorf("未知セッション: %v", resp)
	}
}

func TestRequireActiveTenant_BlocksSuspended(t *testing.T) {
	db := newBillingDB(t)
	r := repo(db)

	// テナント2つ: active と suspended (id=1 は testutil のシードと衝突するため避ける)
	db.MustExec(`INSERT INTO tenants (id, name, slug, status) VALUES (11, 'A社', 'aaa', 'active'), (12, 'B社', 'bbb', 'suspended')`)

	tokenAuth := jwtauth.New("HS256", []byte(testJWTSecret), nil)
	rt := chi.NewRouter()
	rt.Group(func(g chi.Router) {
		g.Use(jwtauth.Verifier(tokenAuth))
		g.Use(jwtauth.Authenticator(tokenAuth))
		g.Use(handler.RequireActiveTenant(r))
		g.Get("/api/x", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	})

	for _, tc := range []struct {
		tenantID int64
		want     int
	}{
		{11, http.StatusOK},
		{12, http.StatusPaymentRequired},
	} {
		req := httptest.NewRequest("GET", "/api/x", nil)
		req.Header.Set("Authorization", bearerToken(t, tokenAuth,
			map[string]any{"tenant_id": float64(tc.tenantID), "user_id": float64(1), "role": "admin"}))
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("tenant %d: got %d, want %d", tc.tenantID, rec.Code, tc.want)
		}
	}
}
