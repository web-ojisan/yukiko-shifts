-- 010_add_attendance.sql
-- 出退勤打刻ログ（写真URL・現場・日時）

CREATE TABLE IF NOT EXISTS attendance_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
    user_id             INTEGER NOT NULL REFERENCES users(id),
    site_id             INTEGER NOT NULL REFERENCES sites(id),
    work_date           DATE    NOT NULL,
    clock_in_at         DATETIME NOT NULL,
    clock_in_photo_url  TEXT    NOT NULL,
    clock_out_at        DATETIME,
    clock_out_photo_url TEXT,
    note                TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date
    ON attendance_logs(tenant_id, work_date);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date
    ON attendance_logs(tenant_id, user_id, work_date);
