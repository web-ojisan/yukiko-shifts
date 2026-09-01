# CLAUDE.md

施工会社向けシフト管理WEBアプリ。Go + SQLite + Vanilla JS の単一バイナリ構成。
小規模(単一インスタンス・数十ユーザー)前提の設計であり、**フレームワーク導入や
DB移行などの大掛かりなスタック変更は行わない**。改善は漸進的に。

## 技術スタック

- **バックエンド**: Go + chi (ルーティング) + sqlx + go-chi/jwtauth (JWT HS256)
- **DB**: SQLite (`modernc.org/sqlite`, Pure Go・CGO不要) — WAL モード、`SetMaxOpenConns(1)` で書き込み直列化。ドライバ名は `"sqlite"`、PRAGMAは DSN の `_pragma=name(value)` 形式で指定
- **フロント**: Vanilla JS SPA (ビルドステップなし)。`frontend/templates/index.html` が唯一のHTML、画面はJSで切り替え
- **通知**: Web Push (`webpush-go`) — VAPID キー未設定なら no-op
- **デプロイ**: Docker 単一コンテナ (compose.yaml / docker-compose.prod.yml / fly.toml)

## コマンド

```bash
# サーバー起動(ローカル、Docker不使用)
JWT_SECRET="local-dev-secret-32chars-minimum!!" go run ./cmd/server

# Docker (推奨)
docker compose up --build

# Goテスト
go test ./...

# JSテスト (自前の import-free ランナー。フレームワーク不使用)
node frontend/static/js/board.test.js
node frontend/static/js/sites.test.js
```

開発用ログイン: admin / `admin1234`、作業者 w001 / `worker1234`

## アーキテクチャ

```
cmd/server/main.go        エントリーポイント・全ルーティング・マイグレーション実行・
                          日次リマインダー(19:00 JST goroutine)
internal/
  handler/                HTTPハンドラー (handler.go が中心、機能別に *_handler.go)
  repository/             DB操作 (sqlx。repository.go が中心、機能別に分割)
  model/model.go          ドメインモデル・リクエスト/レスポンス型
  validator/              二重アサインバリデーション (AM/PM/ALL の衝突判定)
  push/                   Web Push 送信
  storage/                打刻写真の保存 (ローカル or R2)
db/migrations/            連番SQLファイル (下記ルール参照)
frontend/static/js/       画面ごとのJS (board.js=シフトボード, worker.js=作業者画面, ...)
frontend/static/css/style.css
```

### 認証・マルチテナント

- JWT claims に `tenant_id` / `user_id` / `role` が入る。`tenantMiddleware`
  (cmd/server/main.go) が Context に注入し、全ハンドラーはそこから取得する
- **新規APIは必ず認証グループ内 (`r.Group`) に追加**し、管理者専用なら
  `handler.RequireAdmin()` でラップする
- QRコードログイン (`/qr-login`) は静的トークンによるパスワードレス認証。
  セキュリティ上の割り切りとして README に免責を明記済み — 「改善」として
  勝手に廃止・変更しない

### DBマイグレーション

- `db/migrations/*.sql` をファイル名昇順で起動時に自動実行。
  `schema_migrations` テーブルで適用済みを追跡
- **適用済みファイルは編集禁止**。変更は必ず新しい連番ファイルを追加する
  (例: `012_xxx.sql`)
- 新規テーブルには `tenant_id` カラムを忘れない

### 連絡先E2E暗号化

- `users.phone` は管理者ブラウザ内で AES-256-GCM 暗号化されてから保存される
  (`enc.v1.<iv>.<ct>` 形式)。鍵はテナント管理者のパスフレーズから PBKDF2 で導出し、
  **サーバは復号鍵を一切持たない**(詳細は `PRIVACY.md`)
- 実装: `frontend/static/js/crypto.js`(暗号化/復号)、`api.js` の `apiGetWorkers`
  (取得時に自動復号)、`workers.js`(有効化・アンロックUI)、
  `internal/handler/crypto_handler.go`(ソルト・検証用暗号文の保存のみ)
- **サーバ側で phone を復号・解釈するコードを書かない**(できない前提の設計)。
  phone を使う新機能はブラウザ側で復号する
- `users.email` カラムは未使用だったため削除済み(013)。メールアドレスは保持しない

### 機能フラグ

- `ATTENDANCE_ENABLED=true` で出退勤打刻機能が有効化 (ハンドラー登録自体が条件分岐)
- `DEMO_LOGIN=true` でログイン画面のデモ用クイックログインボタンが表示される
  (フロントは `GET /api/config` で取得。本番では設定しない)
- VAPID キー未設定なら Push 送信・日次リマインダーは無効 (エラーにはしない)

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `JWT_SECRET` | 本番必須 | 32文字以上。未設定時はデフォルトにフォールバック(要改善点) |
| `DB_PATH` | - | デフォルト `./shift.db` (Docker では `/app/data/shift.db`) |
| `PORT` | - | デフォルト `8989` |
| `TZ` | - | `Asia/Tokyo` 前提のロジックあり (日次リマインダー等) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 任意 | Web Push 用 |
| `ATTENDANCE_ENABLED` | 任意 | `true` で打刻機能有効 |
| `DEMO_LOGIN` | 任意 | `true` でデモ用クイックログイン表示(本番では設定しない) |
| `DATA_DIR` | 任意 | 打刻写真の保存先 (デフォルト `./data`) |

## 規約・注意点

- コメント・コミットメッセージ・UI文言は日本語。コミットは `feat:` `fix:` `docs:` `test:` プレフィックス
- 日付は `YYYY-MM-DD` 文字列、タイムスロットは `AM` / `PM` / `ALL` の3値
- JSテストは「ブラウザ/Node両対応・import-free」の自前ランナー形式を踏襲する
  (Jest 等のフレームワークを導入しない)
- フロントに npm / package.json はない。ライブラリ追加は静的ファイルとして
  `frontend/static/` に置く
- ルート直下に古い `shift.db` が残っているとログイン不能になる典型トラブルあり
  (README のトラブルシューティング参照)
- API仕様は `API_DESIGN.md`、運用手順は `manual.md`
