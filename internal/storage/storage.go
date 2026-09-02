// Package storage は写真アップロードの抽象レイヤー。
// R2_ACCOUNT_ID 等が設定されていれば Cloudflare R2、未設定なら
// ローカルファイルシステムに保存して /photos/ で配信する。
package storage

import (
	"context"
	"fmt"
	"os"
)

type PhotoStorage interface {
	Upload(ctx context.Context, key string, data []byte) (publicURL string, err error)
}

// New は環境変数を見て適切な実装を返す。
func New(dataDir string) PhotoStorage {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKey := os.Getenv("R2_ACCESS_KEY")
	secretKey := os.Getenv("R2_SECRET_KEY")
	bucket    := os.Getenv("R2_BUCKET")
	publicURL := os.Getenv("R2_PUBLIC_URL")

	if accountID != "" && accessKey != "" && secretKey != "" && bucket != "" && publicURL != "" {
		return &r2Storage{
			accountID: accountID,
			accessKey: accessKey,
			secretKey: secretKey,
			bucket:    bucket,
			publicURL: publicURL,
		}
	}

	photoDir := dataDir + "/photos"
	if err := os.MkdirAll(photoDir, 0o755); err != nil {
		panic(fmt.Sprintf("storage: cannot create photo dir: %v", err))
	}
	return &localStorage{dir: photoDir}
}

// NewR2IfConfigured はR2の設定が揃っている場合のみR2ストレージを返す。
// 未設定なら nil（バックアップのオフサイト転送などの任意用途向け）。
func NewR2IfConfigured() PhotoStorage {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKey := os.Getenv("R2_ACCESS_KEY")
	secretKey := os.Getenv("R2_SECRET_KEY")
	bucket    := os.Getenv("R2_BUCKET")

	if accountID == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil
	}
	return &r2Storage{
		accountID: accountID,
		accessKey: accessKey,
		secretKey: secretKey,
		bucket:    bucket,
		publicURL: os.Getenv("R2_PUBLIC_URL"),
	}
}
