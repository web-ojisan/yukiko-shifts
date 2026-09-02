package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/repository"
)

// ============================================================
// ForemanHandler
// ============================================================

type ForemanHandler struct {
	foremanRepo *repository.ForemanRepository
	shiftRepo   *repository.ShiftRepository
}

func NewForemanHandler(
	foremanRepo *repository.ForemanRepository,
	shiftRepo *repository.ShiftRepository,
) *ForemanHandler {
	return &ForemanHandler{foremanRepo: foremanRepo, shiftRepo: shiftRepo}
}

// GET /api/sites/{siteID}/foreman-priorities
func (h *ForemanHandler) GetPriorities(w http.ResponseWriter, r *http.Request) {
	siteID, err := strconv.ParseInt(chi.URLParam(r, "siteID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "siteID が不正です")
		return
	}
	items, err := h.foremanRepo.GetPriorities(r.Context(), siteID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "取得エラー")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// PUT /api/sites/{siteID}/foreman-priorities  body: [{user_id}]
func (h *ForemanHandler) SetPriorities(w http.ResponseWriter, r *http.Request) {
	siteID, err := strconv.ParseInt(chi.URLParam(r, "siteID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "siteID が不正です")
		return
	}
	var items []model.ForemanPriority
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
		writeError(w, http.StatusBadRequest, "リクエスト形式が不正です")
		return
	}
	if err := h.foremanRepo.SetPriorities(r.Context(), siteID, items); err != nil {
		writeError(w, http.StatusInternalServerError, "保存エラー")
		return
	}
	w.WriteHeader(http.StatusOK)
}

// GET /api/foreman/assignments?from=YYYY-MM-DD&to=YYYY-MM-DD
func (h *ForemanHandler) GetAssignments(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeError(w, http.StatusBadRequest, "from と to が必要です")
		return
	}
	rows, err := h.foremanRepo.GetAssignments(r.Context(), tenantID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "取得エラー")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// PUT /api/foreman/assignments  body: {site_id, work_date, user_id, is_manual}
func (h *ForemanHandler) UpsertAssignment(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	var req struct {
		SiteID   int64  `json:"site_id"`
		WorkDate string `json:"work_date"`
		UserID   int64  `json:"user_id"`
		IsManual bool   `json:"is_manual"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SiteID == 0 || req.WorkDate == "" || req.UserID == 0 {
		writeError(w, http.StatusBadRequest, "site_id / work_date / user_id が必要です")
		return
	}
	if err := h.foremanRepo.UpsertAssignment(r.Context(), tenantID, req.SiteID, req.WorkDate, req.UserID, req.IsManual); err != nil {
		writeError(w, http.StatusInternalServerError, "保存エラー")
		return
	}
	w.WriteHeader(http.StatusOK)
}

// DELETE /api/foreman/assignments?site_id=N&work_date=YYYY-MM-DD
func (h *ForemanHandler) DeleteAssignment(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	siteID, _ := strconv.ParseInt(r.URL.Query().Get("site_id"), 10, 64)
	workDate := r.URL.Query().Get("work_date")
	if siteID == 0 || workDate == "" {
		writeError(w, http.StatusBadRequest, "site_id と work_date が必要です")
		return
	}
	if err := h.foremanRepo.DeleteAssignment(r.Context(), tenantID, siteID, workDate); err != nil {
		writeError(w, http.StatusInternalServerError, "削除エラー")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/foreman/suggest?year=YYYY&month=M
// 指定月の全現場×日に対する職長候補を返す（ロック時確認モーダル用）
func (h *ForemanHandler) Suggest(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	year, _ := strconv.Atoi(r.URL.Query().Get("year"))
	month, _ := strconv.Atoi(r.URL.Query().Get("month"))
	if year == 0 || month == 0 {
		now := time.Now()
		year, month = now.Year(), int(now.Month())
	}

	firstDay := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	lastDay := time.Date(year, time.Month(month+1), 0, 0, 0, 0, 0, time.UTC)
	from := firstDay.Format("2006-01-02")
	to := lastDay.Format("2006-01-02")

	// 月内のシフトアサイン一覧を取得（現場×日の組み合わせを抽出）
	assignments, err := h.shiftRepo.FindAssignmentsByDateRange(r.Context(), tenantID, firstDay, lastDay)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "データ取得エラー")
		return
	}

	// 既存の職長アサイン（手動設定済みのものを優先）
	existing, err := h.foremanRepo.GetAssignments(r.Context(), tenantID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "データ取得エラー")
		return
	}
	existingMap := map[string]model.ForemanAssignment{}
	for _, fa := range existing {
		key := fmt.Sprintf("%d_%s", fa.SiteID, fa.WorkDate)
		existingMap[key] = fa
	}

	// 現場×日の組み合わせをセットで収集
	type siteDate struct {
		siteID   int64
		siteName string
		date     string
	}
	seen := map[string]siteDate{}
	for _, a := range assignments {
		date := a.WorkDate.Format("2006-01-02")
		key := fmt.Sprintf("%d_%s", a.SiteID, date)
		if _, ok := seen[key]; !ok {
			sn := ""
			if a.SiteName != nil {
				sn = *a.SiteName
			}
			seen[key] = siteDate{siteID: a.SiteID, siteName: sn, date: date}
		}
	}

	suggestions := make([]model.ForemanSuggestion, 0, len(seen))
	for key, sd := range seen {
		var userID *int64
		var userName string
		var isManual bool

		if fa, ok := existingMap[key]; ok && fa.IsManual {
			// 手動設定済みを優先
			userID = &fa.UserID
			userName = fa.UserName
			isManual = true
		} else {
			// 優先順位リストから自動提案
			uid, uname, sugErr := h.foremanRepo.SuggestForeman(r.Context(), sd.siteID, sd.date)
			if sugErr == nil {
				userID = uid
				userName = uname
			}
		}

		candidates, _ := h.foremanRepo.GetQualifiedCandidates(r.Context(), sd.siteID, sd.date)

		suggestions = append(suggestions, model.ForemanSuggestion{
			SiteID:     sd.siteID,
			SiteName:   sd.siteName,
			WorkDate:   sd.date,
			UserID:     userID,
			UserName:   userName,
			IsManual:   isManual,
			HasAlert:   userID == nil,
			Candidates: candidates,
		})
	}

	sort.Slice(suggestions, func(i, j int) bool {
		if suggestions[i].WorkDate != suggestions[j].WorkDate {
			return suggestions[i].WorkDate < suggestions[j].WorkDate
		}
		return suggestions[i].SiteName < suggestions[j].SiteName
	})

	writeJSON(w, http.StatusOK, suggestions)
}

// GET /api/foreman/team-reports?site_id=X&work_date=YYYY-MM-DD
// 職長（またはAdmin）がその日その現場のメンバー全員の日報データを取得する
func (h *ForemanHandler) GetTeamReports(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	userID   := currentUserID(r)
	role     := currentUserRole(r)

	siteID, err := strconv.ParseInt(r.URL.Query().Get("site_id"), 10, 64)
	if err != nil || siteID == 0 {
		writeError(w, http.StatusBadRequest, "site_id が不正です")
		return
	}
	workDate := r.URL.Query().Get("work_date")
	if workDate == "" {
		writeError(w, http.StatusBadRequest, "work_date が必要です")
		return
	}

	if role != "admin" {
		ok, err := h.foremanRepo.IsForeman(r.Context(), tenantID, siteID, workDate, userID)
		if err != nil || !ok {
			writeError(w, http.StatusForbidden, "この操作は担当職長のみ実行できます")
			return
		}
	}

	members, err := h.foremanRepo.GetTeamReports(r.Context(), tenantID, siteID, workDate)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "取得エラー: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// PUT /api/foreman/team-reports
// 職長がチームメンバー全員の日報を一括保存する
func (h *ForemanHandler) UpsertTeamReports(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)
	userID   := currentUserID(r)
	role     := currentUserRole(r)

	var req model.TeamReportsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "リクエスト形式が不正です")
		return
	}
	if req.SiteID == 0 || req.WorkDate == "" || len(req.Members) == 0 {
		writeError(w, http.StatusBadRequest, "site_id, work_date, members が必要です")
		return
	}

	if role != "admin" {
		ok, err := h.foremanRepo.IsForeman(r.Context(), tenantID, req.SiteID, req.WorkDate, userID)
		if err != nil || !ok {
			writeError(w, http.StatusForbidden, "この操作は担当職長のみ実行できます")
			return
		}
	}

	if err := h.foremanRepo.UpsertTeamReports(r.Context(), tenantID, req.SiteID, req.WorkDate, req.Members); err != nil {
		writeError(w, http.StatusInternalServerError, "保存エラー: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
