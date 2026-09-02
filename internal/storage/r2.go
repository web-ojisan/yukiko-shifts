package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// r2Storage は Cloudflare R2 に PUTする。
// aws-sdk-go-v2 を避け、AWS SigV4 を直接実装することで依存を最小化する。
type r2Storage struct {
	accountID string
	accessKey string
	secretKey string
	bucket    string
	publicURL string // 例: https://pub-xxxx.r2.dev
}

func (s *r2Storage) Upload(ctx context.Context, key string, data []byte) (string, error) {
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
		s.accountID, s.bucket, key)

	now := time.Now().UTC()
	dateStamp := now.Format("20060102")
	amzDate   := now.Format("20060102T150405Z")

	payloadHash := sha256hex(data)

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	contentType := contentTypeFor(key)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", amzDate)

	// ── SigV4 署名 ─────────────────────────────────────────
	region := "auto"
	service := "s3"

	canonicalHeaders := fmt.Sprintf(
		"content-type:%s\nhost:%s.r2.cloudflarestorage.com\nx-amz-content-sha256:%s\nx-amz-date:%s\n",
		contentType, s.accountID, payloadHash, amzDate,
	)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"

	canonicalRequest := fmt.Sprintf("PUT\n/%s/%s\n\n%s\n%s\n%s",
		s.bucket, key, canonicalHeaders, signedHeaders, payloadHash)

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s",
		amzDate, credentialScope, sha256hex([]byte(canonicalRequest)))

	signingKey := deriveSigningKey(s.secretKey, dateStamp, region, service)
	signature  := hmacHex(signingKey, stringToSign)

	authHeader := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.accessKey, credentialScope, signedHeaders, signature,
	)
	req.Header.Set("Authorization", authHeader)
	// ────────────────────────────────────────────────────────

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("r2 upload: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("r2 upload: status %d", resp.StatusCode)
	}

	return s.publicURL + "/" + key, nil
}

func sha256hex(data []byte) string {
	h := sha256.Sum256(data)
	return fmt.Sprintf("%x", h)
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func hmacHex(key []byte, data string) string {
	return fmt.Sprintf("%x", hmacSHA256(key, data))
}

func deriveSigningKey(secret, date, region, service string) []byte {
	kDate    := hmacSHA256([]byte("AWS4"+secret), date)
	kRegion  := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	return hmacSHA256(kService, "aws4_request")
}

// contentTypeFor はキーの拡張子からContent-Typeを決める
func contentTypeFor(key string) string {
	switch {
	case strings.HasSuffix(key, ".gz"):
		return "application/gzip"
	case strings.HasSuffix(key, ".db"):
		return "application/octet-stream"
	default:
		return "image/jpeg"
	}
}
