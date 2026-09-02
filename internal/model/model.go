package model

import "time"

// ============================================================
// ドメインモデル定義
// ============================================================

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleWorker Role = "worker"
)

type TimeSlot string

const (
	SlotAM  TimeSlot = "AM"
	SlotPM  TimeSlot = "PM"
	SlotAll TimeSlot = "ALL"
)

// Conflicts returns true if two time slots overlap.
// ALL conflicts with everything; AM/PM conflict with same or ALL.
func (t TimeSlot) Conflicts(other TimeSlot) bool {
	if t == SlotAll || other == SlotAll {
		return true
	}
	return t == other
}

type AttendStatus string

const (
	StatusPresent AttendStatus = "present"  // ○
	StatusAbsent  AttendStatus = "absent"   // ×
	StatusHalf    AttendStatus = "half"     // △（未分類）
	StatusHalfAM  AttendStatus = "half_am"  // △前（午前のみ可）
	StatusHalfPM  AttendStatus = "half_pm"  // △後（午後のみ可）
)

// ──────────────────────────────────────
// User
// ──────────────────────────────────────
type User struct {
	ID                  int64     `db:"id"                    json:"id"`
	TenantID            int64     `db:"tenant_id"             json:"tenant_id"`
	EmployeeID          string    `db:"employee_id"           json:"employee_id"`
	PasswordHash        string    `db:"password_hash"         json:"-"`
	Name                string    `db:"name"                  json:"name"`
	LastName            *string   `db:"last_name"             json:"last_name,omitempty"`
	FirstName           *string   `db:"first_name"            json:"first_name,omitempty"`
	Role                Role      `db:"role"                  json:"role"`
	Phone               *string   `db:"phone"                 json:"phone,omitempty"`
	Status              string    `db:"status"                json:"status"`
	IsForemanQualified  bool      `db:"is_foreman_qualified"  json:"is_foreman_qualified"`
	QRToken             *string   `db:"qr_token"              json:"-"` // QRコードログイン用トークン（APIには非公開）
	CreatedAt           time.Time `db:"created_at"            json:"created_at"`
	UpdatedAt           time.Time `db:"updated_at"            json:"updated_at"`
}

// QRTokenRow は管理者向けQRシート印刷用の作業者情報
type QRTokenRow struct {
	ID         int64  `db:"id"          json:"id"`
	Name       string `db:"name"        json:"name"`
	EmployeeID string `db:"employee_id" json:"employee_id"`
	QRToken    string `db:"qr_token"    json:"qr_token"`
}

// ──────────────────────────────────────
// Site（現場）
// ──────────────────────────────────────
type Site struct {
	ID        int64      `db:"id"         json:"id"`
	TenantID  int64      `db:"tenant_id"  json:"tenant_id,omitempty"`
	Name      string     `db:"name"       json:"name"`
	Client    *string    `db:"client"     json:"client,omitempty"`
	Address   *string    `db:"address"    json:"address,omitempty"`
	BudgetYen *int64     `db:"budget_yen" json:"budget_yen,omitempty"`
	StartDate *time.Time `db:"start_date" json:"start_date,omitempty"`
	EndDate   *time.Time `db:"end_date"   json:"end_date,omitempty"`
	Note      *string    `db:"note"       json:"note,omitempty"`
	Status    string     `db:"status"     json:"status"`
	CreatedBy *int64     `db:"created_by" json:"created_by,omitempty"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt time.Time  `db:"updated_at" json:"updated_at"`
}

// SiteUpsertRequest は現場の登録・更新リクエスト
type SiteUpsertRequest struct {
	Name      string  `json:"name"`
	Client    *string `json:"client"`
	Address   *string `json:"address"`
	BudgetYen *int64  `json:"budget_yen"`
	StartDate *string `json:"start_date"` // YYYY-MM-DD or null
	EndDate   *string `json:"end_date"`   // YYYY-MM-DD or null
	Note      *string `json:"note"`
	Status    string  `json:"status"` // "active" | "completed"
}

// ──────────────────────────────────────
// ShiftAssignment（シフト配置）
// ──────────────────────────────────────
type ShiftAssignment struct {
	ID        int64     `db:"id"         json:"id"`
	TenantID  int64     `db:"tenant_id"  json:"tenant_id,omitempty"`
	SiteID    int64     `db:"site_id"    json:"site_id"`
	UserID    int64     `db:"user_id"    json:"user_id"`
	WorkDate  time.Time `db:"work_date"  json:"work_date"`
	TimeSlot  TimeSlot  `db:"time_slot"  json:"time_slot"`
	CreatedBy *int64    `db:"created_by" json:"created_by,omitempty"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`

	// JOINで取得する関連情報
	UserName *string `db:"user_name"  json:"user_name,omitempty"`
	SiteName *string `db:"site_name"  json:"site_name,omitempty"`
}

// ──────────────────────────────────────
// DailyReport（日報）
// ──────────────────────────────────────
type DailyReport struct {
	ID             int64        `db:"id"              json:"id"`
	TenantID       int64        `db:"tenant_id"       json:"tenant_id,omitempty"`
	UserID         int64        `db:"user_id"         json:"user_id"`
	WorkDate       time.Time    `db:"work_date"       json:"work_date"`
	Status         AttendStatus `db:"status"          json:"status"`
	SiteID         *int64       `db:"site_id"         json:"site_id,omitempty"`
	SiteID2        *int64       `db:"site_id2"        json:"site_id2,omitempty"`
	ClientName     *string      `db:"client_name"     json:"client_name,omitempty"`
	ManDays        float64      `db:"man_days"        json:"man_days"`
	OvertimeHours  float64      `db:"overtime_hours"  json:"overtime_hours"`
	UsedCar        bool         `db:"used_car"        json:"used_car"`
	Note           *string      `db:"note"            json:"note,omitempty"`
	SubmittedAt    *time.Time   `db:"submitted_at"    json:"submitted_at,omitempty"`
	UpdatedAt      time.Time    `db:"updated_at"      json:"updated_at"`

	// JOINで取得
	UserName  *string `db:"user_name"  json:"user_name,omitempty"`
	SiteName  *string `db:"site_name"  json:"site_name,omitempty"`
	SiteName2 *string `db:"site_name2" json:"site_name2,omitempty"`
}

// ──────────────────────────────────────
// ShiftLock（希望入力ロック）
// ──────────────────────────────────────
type ShiftLock struct {
	ID       int64     `db:"id"        json:"id"`
	TenantID int64     `db:"tenant_id" json:"-"`
	Year     int       `db:"year"      json:"year"`
	Month    int       `db:"month"     json:"month"`
	LockedAt time.Time `db:"locked_at" json:"locked_at"`
	LockedBy int64     `db:"locked_by" json:"locked_by"`
}

// ──────────────────────────────────────
// Announcement（全体連絡）
// ──────────────────────────────────────
type Announcement struct {
	ID        int64     `db:"id"         json:"id"`
	Title     string    `db:"title"      json:"title"`
	Body      string    `db:"body"       json:"body"`
	CreatedBy int64     `db:"created_by" json:"created_by"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`

	CreatedByName *string `db:"created_by_name" json:"created_by_name,omitempty"`
	ReadAt        *time.Time `db:"read_at"      json:"read_at,omitempty"` // 自分の既読日時
}

// ──────────────────────────────────────
// API Request/Response 型
// ──────────────────────────────────────

type LoginRequest struct {
	EmployeeID  string `json:"employee_id"`
	Password    string `json:"password"`
	CompanyCode string `json:"company_code,omitempty"` // テナントslug。同一社員IDが複数社に存在する場合に必須
}

type LoginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type AssignRequest struct {
	UserID   int64    `json:"user_id"`
	TimeSlot TimeSlot `json:"time_slot"`
}

type WorkerUpsertRequest struct {
	EmployeeID         string  `json:"employee_id"`
	LastName           string  `json:"last_name"`
	FirstName          string  `json:"first_name"`
	Password           string  `json:"password,omitempty"` // 新規時必須、更新時は省略可
	Phone              *string `json:"phone,omitempty"`
	IsForemanQualified bool    `json:"is_foreman_qualified"`
}

type DailyReportUpsertRequest struct {
	Status        AttendStatus `json:"status"`
	SiteID        *int64       `json:"site_id,omitempty"`
	SiteID2       *int64       `json:"site_id2,omitempty"`
	ClientName    *string      `json:"client_name,omitempty"`
	ManDays       float64      `json:"man_days"`
	OvertimeHours float64      `json:"overtime_hours"`
	UsedCar       bool         `json:"used_car"`
	Note          *string      `json:"note,omitempty"`
}

// TeamMemberReport は職長がチーム日報入力で取得するメンバー1人分のデータ
type TeamMemberReport struct {
	UserID        int64   `db:"user_id"        json:"user_id"`
	UserName      string  `db:"user_name"      json:"user_name"`
	ManDays       float64 `db:"man_days"       json:"man_days"`
	OvertimeHours float64 `db:"overtime_hours" json:"overtime_hours"`
	UsedCar       bool    `db:"used_car"       json:"used_car"`
	HasReport     bool    `db:"has_report"     json:"has_report"`
}

// TeamMemberPayload はチーム日報一括保存の1メンバー分
type TeamMemberPayload struct {
	UserID        int64   `json:"user_id"`
	ManDays       float64 `json:"man_days"`
	OvertimeHours float64 `json:"overtime_hours"`
	UsedCar       bool    `json:"used_car"`
}

// TeamReportsRequest はチーム日報一括保存リクエスト
type TeamReportsRequest struct {
	SiteID   int64               `json:"site_id"`
	WorkDate string              `json:"work_date"`
	Members  []TeamMemberPayload `json:"members"`
}

// MonthlySummaryRow は月次サマリの1行
type MonthlySummaryRow struct {
	UserID        int64   `json:"user_id"`
	UserName      string  `json:"user_name"`
	TotalPresent  int     `json:"total_present"`
	TotalAbsent   int     `json:"total_absent"`
	TotalManDays  float64 `json:"total_man_days"`
	TotalOvertime float64 `json:"total_overtime"`
	MissingDays   int     `json:"missing_days"` // 出勤予定だが未入力の日数
}

// ──────────────────────────────────────
// PushSubscription（プッシュ通知サブスクリプション）
// ──────────────────────────────────────
type PushSubscription struct {
	ID        int64     `db:"id"         json:"id"`
	TenantID  int64     `db:"tenant_id"  json:"-"`
	UserID    int64     `db:"user_id"    json:"-"`
	Endpoint  string    `db:"endpoint"   json:"endpoint"`
	P256dh    string    `db:"p256dh"     json:"p256dh"`
	Auth      string    `db:"auth_key"   json:"auth"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

// PushSubscribeRequest はフロントエンドから送られる購読情報
type PushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// PushHopeSubmitRequest は作業者が希望を提出するときのリクエスト
type PushHopeSubmitRequest struct {
	Year  int `json:"year"`
	Month int `json:"month"`
}

// ──────────────────────────────────────
// Foreman（職長）
// ──────────────────────────────────────

// ForemanPriority は現場ごとの職長候補優先順位
type ForemanPriority struct {
	ID            int64  `db:"id"             json:"id"`
	SiteID        int64  `db:"site_id"        json:"site_id"`
	UserID        int64  `db:"user_id"        json:"user_id"`
	PriorityOrder int    `db:"priority_order" json:"priority_order"`
	UserName      string `db:"user_name"      json:"user_name,omitempty"`
}

// ForemanAssignment は職長確定アサイン
type ForemanAssignment struct {
	ID       int64  `db:"id"        json:"id"`
	TenantID int64  `db:"tenant_id" json:"-"`
	SiteID   int64  `db:"site_id"   json:"site_id"`
	WorkDate string `db:"work_date" json:"work_date"`
	UserID   int64  `db:"user_id"   json:"user_id"`
	IsManual  bool      `db:"is_manual"  json:"is_manual"`
	CreatedAt time.Time `db:"created_at" json:"-"`
	// JOINで取得
	UserName string `db:"user_name" json:"user_name,omitempty"`
	SiteName string `db:"site_name" json:"site_name,omitempty"`
}

// ForemanCandidate は職長資格あり・その日その現場に出勤予定の作業者
type ForemanCandidate struct {
	UserID   int64  `json:"user_id"`
	UserName string `json:"user_name"`
}

// ForemanSuggestion はロック時確認モーダル用の1行
type ForemanSuggestion struct {
	SiteID     int64              `json:"site_id"`
	SiteName   string             `json:"site_name"`
	WorkDate   string             `json:"work_date"`
	UserID     *int64             `json:"user_id"`   // nil = 職長未定
	UserName   string             `json:"user_name"`
	IsManual   bool               `json:"is_manual"`
	HasAlert   bool               `json:"has_alert"` // 職長未定の場合 true
	Candidates []ForemanCandidate `json:"candidates"`
}

// ──────────────────────────────────────
// AttendanceLog（出退勤打刻ログ）
// ──────────────────────────────────────

type AttendanceLog struct {
	ID                 int64      `db:"id"                   json:"id"`
	TenantID           int64      `db:"tenant_id"            json:"-"`
	UserID             int64      `db:"user_id"              json:"user_id"`
	SiteID             int64      `db:"site_id"              json:"site_id"`
	WorkDate           string     `db:"work_date"            json:"work_date"`
	ClockInAt          time.Time  `db:"clock_in_at"          json:"clock_in_at"`
	ClockInPhotoURL    string     `db:"clock_in_photo_url"   json:"clock_in_photo_url"`
	ClockOutAt         *time.Time `db:"clock_out_at"         json:"clock_out_at,omitempty"`
	ClockOutPhotoURL   *string    `db:"clock_out_photo_url"  json:"clock_out_photo_url,omitempty"`
	Note               *string    `db:"note"                 json:"note,omitempty"`
	CreatedAt          time.Time  `db:"created_at"           json:"created_at"`
	UpdatedAt          time.Time  `db:"updated_at"           json:"updated_at"`

	// JOINで取得
	SiteName *string `db:"site_name" json:"site_name,omitempty"`
}

// TodayStatusResponse は今日の打刻状態レスポンス
type TodayStatusResponse struct {
	HasShift   bool           `json:"has_shift"`
	SiteID     *int64         `json:"site_id,omitempty"`
	SiteName   *string        `json:"site_name,omitempty"`
	TimeSlot   *string        `json:"time_slot,omitempty"`
	Attendance *AttendanceLog `json:"attendance,omitempty"`
}

// ──────────────────────────────────────
// Tenant（テナント）
// ──────────────────────────────────────
type Plan string

const (
	PlanBasic Plan = "basic"
	PlanPro   Plan = "pro"
)

type Tenant struct {
	ID            int64      `db:"id"             json:"id"`
	Name          string     `db:"name"           json:"name"`
	Slug          string     `db:"slug"           json:"slug"`
	Plan          Plan       `db:"plan"           json:"plan"`
	MaxWorkers    int        `db:"max_workers"    json:"max_workers"`
	Status        string     `db:"status"         json:"status"`
	ContractStart *time.Time `db:"contract_start" json:"contract_start,omitempty"`
	ContractEnd   *time.Time `db:"contract_end"   json:"contract_end,omitempty"`
	CreatedAt     time.Time  `db:"created_at"     json:"created_at"`
	UpdatedAt     time.Time  `db:"updated_at"     json:"updated_at"`
}

// ──────────────────────────────────────
// 連絡先E2E暗号化設定（テナント別）
// サーバはKDFソルトと検証用暗号文のみ保持し、復号鍵は持たない
// ──────────────────────────────────────
type TenantCryptoSettings struct {
	TenantID  int64     `db:"tenant_id"  json:"tenant_id"`
	KDFSalt   string    `db:"kdf_salt"   json:"kdf_salt"`
	Verifier  string    `db:"verifier"   json:"verifier"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	UpdatedAt time.Time `db:"updated_at" json:"updated_at"`
}

type CreateCryptoSettingsRequest struct {
	KDFSalt  string `json:"kdf_salt"`
	Verifier string `json:"verifier"`
}

// ──────────────────────────────────────
// セルフサーブ申込 (Stripe課金)
// ──────────────────────────────────────
type SignupCheckoutRequest struct {
	CompanyName string `json:"company_name"`
	Plan        string `json:"plan"` // 'basic' | 'pro'
}

type SignupProvision struct {
	CheckoutSessionID string    `db:"checkout_session_id" json:"-"`
	TenantID          int64     `db:"tenant_id"           json:"-"`
	TenantSlug        string    `db:"tenant_slug"         json:"company_code"`
	AdminEmployeeID   string    `db:"admin_employee_id"   json:"employee_id"`
	InitialPassword   *string   `db:"initial_password"    json:"initial_password,omitempty"`
	CreatedAt         time.Time `db:"created_at"          json:"-"`
}

// ReportExportRow は月次日報CSVエクスポートの1行分（給与計算向け）
type ReportExportRow struct {
	WorkDate      string       `db:"work_date"`
	EmployeeID    string       `db:"employee_id"`
	UserName      string       `db:"user_name"`
	Status        AttendStatus `db:"status"`
	SiteName      string       `db:"site_name"`
	SiteName2     string       `db:"site_name2"`
	ManDays       float64      `db:"man_days"`
	OvertimeHours float64      `db:"overtime_hours"`
	UsedCar       bool         `db:"used_car"`
	Note          string       `db:"note"`
}
