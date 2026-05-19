package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/yourorg/shift-app/internal/model"
)

type AttendanceRepository struct {
	db *sqlx.DB
}

func NewAttendanceRepository(db *sqlx.DB) *AttendanceRepository {
	return &AttendanceRepository{db: db}
}

// GetToday は今日のシフト情報と打刻状態を返す。
// シフトがなければ has_shift=false で返す。
func (r *AttendanceRepository) GetToday(ctx context.Context, tenantID, userID int64) (*model.TodayStatusResponse, error) {
	today := time.Now().Format("2006-01-02")

	// 今日のシフトアサインを取得（1人1日に複数スロットある場合は最初の1件）
	type assignRow struct {
		SiteID   int64  `db:"site_id"`
		SiteName string `db:"site_name"`
		TimeSlot string `db:"time_slot"`
	}
	var assign assignRow
	err := r.db.GetContext(ctx, &assign, `
		SELECT sa.site_id, s.name AS site_name, sa.time_slot
		FROM shift_assignments sa
		JOIN sites s ON sa.site_id = s.id
		WHERE sa.tenant_id = ? AND sa.user_id = ? AND sa.work_date = ?
		ORDER BY sa.time_slot
		LIMIT 1`, tenantID, userID, today)
	if err != nil {
		// シフトなし
		return &model.TodayStatusResponse{HasShift: false}, nil
	}

	resp := &model.TodayStatusResponse{
		HasShift: true,
		SiteID:   &assign.SiteID,
		SiteName: &assign.SiteName,
		TimeSlot: &assign.TimeSlot,
	}

	// 打刻ログを取得
	var log model.AttendanceLog
	err = r.db.GetContext(ctx, &log, `
		SELECT al.*, s.name AS site_name
		FROM attendance_logs al
		JOIN sites s ON al.site_id = s.id
		WHERE al.tenant_id = ? AND al.user_id = ? AND al.work_date = ?`,
		tenantID, userID, today)
	if err == nil {
		resp.Attendance = &log
	}

	return resp, nil
}

// ClockIn は出勤打刻を記録する。すでに打刻済みならエラー。
func (r *AttendanceRepository) ClockIn(ctx context.Context, tenantID, userID, siteID int64, photoURL string) (*model.AttendanceLog, error) {
	today := time.Now().Format("2006-01-02")
	now   := time.Now()

	_, err := r.db.ExecContext(ctx, `
		INSERT INTO attendance_logs
		  (tenant_id, user_id, site_id, work_date, clock_in_at, clock_in_photo_url, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		tenantID, userID, siteID, today, now, photoURL, now)
	if err != nil {
		return nil, fmt.Errorf("ClockIn: %w", err)
	}

	return r.getByDate(ctx, tenantID, userID, today)
}

// ClockOut は退勤打刻を記録する。出勤済みでなければエラー。
func (r *AttendanceRepository) ClockOut(ctx context.Context, tenantID, userID int64, photoURL string) (*model.AttendanceLog, error) {
	today := time.Now().Format("2006-01-02")
	now   := time.Now()

	result, err := r.db.ExecContext(ctx, `
		UPDATE attendance_logs
		SET clock_out_at = ?, clock_out_photo_url = ?, updated_at = ?
		WHERE tenant_id = ? AND user_id = ? AND work_date = ? AND clock_out_at IS NULL`,
		now, photoURL, now, tenantID, userID, today)
	if err != nil {
		return nil, fmt.Errorf("ClockOut: %w", err)
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return nil, fmt.Errorf("ClockOut: 出勤記録がないか、すでに退勤済みです")
	}

	return r.getByDate(ctx, tenantID, userID, today)
}

func (r *AttendanceRepository) getByDate(ctx context.Context, tenantID, userID int64, date string) (*model.AttendanceLog, error) {
	var log model.AttendanceLog
	err := r.db.GetContext(ctx, &log, `
		SELECT al.*, s.name AS site_name
		FROM attendance_logs al
		JOIN sites s ON al.site_id = s.id
		WHERE al.tenant_id = ? AND al.user_id = ? AND al.work_date = ?`,
		tenantID, userID, date)
	if err != nil {
		return nil, fmt.Errorf("getByDate: %w", err)
	}
	return &log, nil
}
