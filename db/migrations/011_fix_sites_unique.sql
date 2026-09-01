-- 011_fix_sites_unique.sql
-- sites テーブルの重複行を削除し、(tenant_id, name) にユニークインデックスを追加する。
-- UNIQUE INDEX は DROP TABLE 不要で追加でき、INSERT OR IGNORE の重複抑止として機能する。

-- 重複行を削除（最小 id を残す）
DELETE FROM sites
WHERE id NOT IN (
    SELECT MIN(id) FROM sites GROUP BY tenant_id, name
);

-- ユニークインデックスを追加（既に存在する場合は CREATE UNIQUE INDEX IF NOT EXISTS で無視）
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_tenant_name ON sites(tenant_id, name);
