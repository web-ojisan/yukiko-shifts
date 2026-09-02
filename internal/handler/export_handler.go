package handler

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/repository"
)

// ExportHandler — 月次日報CSVエクスポート（給与計算向け・ベーシックプラン以上）
type ExportHandler struct {
	reportRepo  *repository.DailyReportRepository
	billingRepo *repository.BillingRepository
}

func NewExportHandler(reportRepo *repository.DailyReportRepository, billingRepo *repository.BillingRepository) *ExportHandler {
	return &ExportHandler{reportRepo: reportRepo, billingRepo: billingRepo}
}

var statusLabels = map[model.AttendStatus]string{
	model.StatusPresent: "出勤",
	model.StatusAbsent:  "休み",
	model.StatusHalf:    "半日",
	model.StatusHalfAM:  "半日(午前)",
	model.StatusHalfPM:  "半日(午後)",
}

// GET /api/reports/export?year=&month= — 月次日報明細CSV（管理者）
func (h *ExportHandler) MonthlyCSV(w http.ResponseWriter, r *http.Request) {
	tenantID := currentTenantID(r)

	// プランゲート: おためし(entry)プランでは利用不可
	plan, _, err := h.billingRepo.GetTenantPlanAndMax(r.Context(), tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "プラン情報の取得に失敗しました")
		return
	}
	if plan == "entry" {
		writeError(w, http.StatusForbidden,
			"月次CSVエクスポートはベーシックプラン以上の機能です。「契約・お支払い」からアップグレードできます")
		return
	}

	year, _ := strconv.Atoi(r.URL.Query().Get("year"))
	month, _ := strconv.Atoi(r.URL.Query().Get("month"))
	if year == 0 {
		year = time.Now().Year()
	}
	if month == 0 {
		month = int(time.Now().Month())
	}

	rows, err := h.reportRepo.ExportMonthlyReports(r.Context(), tenantID, year, month)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "データ取得エラー")
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="nippou_%04d-%02d.csv"`, year, month))

	// Excelで文字化けしないようUTF-8 BOMを付与
	w.Write([]byte{0xEF, 0xBB, 0xBF})

	cw := csv.NewWriter(w)
	defer cw.Flush()

	cw.Write([]string{"日付", "社員ID", "氏名", "出欠", "現場1", "現場2", "人工", "残業時間", "車両", "備考"})
	for _, row := range rows {
		status := statusLabels[row.Status]
		if status == "" {
			status = string(row.Status)
		}
		car := ""
		if row.UsedCar {
			car = "有"
		}
		cw.Write([]string{
			row.WorkDate,
			row.EmployeeID,
			row.UserName,
			status,
			row.SiteName,
			row.SiteName2,
			strconv.FormatFloat(row.ManDays, 'f', -1, 64),
			strconv.FormatFloat(row.OvertimeHours, 'f', -1, 64),
			car,
			row.Note,
		})
	}
}
