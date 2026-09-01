// Package billing — Stripe連携の薄いクライアント。
// SDKは使わず、必要な3エンドポイント(Checkout / Customer Portal / Webhook検証)のみ実装する。
// カード情報・請求先情報はStripe側にのみ存在し、本アプリは各種IDの参照だけを持つ。
package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const apiBase = "https://api.stripe.com/v1"

// Plan ごとの上限人数
var PlanMaxWorkers = map[string]int{
	"basic": 15,
	"pro":   50,
}

type Client struct {
	secretKey     string
	webhookSecret string
	priceBasic    string // StripeのPrice ID (basic月額)
	pricePro      string // StripeのPrice ID (pro月額)
	httpClient    *http.Client
}

// New は設定が揃っていれば Client を返す。揃っていなければ nil (課金機能無効)。
func New(secretKey, webhookSecret, priceBasic, pricePro string) *Client {
	if secretKey == "" || webhookSecret == "" || priceBasic == "" || pricePro == "" {
		return nil
	}
	return &Client{
		secretKey:     secretKey,
		webhookSecret: webhookSecret,
		priceBasic:    priceBasic,
		pricePro:      pricePro,
		httpClient:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) PriceIDFor(plan string) string {
	if plan == "pro" {
		return c.pricePro
	}
	return c.priceBasic
}

// post はStripe APIへフォームエンコードでPOSTし、JSONレスポンスをdstへデコードする
func (c *Client) post(path string, form url.Values, dst any) error {
	req, err := http.NewRequest("POST", apiBase+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		return fmt.Errorf("stripe %s: %d %s", path, resp.StatusCode, e.Error.Message)
	}
	return json.Unmarshal(body, dst)
}

// ─── Checkout ────────────────────────────────────────────────

// NewCheckoutSession はサブスク契約用のCheckoutセッションを作成し、決済ページURLを返す。
// 会社名とプランは metadata に載せ、Webhook(checkout.session.completed)で受け取る。
func (c *Client) NewCheckoutSession(plan, companyName, baseURL string) (string, error) {
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("line_items[0][price]", c.PriceIDFor(plan))
	form.Set("line_items[0][quantity]", "1")
	form.Set("success_url", baseURL+"/signup/complete?session_id={CHECKOUT_SESSION_ID}")
	form.Set("cancel_url", baseURL+"/signup")
	form.Set("metadata[company_name]", companyName)
	form.Set("metadata[plan]", plan)
	form.Set("locale", "ja")

	var res struct {
		URL string `json:"url"`
	}
	if err := c.post("/checkout/sessions", form, &res); err != nil {
		return "", err
	}
	return res.URL, nil
}

// ─── Customer Portal ─────────────────────────────────────────

// NewPortalSession は経理向けポータル(カード変更・解約・領収書)のURLを返す
func (c *Client) NewPortalSession(customerID, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)

	var res struct {
		URL string `json:"url"`
	}
	if err := c.post("/billing_portal/sessions", form, &res); err != nil {
		return "", err
	}
	return res.URL, nil
}

// ─── Webhook ─────────────────────────────────────────────────

// Event はWebhookペイロードのうち本アプリが使う部分だけを表す
type Event struct {
	Type string `json:"type"`
	Data struct {
		Object struct {
			ID           string            `json:"id"`
			Customer     string            `json:"customer"`
			Subscription string            `json:"subscription"`
			Status       string            `json:"status"`
			Metadata     map[string]string `json:"metadata"`
		} `json:"object"`
	} `json:"data"`
}

// VerifyAndParse はStripe-Signatureヘッダーを検証し、正当ならイベントを返す。
// 署名方式: HMAC-SHA256(secret, "<timestamp>.<payload>") との定数時間比較。
func (c *Client) VerifyAndParse(payload []byte, sigHeader string, now time.Time) (*Event, error) {
	return verifyAndParse(payload, sigHeader, c.webhookSecret, now)
}

func verifyAndParse(payload []byte, sigHeader, secret string, now time.Time) (*Event, error) {
	var ts int64
	var sigs []string
	for _, part := range strings.Split(sigHeader, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts, _ = strconv.ParseInt(kv[1], 10, 64)
		case "v1":
			sigs = append(sigs, kv[1])
		}
	}
	if ts == 0 || len(sigs) == 0 {
		return nil, fmt.Errorf("署名ヘッダーの形式が不正です")
	}
	// リプレイ防止: タイムスタンプ許容 5 分
	if diff := now.Unix() - ts; diff > 300 || diff < -300 {
		return nil, fmt.Errorf("署名タイムスタンプが許容範囲外です")
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(payload)
	expected := hex.EncodeToString(mac.Sum(nil))

	ok := false
	for _, s := range sigs {
		if hmac.Equal([]byte(expected), []byte(s)) {
			ok = true
			break
		}
	}
	if !ok {
		return nil, fmt.Errorf("署名が一致しません")
	}

	var ev Event
	if err := json.Unmarshal(payload, &ev); err != nil {
		return nil, fmt.Errorf("ペイロードの解析に失敗: %w", err)
	}
	return &ev, nil
}
