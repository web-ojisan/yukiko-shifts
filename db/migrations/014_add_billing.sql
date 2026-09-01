-- 014_add_billing.sql
-- Stripeセルフサーブ課金対応。
-- 決済情報(カード・請求先)はStripe側にのみ存在し、アプリはIDの参照だけを持つ。

ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_stripe_sub ON tenants(stripe_subscription_id);

-- 申込完了画面へ認証情報を一度だけ渡すための一時テーブル。
-- initial_password は完了画面で表示したら即 NULL に更新する。
CREATE TABLE IF NOT EXISTS signup_provisions (
    checkout_session_id TEXT PRIMARY KEY,
    tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
    tenant_slug         TEXT    NOT NULL,
    admin_employee_id   TEXT    NOT NULL,
    initial_password    TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
