-- 013_drop_users_email.sql
-- users.email はAPI・シード・UIのいずれからも未使用のため削除する。
-- 「保持する個人情報を最小化する」方針（PRIVACY.md）の一環。

ALTER TABLE users DROP COLUMN email;
