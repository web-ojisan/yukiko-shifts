package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jmoiron/sqlx"

	"github.com/yourorg/shift-app/internal/model"
)

// BillingRepository はセルフサーブ申込・契約状態まわりのDB操作を扱う
type BillingRepository struct {
	db *sqlx.DB
}

func NewBillingRepository(db *sqlx.DB) *BillingRepository {
	return &BillingRepository{db: db}
}

// SlugExists はテナントslug(会社コード)の存在確認
func (r *BillingRepository) SlugExists(ctx context.Context, slug string) (bool, error) {
	var n int
	err := r.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM tenants WHERE slug = ?`, slug)
	return n > 0, err
}

// ProvisionTenant はテナントと管理者ユーザーをトランザクションで作成する
func (r *BillingRepository) ProvisionTenant(ctx context.Context,
	name, slug, plan string, maxWorkers int,
	stripeCustomerID, stripeSubscriptionID,
	adminEmployeeID, adminPasswordHash string) (int64, error) {

	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `
		INSERT INTO tenants (name, slug, plan, max_workers, status, contract_start,
		                     stripe_customer_id, stripe_subscription_id)
		VALUES (?, ?, ?, ?, 'active', DATE('now'), ?, ?)`,
		name, slug, plan, maxWorkers, stripeCustomerID, stripeSubscriptionID)
	if err != nil {
		return 0, err
	}
	tenantID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (tenant_id, employee_id, password_hash, name, last_name, first_name, role, status)
		VALUES (?, ?, ?, '管理者', '管理', '者', 'admin', 'active')`,
		tenantID, adminEmployeeID, adminPasswordHash); err != nil {
		return 0, err
	}

	return tenantID, tx.Commit()
}

// SetStatusBySubscription はStripeサブスクリプションIDでテナント状態を更新する
func (r *BillingRepository) SetStatusBySubscription(ctx context.Context, subscriptionID, status string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE tenants SET status = ?, updated_at = CURRENT_TIMESTAMP
		WHERE stripe_subscription_id = ?`, status, subscriptionID)
	return err
}

// GetTenantStatus はテナントの契約状態を返す
func (r *BillingRepository) GetTenantStatus(ctx context.Context, tenantID int64) (string, error) {
	var status string
	err := r.db.GetContext(ctx, &status, `SELECT status FROM tenants WHERE id = ?`, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return status, err
}

// GetStripeCustomerID はテナントのStripe顧客IDを返す（未連携なら空文字）
func (r *BillingRepository) GetStripeCustomerID(ctx context.Context, tenantID int64) (string, error) {
	var id sql.NullString
	err := r.db.GetContext(ctx, &id, `SELECT stripe_customer_id FROM tenants WHERE id = ?`, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id.String, err
}

// ─── 申込完了画面への認証情報受け渡し ─────────────────────────

func (r *BillingRepository) CreateProvision(ctx context.Context,
	sessionID string, tenantID int64, slug, adminEmployeeID, initialPassword string) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO signup_provisions
		(checkout_session_id, tenant_id, tenant_slug, admin_employee_id, initial_password)
		VALUES (?, ?, ?, ?, ?)`,
		sessionID, tenantID, slug, adminEmployeeID, initialPassword)
	return err
}

// GetProvision は申込情報を返す。見つからなければ (nil, nil)。
func (r *BillingRepository) GetProvision(ctx context.Context, sessionID string) (*model.SignupProvision, error) {
	var p model.SignupProvision
	err := r.db.GetContext(ctx, &p,
		`SELECT * FROM signup_provisions WHERE checkout_session_id = ?`, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ConsumeProvisionPassword は初期パスワードを取得後に破棄する（一度きりの表示）
func (r *BillingRepository) ConsumeProvisionPassword(ctx context.Context, sessionID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE signup_provisions SET initial_password = NULL WHERE checkout_session_id = ?`, sessionID)
	return err
}

// GetTenantPlanAndMax はテナントのプランと上限人数を返す
func (r *BillingRepository) GetTenantPlanAndMax(ctx context.Context, tenantID int64) (string, int, error) {
	var row struct {
		Plan       string `db:"plan"`
		MaxWorkers int    `db:"max_workers"`
	}
	err := r.db.GetContext(ctx, &row,
		`SELECT plan, max_workers FROM tenants WHERE id = ?`, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, nil
	}
	return row.Plan, row.MaxWorkers, err
}

// UpdatePlanBySubscription はStripeポータルでのプラン変更をテナントに反映する
func (r *BillingRepository) UpdatePlanBySubscription(ctx context.Context, subscriptionID, plan string, maxWorkers int) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE tenants SET plan = ?, max_workers = ?, updated_at = CURRENT_TIMESTAMP
		WHERE stripe_subscription_id = ?`, plan, maxWorkers, subscriptionID)
	return err
}
