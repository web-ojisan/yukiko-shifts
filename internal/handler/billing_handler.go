package handler

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/yourorg/shift-app/internal/billing"
	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/repository"
)

// BillingHandler — Stripeセルフサーブ申込・契約管理。
// stripe が nil の場合、全エンドポイントは 503 を返す（課金機能無効）。
type BillingHandler struct {
	repo    *repository.BillingRepository
	stripe  *billing.Client
	baseURL string
}

func NewBillingHandler(repo *repository.BillingRepository, stripe *billing.Client, baseURL string) *BillingHandler {
	return &BillingHandler{repo: repo, stripe: stripe, baseURL: baseURL}
}

func (h *BillingHandler) Enabled() bool { return h.stripe != nil }

func (h *BillingHandler) requireEnabled(w http.ResponseWriter) bool {
	if h.stripe == nil {
		writeError(w, http.StatusServiceUnavailable, "オンライン申込は現在準備中です")
		return false
	}
	return true
}

// ─── ランダム生成 ────────────────────────────────────────────

// 紛らわしい文字(0/o/1/l等)を除いたセット
const slugChars = "abcdefghjkmnpqrstuvwxyz23456789"

func randomString(chars string, n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	out := make([]byte, n)
	for i, v := range b {
		out[i] = chars[int(v)%len(chars)]
	}
	return string(out)
}

// ─── POST /api/signup/checkout ───────────────────────────────
// 会社名とプランを受け取り、Stripe Checkout の決済ページURLを返す
func (h *BillingHandler) SignupCheckout(w http.ResponseWriter, r *http.Request) {
	if !h.requireEnabled(w) {
		return
	}
	var req model.SignupCheckoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "リクエスト形式が不正です")
		return
	}
	if req.CompanyName == "" || len(req.CompanyName) > 100 {
		writeError(w, http.StatusBadRequest, "会社名を入力してください（100文字以内）")
		return
	}
	if !billing.ValidPlan(req.Plan) {
		writeError(w, http.StatusBadRequest, "プランは entry / basic / pro のいずれかを指定してください")
		return
	}

	url, err := h.stripe.NewCheckoutSession(req.Plan, req.CompanyName, h.baseURL)
	if err != nil {
		log.Printf("billing: checkout session作成失敗: %v", err)
		writeError(w, http.StatusBadGateway, "決済ページの作成に失敗しました。時間をおいて再度お試しください")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// ─── POST /api/stripe/webhook ────────────────────────────────
func (h *BillingHandler) Webhook(w http.ResponseWriter, r *http.Request) {
	if h.stripe == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	ev, err := h.stripe.VerifyAndParse(payload, r.Header.Get("Stripe-Signature"), time.Now())
	if err != nil {
		log.Printf("billing: webhook署名検証失敗: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	switch ev.Type {
	case "checkout.session.completed":
		h.handleCheckoutCompleted(w, r, ev)
	case "customer.subscription.updated":
		status := "active"
		switch ev.Data.Object.Status {
		case "past_due", "unpaid", "paused":
			status = "suspended"
		case "canceled":
			status = "cancelled"
		}
		if err := h.repo.SetStatusBySubscription(r.Context(), ev.Data.Object.ID, status); err != nil {
			log.Printf("billing: 契約状態更新失敗 sub=%s: %v", ev.Data.Object.ID, err)
		} else {
			log.Printf("billing: 契約状態更新 sub=%s → %s", ev.Data.Object.ID, status)
		}
		// ポータルでのプラン変更を追随（Price IDからプランを逆引き）
		if plan := h.stripe.PlanForPrice(ev.PriceID()); plan != "" {
			if err := h.repo.UpdatePlanBySubscription(r.Context(),
				ev.Data.Object.ID, plan, billing.PlanMaxWorkers[plan]); err != nil {
				log.Printf("billing: プラン変更反映失敗 sub=%s: %v", ev.Data.Object.ID, err)
			} else {
				log.Printf("billing: プラン変更 sub=%s → %s", ev.Data.Object.ID, plan)
			}
		}
		w.WriteHeader(http.StatusOK)
	case "customer.subscription.deleted":
		if err := h.repo.SetStatusBySubscription(r.Context(), ev.Data.Object.ID, "cancelled"); err != nil {
			log.Printf("billing: 解約処理失敗 sub=%s: %v", ev.Data.Object.ID, err)
		} else {
			log.Printf("billing: 解約 sub=%s", ev.Data.Object.ID)
		}
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusOK) // 関知しないイベントは受領のみ
	}
}

func (h *BillingHandler) handleCheckoutCompleted(w http.ResponseWriter, r *http.Request, ev *billing.Event) {
	obj := ev.Data.Object

	// 冪等性: 同一セッションのWebhook再送はスキップ
	if existing, _ := h.repo.GetProvision(r.Context(), obj.ID); existing != nil {
		w.WriteHeader(http.StatusOK)
		return
	}

	companyName := obj.Metadata["company_name"]
	plan := obj.Metadata["plan"]
	if companyName == "" || (plan != "basic" && plan != "pro") {
		log.Printf("billing: metadataが不正 session=%s", obj.ID)
		w.WriteHeader(http.StatusOK) // 再送されても直らないため受領して手動対応
		return
	}

	// 会社コード(slug)生成: 重複しない6文字
	var slug string
	for i := 0; i < 10; i++ {
		slug = randomString(slugChars, 6)
		exists, err := h.repo.SlugExists(r.Context(), slug)
		if err != nil {
			log.Printf("billing: slug確認失敗: %v", err)
			w.WriteHeader(http.StatusInternalServerError) // Stripeが再送してくれる
			return
		}
		if !exists {
			break
		}
	}

	initialPassword := randomString(slugChars+"ABCDEFGHJKMNPQRSTUVWXYZ", 12)
	hash, err := bcrypt.GenerateFromPassword([]byte(initialPassword), bcrypt.DefaultCost)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	tenantID, err := h.repo.ProvisionTenant(r.Context(),
		companyName, slug, plan, billing.PlanMaxWorkers[plan],
		obj.Customer, obj.Subscription, "admin", string(hash))
	if err != nil {
		log.Printf("billing: テナント作成失敗 session=%s: %v", obj.ID, err)
		w.WriteHeader(http.StatusInternalServerError) // Stripeが再送してくれる
		return
	}
	if err := h.repo.CreateProvision(r.Context(), obj.ID, tenantID, slug, "admin", initialPassword); err != nil {
		log.Printf("billing: provision記録失敗 session=%s: %v", obj.ID, err)
	}
	log.Printf("billing: テナント作成完了 %q (id=%d, slug=%s, plan=%s)", companyName, tenantID, slug, plan)
	w.WriteHeader(http.StatusOK)
}

// ─── GET /api/signup/complete?session_id= ────────────────────
// 申込完了画面が認証情報を取得する。初期パスワードは一度返したら破棄する。
// Webhook到着前は ready: false を返し、フロント側でポーリングする。
func (h *BillingHandler) SignupComplete(w http.ResponseWriter, r *http.Request) {
	if !h.requireEnabled(w) {
		return
	}
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "session_id が必要です")
		return
	}
	p, err := h.repo.GetProvision(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "取得に失敗しました")
		return
	}
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ready": false})
		return
	}
	resp := map[string]any{
		"ready":        true,
		"company_code": p.TenantSlug,
		"employee_id":  p.AdminEmployeeID,
	}
	if p.InitialPassword != nil {
		resp["initial_password"] = *p.InitialPassword
		_ = h.repo.ConsumeProvisionPassword(r.Context(), sessionID)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ─── POST /api/admin/billing/portal ──────────────────────────
// 経理向けStripeポータル(カード変更・解約・領収書)のURLを返す
func (h *BillingHandler) Portal(w http.ResponseWriter, r *http.Request) {
	if !h.requireEnabled(w) {
		return
	}
	customerID, err := h.repo.GetStripeCustomerID(r.Context(), currentTenantID(r))
	if err != nil || customerID == "" {
		writeError(w, http.StatusNotFound, "オンライン契約が見つかりません（請求書契約のお客様はお問い合わせください）")
		return
	}
	url, err := h.stripe.NewPortalSession(customerID, h.baseURL)
	if err != nil {
		log.Printf("billing: ポータル作成失敗: %v", err)
		writeError(w, http.StatusBadGateway, "ポータルの作成に失敗しました")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// ─── 契約状態チェックミドルウェア ─────────────────────────────
// suspended / cancelled のテナントはAPIを利用できない。
// ただし契約ポータル(支払い方法の修正)へのアクセスだけは許可する。
func RequireActiveTenant(repo *repository.BillingRepository) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			status, err := repo.GetTenantStatus(r.Context(), currentTenantID(r))
			if err == nil && (status == "suspended" || status == "cancelled") {
				writeError(w, http.StatusPaymentRequired,
					"ご契約が停止されています。管理者は「契約・お支払い」からお支払い状況をご確認ください")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
