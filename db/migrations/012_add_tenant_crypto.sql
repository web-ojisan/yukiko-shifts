-- 012_add_tenant_crypto.sql
-- 連絡先E2E暗号化のテナント別設定。
-- kdf_salt: PBKDF2用ソルト（base64）。秘密情報ではない。
-- verifier: 既知定数をパスフレーズ由来鍵で暗号化したもの（enc.v1形式）。
--           復号できればパスフレーズが正しいと判定できる。
-- サーバは復号鍵（パスフレーズ）を一切保持しない。

CREATE TABLE IF NOT EXISTS tenant_crypto_settings (
    tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id),
    kdf_salt   TEXT NOT NULL,
    verifier   TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
