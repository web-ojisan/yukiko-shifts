package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

const testSecret = "whsec_test_secret"

func sign(payload []byte, ts int64, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyAndParse_ValidSignature(t *testing.T) {
	payload := []byte(`{"type":"checkout.session.completed","data":{"object":{"id":"cs_123","customer":"cus_1","subscription":"sub_1","metadata":{"company_name":"テスト建設","plan":"basic"}}}}`)
	now := time.Now()
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sign(payload, now.Unix(), testSecret))

	ev, err := verifyAndParse(payload, header, testSecret, now)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if ev.Type != "checkout.session.completed" {
		t.Errorf("type: got %s", ev.Type)
	}
	if ev.Data.Object.Metadata["company_name"] != "テスト建設" {
		t.Errorf("metadata: got %v", ev.Data.Object.Metadata)
	}
	if ev.Data.Object.Subscription != "sub_1" {
		t.Errorf("subscription: got %s", ev.Data.Object.Subscription)
	}
}

func TestVerifyAndParse_WrongSignature(t *testing.T) {
	payload := []byte(`{"type":"x"}`)
	now := time.Now()
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sign(payload, now.Unix(), "wrong-secret"))

	if _, err := verifyAndParse(payload, header, testSecret, now); err == nil {
		t.Fatal("不正な署名が受理された")
	}
}

func TestVerifyAndParse_TamperedPayload(t *testing.T) {
	payload := []byte(`{"type":"x"}`)
	now := time.Now()
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sign(payload, now.Unix(), testSecret))

	tampered := []byte(`{"type":"y"}`)
	if _, err := verifyAndParse(tampered, header, testSecret, now); err == nil {
		t.Fatal("改ざんされたペイロードが受理された")
	}
}

func TestVerifyAndParse_ExpiredTimestamp(t *testing.T) {
	payload := []byte(`{"type":"x"}`)
	old := time.Now().Add(-10 * time.Minute)
	header := fmt.Sprintf("t=%d,v1=%s", old.Unix(), sign(payload, old.Unix(), testSecret))

	if _, err := verifyAndParse(payload, header, testSecret, time.Now()); err == nil {
		t.Fatal("期限切れタイムスタンプが受理された")
	}
}

func TestVerifyAndParse_MalformedHeader(t *testing.T) {
	for _, h := range []string{"", "garbage", "t=abc,v1=", "v1=deadbeef"} {
		if _, err := verifyAndParse([]byte(`{}`), h, testSecret, time.Now()); err == nil {
			t.Fatalf("不正ヘッダー %q が受理された", h)
		}
	}
}

func TestNew_DisabledWhenUnconfigured(t *testing.T) {
	if New("", "", "", "", "") != nil {
		t.Fatal("未設定でもClientが返った")
	}
	if New("sk", "whsec", "price_e", "price_b", "price_p") == nil {
		t.Fatal("設定済みなのにnil")
	}
}
