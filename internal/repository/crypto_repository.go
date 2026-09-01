package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jmoiron/sqlx"

	"github.com/yourorg/shift-app/internal/model"
)

// CryptoRepository は連絡先E2E暗号化のテナント別設定を扱う
type CryptoRepository struct {
	db *sqlx.DB
}

func NewCryptoRepository(db *sqlx.DB) *CryptoRepository {
	return &CryptoRepository{db: db}
}

// Get はテナントの暗号化設定を返す。未設定なら (nil, nil)。
func (r *CryptoRepository) Get(ctx context.Context, tenantID int64) (*model.TenantCryptoSettings, error) {
	var s model.TenantCryptoSettings
	err := r.db.GetContext(ctx, &s,
		`SELECT * FROM tenant_crypto_settings WHERE tenant_id = ?`, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// Create は暗号化設定を新規登録する。既に存在する場合はエラー（上書きは既存暗号文を孤立させるため不可）。
func (r *CryptoRepository) Create(ctx context.Context, tenantID int64, kdfSalt, verifier string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO tenant_crypto_settings (tenant_id, kdf_salt, verifier) VALUES (?, ?, ?)`,
		tenantID, kdfSalt, verifier)
	return err
}
