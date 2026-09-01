// testutil.go — テスト共通ヘルパー
package testutil

import (
	"testing"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite" // Pure Go SQLiteドライバ（CGO不要）
)

// NewDB は in-memory SQLite DB を作成し、プッシュ通知テストに必要なテーブルを作る。
// t.Cleanup で自動クローズする。
func NewDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Open("sqlite", ":memory:?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	// :memory: は接続ごとに別DBになるため、単一接続に固定する
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })

	_, err = db.Exec(`
		CREATE TABLE tenants (
			id   INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			plan TEXT NOT NULL DEFAULT 'basic',
			max_workers INTEGER NOT NULL DEFAULT 30,
			status TEXT NOT NULL DEFAULT 'active',
			contract_start DATE,
			contract_end   DATE,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE users (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id            INTEGER NOT NULL REFERENCES tenants(id),
			employee_id          TEXT    NOT NULL,
			password_hash        TEXT    NOT NULL DEFAULT '',
			name                 TEXT    NOT NULL,
			last_name            TEXT,
			first_name           TEXT,
			role                 TEXT    NOT NULL DEFAULT 'worker',
			phone                TEXT,
			status               TEXT    NOT NULL DEFAULT 'active',
			is_foreman_qualified INTEGER NOT NULL DEFAULT 0,
			qr_token             TEXT,
			created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(tenant_id, employee_id)
		);
		CREATE TABLE sites (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
			name       TEXT    NOT NULL,
			client     TEXT,
			address    TEXT,
			budget_yen INTEGER,
			start_date DATE,
			end_date   DATE,
			note       TEXT,
			status     TEXT NOT NULL DEFAULT 'active',
			created_by INTEGER REFERENCES users(id),
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE shift_assignments (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
			site_id    INTEGER NOT NULL REFERENCES sites(id),
			user_id    INTEGER NOT NULL REFERENCES users(id),
			work_date  DATE    NOT NULL,
			time_slot  TEXT    NOT NULL,
			created_by INTEGER REFERENCES users(id),
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(tenant_id, site_id, user_id, work_date, time_slot)
		);
		CREATE TABLE push_subscriptions (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
			user_id    INTEGER NOT NULL REFERENCES users(id),
			endpoint   TEXT    NOT NULL,
			p256dh     TEXT    NOT NULL,
			auth_key   TEXT    NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, endpoint)
		);
		CREATE TABLE site_foreman_priorities (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
			user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			priority_order INTEGER NOT NULL DEFAULT 0,
			UNIQUE(site_id, user_id)
		);
		CREATE TABLE foreman_assignments (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
			site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
			work_date  TEXT    NOT NULL,
			user_id    INTEGER NOT NULL REFERENCES users(id),
			is_manual  INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(site_id, work_date)
		);

		-- テスト用初期データ
		INSERT INTO tenants (id, name, slug) VALUES (1, 'テストテナント', 'test');
		INSERT INTO users (id, tenant_id, employee_id, name, last_name, first_name, role)
			VALUES
			(1, 1, 'admin', '管理者',   NULL,   NULL,   'admin'),
			(2, 1, 'w001',  '田中一郎', '田中', '一郎', 'worker'),
			(3, 1, 'w002',  '佐藤花子', '佐藤', '花子', 'worker');
		INSERT INTO sites (id, tenant_id, name, status) VALUES (1, 1, '南平岸４条', 'active');
	`)
	if err != nil {
		t.Fatalf("create tables: %v", err)
	}
	return db
}
