package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/yourorg/shift-app/internal/model"
)

func generateQRToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// ============================================================
// ShiftRepository
// ============================================================

type ShiftRepository struct {
	db *sqlx.DB
}

func NewShiftRepository(db *sqlx.DB) *ShiftRepository {
	return &ShiftRepository{db: db}
}

// FindAssignmentsByUserDate は指定作業者×日の全現場アサインを返す（衝突チェック用）
func (r *ShiftRepository) FindAssignmentsByUserDate(ctx context.Context, userID int64, date time.Time) ([]model.ShiftAssignment, error) {
	const q = `
		SELECT sa.*, s.name AS site_name, u.name AS user_name
		FROM shift_assignments sa
		JOIN sites s ON sa.site_id = s.id
		JOIN users u ON sa.user_id = u.id
		WHERE sa.user_id = ? AND sa.work_date = ?`
	var rows []model.ShiftAssignment
	if err := r.db.SelectContext(ctx, &rows, q, userID, date.Format("2006-01-02")); err != nil {
		return nil, fmt.Errorf("FindAssignmentsByUserDate: %w", err)
	}
	return rows, nil
}

// FindAssignmentsBySiteDate は指定現場×日のアサイン一覧を返す
func (r *ShiftRepository) FindAssignmentsBySiteDate(ctx context.Context, siteID int64, date time.Time) ([]model.ShiftAssignment, error) {
	const q = `
		SELECT sa.*, u.name AS user_name
		FROM shift_assignments sa
		JOIN users u ON sa.user_id = u.id
		WHERE sa.site_id = ? AND sa.work_date = ?
		ORDER BY u.name`
	var rows []model.ShiftAssignment
	if err := r.db.SelectContext(ctx, &rows, q, siteID, date.Format("2006-01-02")); err != nil {
		return nil, fmt.Errorf("FindAssignmentsBySiteDate: %w", err)
	}
	return rows, nil
}

// FindAssignmentsByDateRange は日付範囲の全アサインを返す（ボード表示用）
func (r *ShiftRepository) FindAssignmentsByDateRange(ctx context.Context, tenantID int64, from, to time.Time) ([]model.ShiftAssignment, error) {
	const q = `
		SELECT sa.*, u.name AS user_name, s.name AS site_name
		FROM shift_assignments sa
		JOIN users u ON sa.user_id = u.id
		JOIN sites s ON sa.site_id = s.id
		WHERE sa.tenant_id = ? AND sa.work_date BETWEEN ? AND ?
		ORDER BY sa.work_date, s.name, u.name`
	var rows []model.ShiftAssignment
	if err := r.db.SelectContext(ctx, &rows, q, tenantID,
		from.Format("2006-01-02"), to.Format("2006-01-02")); err != nil {
		return nil, fmt.Errorf("FindAssignmentsByDateRange: %w", err)
	}
	return rows, nil
}

// CreateAssignment はアサインを追加する
func (r *ShiftRepository) CreateAssignment(ctx context.Context, a model.ShiftAssignment) (int64, error) {
	const q = `
		INSERT INTO shift_assignments (tenant_id, site_id, user_id, work_date, time_slot, created_by)
		VALUES (?, ?, ?, ?, ?, ?)`
	res, err := r.db.ExecContext(ctx, q,
		a.TenantID, a.SiteID, a.UserID, a.WorkDate.Format("2006-01-02"), a.TimeSlot, a.CreatedBy)
	if err != nil {
		return 0, fmt.Errorf("CreateAssignment: %w", err)
	}
	return res.LastInsertId()
}

// DeleteAssignment はアサインを削除する（自テナントのもののみ）
func (r *ShiftRepository) DeleteAssignment(ctx context.Context, tenantID, id int64) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM shift_assignments WHERE id = ? AND tenant_id = ?`, id, tenantID)
	return err
}

// ============================================================
// DailyReportRepository
// ============================================================

type DailyReportRepository struct {
	db *sqlx.DB
}

func NewDailyReportRepository(db *sqlx.DB) *DailyReportRepository {
	return &DailyReportRepository{db: db}
}

// UpsertDailyReport は日報を登録または更新する（UPSERT）
func (r *DailyReportRepository) UpsertDailyReport(ctx context.Context, rpt model.DailyReport) error {
	const q = `
		INSERT INTO daily_reports
			(tenant_id, user_id, work_date, status, site_id, site_id2, client_name, man_days, overtime_hours, used_car, note, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(tenant_id, user_id, work_date) DO UPDATE SET
			status         = excluded.status,
			site_id        = excluded.site_id,
			site_id2       = excluded.site_id2,
			client_name    = excluded.client_name,
			man_days       = excluded.man_days,
			overtime_hours = excluded.overtime_hours,
			used_car       = excluded.used_car,
			note           = excluded.note,
			updated_at     = CURRENT_TIMESTAMP`
	_, err := r.db.ExecContext(ctx, q,
		rpt.TenantID, rpt.UserID, rpt.WorkDate.Format("2006-01-02"),
		rpt.Status, rpt.SiteID, rpt.SiteID2, rpt.ClientName,
		rpt.ManDays, rpt.OvertimeHours, rpt.UsedCar, rpt.Note)
	if err != nil {
		return fmt.Errorf("UpsertDailyReport: %w", err)
	}
	return nil
}

// UpdateClientNameBySiteMonth は指定月・現場の全日報に元請名を設定する
func (r *DailyReportRepository) UpdateClientNameBySiteMonth(
	ctx context.Context, userID int64, year, month int, siteID int64, clientName *string,
) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE daily_reports
		SET client_name = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?
		  AND strftime('%Y', work_date) = ?
		  AND strftime('%m', work_date) = ?
		  AND (site_id = ? OR site_id2 = ?)`,
		clientName, userID,
		fmt.Sprintf("%04d", year), fmt.Sprintf("%02d", month),
		siteID, siteID,
	)
	return err
}

// SubmitMonthlyReport は月報提出（submitted_at を記録）
func (r *DailyReportRepository) SubmitMonthlyReport(ctx context.Context, userID int64, year, month int) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE daily_reports
		SET submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?
		  AND strftime('%Y', work_date) = ?
		  AND strftime('%m', work_date) = ?
		  AND submitted_at IS NULL`,
		userID,
		fmt.Sprintf("%04d", year),
		fmt.Sprintf("%02d", month),
	)
	return err
}

// FindByUserMonth は指定作業者の月次日報を返す
func (r *DailyReportRepository) FindByUserMonth(ctx context.Context, userID int64, year, month int) ([]model.DailyReport, error) {
	const q = `
		SELECT dr.*,
		       s1.name AS site_name,
		       s2.name AS site_name2
		FROM daily_reports dr
		LEFT JOIN sites s1 ON dr.site_id  = s1.id
		LEFT JOIN sites s2 ON dr.site_id2 = s2.id
		WHERE dr.user_id = ?
		  AND strftime('%Y', dr.work_date) = ?
		  AND strftime('%m', dr.work_date) = ?
		ORDER BY dr.work_date`
	var rows []model.DailyReport
	err := r.db.SelectContext(ctx, &rows, q,
		userID,
		fmt.Sprintf("%04d", year),
		fmt.Sprintf("%02d", month),
	)
	if err != nil {
		return nil, fmt.Errorf("FindByUserMonth: %w", err)
	}
	return rows, nil
}

// FindMonthlyMissing は出勤予定だが日報未入力の日を返す
func (r *DailyReportRepository) FindMonthlyMissing(ctx context.Context, userID int64, year, month int) ([]time.Time, error) {
	const q = `
		SELECT DISTINCT sa.work_date
		FROM shift_assignments sa
		LEFT JOIN daily_reports dr
		  ON dr.user_id = sa.user_id AND dr.work_date = sa.work_date
		WHERE sa.user_id = ?
		  AND strftime('%Y', sa.work_date) = ?
		  AND strftime('%m', sa.work_date) = ?
		  AND dr.id IS NULL
		ORDER BY sa.work_date`
	var dates []string
	if err := r.db.SelectContext(ctx, &dates, q,
		userID,
		fmt.Sprintf("%04d", year),
		fmt.Sprintf("%02d", month),
	); err != nil {
		return nil, fmt.Errorf("FindMonthlyMissing: %w", err)
	}
	result := make([]time.Time, 0, len(dates))
	for _, d := range dates {
		t, _ := time.Parse("2006-01-02", d)
		result = append(result, t)
	}
	return result, nil
}

// GetMonthlySummary は月次サマリを全作業者分取得する（管理者用）
func (r *DailyReportRepository) GetMonthlySummary(ctx context.Context, tenantID int64, year, month int) ([]model.MonthlySummaryRow, error) {
	const q = `
		SELECT
			u.id   AS user_id,
			u.name AS user_name,
			COUNT(CASE WHEN dr.status = 'present' THEN 1 END) AS total_present,
			COUNT(CASE WHEN dr.status = 'absent'  THEN 1 END) AS total_absent,
			COALESCE(SUM(dr.man_days),       0) AS total_man_days,
			COALESCE(SUM(dr.overtime_hours), 0) AS total_overtime,
			COUNT(CASE WHEN sa.work_date IS NOT NULL AND dr.id IS NULL THEN 1 END) AS missing_days
		FROM users u
		LEFT JOIN daily_reports dr
			ON dr.user_id = u.id
			AND strftime('%Y', dr.work_date) = ?
			AND strftime('%m', dr.work_date) = ?
		LEFT JOIN shift_assignments sa
			ON sa.user_id = u.id
			AND strftime('%Y', sa.work_date) = ?
			AND strftime('%m', sa.work_date) = ?
		WHERE u.tenant_id = ? AND u.role = 'worker' AND u.status = 'active'
		GROUP BY u.id, u.name
		ORDER BY u.name`
	ys := fmt.Sprintf("%04d", year)
	ms := fmt.Sprintf("%02d", month)
	var rows []model.MonthlySummaryRow
	err := r.db.SelectContext(ctx, &rows, q, ys, ms, ys, ms, tenantID)
	if err != nil {
		return nil, fmt.Errorf("GetMonthlySummary: %w", err)
	}
	return rows, nil
}

// ExportMonthlyReports は月次の日報明細を給与計算向けに全作業者分返す（管理者用CSVエクスポート）
func (r *DailyReportRepository) ExportMonthlyReports(ctx context.Context, tenantID int64, year, month int) ([]model.ReportExportRow, error) {
	const q = `
		SELECT
			strftime('%Y-%m-%d', dr.work_date) AS work_date,
			u.employee_id                       AS employee_id,
			u.name                              AS user_name,
			dr.status                           AS status,
			COALESCE(s1.name, '')               AS site_name,
			COALESCE(s2.name, '')               AS site_name2,
			dr.man_days                         AS man_days,
			dr.overtime_hours                   AS overtime_hours,
			dr.used_car                         AS used_car,
			COALESCE(dr.note, '')               AS note
		FROM daily_reports dr
		JOIN users u        ON u.id = dr.user_id
		LEFT JOIN sites s1  ON s1.id = dr.site_id
		LEFT JOIN sites s2  ON s2.id = dr.site_id2
		WHERE u.tenant_id = ?
			AND strftime('%Y', dr.work_date) = ?
			AND strftime('%m', dr.work_date) = ?
		ORDER BY u.employee_id, dr.work_date`
	var rows []model.ReportExportRow
	err := r.db.SelectContext(ctx, &rows, q,
		tenantID, fmt.Sprintf("%04d", year), fmt.Sprintf("%02d", month))
	if err != nil {
		return nil, fmt.Errorf("ExportMonthlyReports: %w", err)
	}
	return rows, nil
}

// ============================================================
// SiteRepository
// ============================================================

type SiteRepository struct {
	db *sqlx.DB
}

func NewSiteRepository(db *sqlx.DB) *SiteRepository {
	return &SiteRepository{db: db}
}

func (r *SiteRepository) FindAll(ctx context.Context, tenantID int64) ([]model.Site, error) {
	var rows []model.Site
	err := r.db.SelectContext(ctx, &rows,
		`SELECT * FROM sites WHERE tenant_id = ? AND status != 'deleted' ORDER BY start_date DESC, id DESC`,
		tenantID)
	return rows, err
}

func (r *SiteRepository) FindByID(ctx context.Context, tenantID, id int64) (*model.Site, error) {
	var s model.Site
	err := r.db.GetContext(ctx, &s,
		`SELECT * FROM sites WHERE id = ? AND tenant_id = ?`, id, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &s, err
}

func (r *SiteRepository) Create(ctx context.Context, s model.Site) (int64, error) {
	const q = `
		INSERT INTO sites (tenant_id, name, client, address, budget_yen, start_date, end_date, note, status, created_by)
		VALUES (:tenant_id, :name, :client, :address, :budget_yen, :start_date, :end_date, :note, :status, :created_by)`
	res, err := r.db.NamedExecContext(ctx, q, s)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *SiteRepository) Update(ctx context.Context, s model.Site) error {
	const q = `
		UPDATE sites SET
			name=:name, client=:client, address=:address,
			budget_yen=:budget_yen, start_date=:start_date, end_date=:end_date,
			note=:note, status=:status, updated_at=CURRENT_TIMESTAMP
		WHERE id=:id AND tenant_id=:tenant_id`
	_, err := r.db.NamedExecContext(ctx, q, s)
	return err
}

// ============================================================
// UserRepository
// ============================================================

type UserRepository struct {
	db *sqlx.DB
}

func NewUserRepository(db *sqlx.DB) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) FindByEmployeeID(ctx context.Context, eid string) (*model.User, error) {
	var u model.User
	err := r.db.GetContext(ctx, &u,
		`SELECT * FROM users WHERE employee_id = ? AND status = 'active'`, eid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

// CountActiveByEmployeeID は同一社員IDを持つ有効ユーザーの数を全テナント横断で返す。
// 2以上なら会社コード(テナントslug)なしのログインは曖昧なため拒否する。
func (r *UserRepository) CountActiveByEmployeeID(ctx context.Context, eid string) (int, error) {
	var n int
	err := r.db.GetContext(ctx, &n,
		`SELECT COUNT(*) FROM users WHERE employee_id = ? AND status = 'active'`, eid)
	return n, err
}

// FindByEmployeeIDAndSlug は会社コード(テナントslug)で絞り込んでユーザーを検索する
func (r *UserRepository) FindByEmployeeIDAndSlug(ctx context.Context, slug, eid string) (*model.User, error) {
	var u model.User
	err := r.db.GetContext(ctx, &u, `
		SELECT u.* FROM users u
		JOIN tenants t ON u.tenant_id = t.id
		WHERE t.slug = ? AND u.employee_id = ? AND u.status = 'active'`, slug, eid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepository) FindAll(ctx context.Context, tenantID int64) ([]model.User, error) {
	var rows []model.User
	err := r.db.SelectContext(ctx, &rows,
		`SELECT * FROM users WHERE tenant_id = ? AND status != 'inactive' ORDER BY name`, tenantID)
	return rows, err
}

// CountActiveWorkers はテナントの有効な作業者数を返す（プラン上限チェック用）
func (r *UserRepository) CountActiveWorkers(ctx context.Context, tenantID int64) (int, error) {
	var n int
	err := r.db.GetContext(ctx, &n,
		`SELECT COUNT(*) FROM users WHERE tenant_id = ? AND role = 'worker' AND status = 'active'`, tenantID)
	return n, err
}

func (r *UserRepository) FindWorkers(ctx context.Context, tenantID int64) ([]model.User, error) {
	var rows []model.User
	err := r.db.SelectContext(ctx, &rows,
		`SELECT * FROM users WHERE tenant_id = ? AND role = 'worker' AND status = 'active' ORDER BY name`, tenantID)
	return rows, err
}

func (r *UserRepository) Create(ctx context.Context, u model.User) (int64, error) {
	if u.Role == model.RoleWorker && (u.QRToken == nil || *u.QRToken == "") {
		token := generateQRToken()
		u.QRToken = &token
	}
	const q = `
		INSERT INTO users
			(tenant_id, employee_id, password_hash, name, last_name, first_name, role, phone, status, qr_token)
		VALUES
			(:tenant_id, :employee_id, :password_hash, :name, :last_name, :first_name, :role, :phone, :status, :qr_token)`
	res, err := r.db.NamedExecContext(ctx, q, u)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *UserRepository) Update(ctx context.Context, u model.User) error {
	const q = `
		UPDATE users SET
			name                 = :name,
			last_name            = :last_name,
			first_name           = :first_name,
			phone                = :phone,
			is_foreman_qualified = :is_foreman_qualified,
			updated_at           = CURRENT_TIMESTAMP
		WHERE id = :id AND tenant_id = :tenant_id`
	_, err := r.db.NamedExecContext(ctx, q, u)
	return err
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id int64, hash string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		hash, id)
	return err
}

func (r *UserRepository) FindByID(ctx context.Context, tenantID, id int64) (*model.User, error) {
	var u model.User
	err := r.db.GetContext(ctx, &u,
		`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, id, tenantID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

// FindByQRToken はQRトークンでユーザーを検索する
func (r *UserRepository) FindByQRToken(ctx context.Context, token string) (*model.User, error) {
	var u model.User
	err := r.db.GetContext(ctx, &u,
		`SELECT * FROM users WHERE qr_token = ? AND status = 'active'`, token)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

// UpdateQRToken はユーザーのQRトークンを更新する
func (r *UserRepository) UpdateQRToken(ctx context.Context, id int64, token string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE users SET qr_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		token, id)
	return err
}

// GetAllQRTokens はテナント内の全作業者のQRトークン一覧を返す（管理者用）
func (r *UserRepository) GetAllQRTokens(ctx context.Context, tenantID int64) ([]model.QRTokenRow, error) {
	var rows []model.QRTokenRow
	err := r.db.SelectContext(ctx, &rows,
		`SELECT id, name, employee_id, qr_token FROM users
		 WHERE tenant_id = ? AND role = 'worker' AND status = 'active' AND qr_token IS NOT NULL
		 ORDER BY name`,
		tenantID)
	if err != nil {
		return nil, fmt.Errorf("GetAllQRTokens: %w", err)
	}
	return rows, nil
}

// ============================================================
// LockRepository
// ============================================================

type LockRepository struct {
	db *sqlx.DB
}

func NewLockRepository(db *sqlx.DB) *LockRepository {
	return &LockRepository{db: db}
}

// GetStatus は指定月のロック状態を返す。ロックなしの場合は nil, nil
func (r *LockRepository) GetStatus(ctx context.Context, tenantID int64, year, month int) (*model.ShiftLock, error) {
	var lock model.ShiftLock
	err := r.db.GetContext(ctx, &lock,
		`SELECT * FROM shift_locks WHERE tenant_id=? AND year=? AND month=?`,
		tenantID, year, month)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("LockRepository.GetStatus: %w", err)
	}
	return &lock, nil
}

// Lock は指定月をロックする（既にロック済みなら上書き）
func (r *LockRepository) Lock(ctx context.Context, tenantID int64, year, month int, lockedBy int64) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO shift_locks (tenant_id, year, month, locked_by)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(tenant_id, year, month) DO UPDATE SET
		   locked_at = CURRENT_TIMESTAMP,
		   locked_by = excluded.locked_by`,
		tenantID, year, month, lockedBy)
	return err
}

// Unlock は指定月のロックを解除する
func (r *LockRepository) Unlock(ctx context.Context, tenantID int64, year, month int) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM shift_locks WHERE tenant_id=? AND year=? AND month=?`,
		tenantID, year, month)
	return err
}

// ============================================================
// PushRepository
// ============================================================

type PushRepository struct{ db *sqlx.DB }

func NewPushRepository(db *sqlx.DB) *PushRepository { return &PushRepository{db: db} }

// Upsert はサブスクリプションを登録／更新する（デバイス再登録に対応）
func (r *PushRepository) Upsert(ctx context.Context, tenantID, userID int64, endpoint, p256dh, auth string) error {
	const q = `
		INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth_key)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, endpoint) DO UPDATE SET
			p256dh   = excluded.p256dh,
			auth_key = excluded.auth_key`
	_, err := r.db.ExecContext(ctx, q, tenantID, userID, endpoint, p256dh, auth)
	return err
}

// Delete は指定 endpoint のサブスクリプションを削除する
func (r *PushRepository) Delete(ctx context.Context, userID int64, endpoint string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, endpoint)
	return err
}

// GetByUserID は指定ユーザーの全サブスクリプションを返す
func (r *PushRepository) GetByUserID(ctx context.Context, userID int64) ([]model.PushSubscription, error) {
	var subs []model.PushSubscription
	err := r.db.SelectContext(ctx, &subs,
		`SELECT * FROM push_subscriptions WHERE user_id=?`, userID)
	return subs, err
}

// GetByRole は指定テナント内の指定ロールを持つユーザーの全サブスクリプションを返す
func (r *PushRepository) GetByRole(ctx context.Context, tenantID int64, role string) ([]model.PushSubscription, error) {
	const q = `
		SELECT ps.* FROM push_subscriptions ps
		JOIN users u ON ps.user_id = u.id
		WHERE ps.tenant_id = ? AND u.role = ?`
	var subs []model.PushSubscription
	err := r.db.SelectContext(ctx, &subs, q, tenantID, role)
	return subs, err
}
