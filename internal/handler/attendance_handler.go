package handler

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/repository"
	"github.com/yourorg/shift-app/internal/storage"
)

const maxPhotoBytes = 10 << 20 // 10MB（クライアント圧縮後は通常 <500KB）

type AttendanceHandler struct {
	repo    *repository.AttendanceRepository
	storage storage.PhotoStorage
}

func NewAttendanceHandler(repo *repository.AttendanceRepository, st storage.PhotoStorage) *AttendanceHandler {
	return &AttendanceHandler{repo: repo, storage: st}
}

// GET /api/attendance/today
func (h *AttendanceHandler) GetToday(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	userID   := currentUserID(r)

	resp, err := h.repo.GetToday(r.Context(), tenantID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "データ取得エラー")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/attendance/clock-in  (multipart/form-data: photo, site_id は自動)
func (h *AttendanceHandler) ClockIn(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	userID   := currentUserID(r)

	// 今日のシフトから site_id を取得
	today, err := h.repo.GetToday(r.Context(), tenantID, userID)
	if err != nil || !today.HasShift {
		writeError(w, http.StatusBadRequest, "本日のシフトが見つかりません")
		return
	}
	if today.Attendance != nil {
		writeError(w, http.StatusConflict, "すでに出勤済みです")
		return
	}

	photoURL, err := h.receivePhoto(r, tenantID, userID, "in")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	log, err := h.repo.ClockIn(r.Context(), tenantID, userID, *today.SiteID, photoURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "出勤記録に失敗しました")
		return
	}
	writeJSON(w, http.StatusCreated, log)
}

// POST /api/attendance/clock-out  (multipart/form-data: photo)
func (h *AttendanceHandler) ClockOut(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	userID   := currentUserID(r)

	today, err := h.repo.GetToday(r.Context(), tenantID, userID)
	if err != nil || today.Attendance == nil {
		writeError(w, http.StatusBadRequest, "出勤記録が見つかりません")
		return
	}
	if today.Attendance.ClockOutAt != nil {
		writeError(w, http.StatusConflict, "すでに退勤済みです")
		return
	}

	photoURL, err := h.receivePhoto(r, tenantID, userID, "out")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	log, err := h.repo.ClockOut(r.Context(), tenantID, userID, photoURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "退勤記録に失敗しました")
		return
	}
	writeJSON(w, http.StatusOK, log)
}

// receivePhoto は multipart フォームから写真を読み取り、ストレージにアップロードしてURLを返す。
func (h *AttendanceHandler) receivePhoto(r *http.Request, tenantID, userID int64, direction string) (string, error) {
	if err := r.ParseMultipartForm(maxPhotoBytes); err != nil {
		return "", fmt.Errorf("ファイルサイズが大きすぎます")
	}
	file, hdr, err := r.FormFile("photo")
	if err != nil {
		return "", fmt.Errorf("写真が添付されていません")
	}
	defer file.Close()

	// MIME チェック（簡易）
	ct := hdr.Header.Get("Content-Type")
	if ct != "image/jpeg" && ct != "image/png" && ct != "image/webp" {
		return "", fmt.Errorf("画像ファイル（JPEG/PNG/WebP）を添付してください")
	}

	data, err := io.ReadAll(io.LimitReader(file, maxPhotoBytes))
	if err != nil {
		return "", fmt.Errorf("ファイル読み込みエラー")
	}

	// キー: {tenant}/{date}/{userID}_{direction}_{unix}.jpg
	key := fmt.Sprintf("%d/%s/%d_%s_%d.jpg",
		tenantID,
		time.Now().Format("2006-01-02"),
		userID,
		direction,
		time.Now().UnixMilli(),
	)

	url, err := h.storage.Upload(r.Context(), key, data)
	if err != nil {
		return "", fmt.Errorf("写真のアップロードに失敗しました")
	}
	return url, nil
}

// AttendanceLog は管理者向け集計用（将来拡張）
func (h *AttendanceHandler) GetSummary(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"message": "coming soon"})
}

// ── 型アサーション用ダミー（コンパイル確認）──────────────────
var _ model.TodayStatusResponse
