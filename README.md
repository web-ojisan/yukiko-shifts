# 施工会社シフト管理システム

Go + Vanilla JS による施工会社向け簡易シフト管理WEBアプリ。


---

## ⚠️ Security Notice / セキュリティに関する免責事項

### Authentication Model

This system implements QR code-based authentication as a deliberate design choice prioritizing
field usability over security strength. Each user is assigned a static QR code that grants
access without password verification.

**This design does not conform to standard security practices and is provided as-is.**

### Disclaimer

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
> THE AUTHORS AND CONTRIBUTORS SHALL NOT BE HELD LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER
> LIABILITY — INCLUDING BUT NOT LIMITED TO UNAUTHORIZED ACCESS, IDENTITY SPOOFING, DATA
> BREACH, OR LABOR RECORD DISPUTES — ARISING FROM THE USE OF THIS AUTHENTICATION MECHANISM
> OR ANY PART OF THIS SOFTWARE.

本ソフトウェアは現状有姿で提供されます。QRコード認証方式に起因するなりすまし、不正アクセス、勤怠記録の改ざん、その他いかなる損害についても、開発者および貢献者は一切の責任を負いません。

### Known Security Limitations

- **Static credentials:** QR codes do not expire and cannot be invalidated without manual regeneration.
- **No possession proof:** A photographed or printed QR code is functionally equivalent to the original.
- **No audit trail integrity guarantee:** Log entries cannot be cryptographically attributed to the physical device holder.

### 連絡先の取り扱い（E2E暗号化）

作業者の電話番号は管理者ブラウザ内で暗号化してから保存でき、サーバ運営者は
復号できません。仕組みの詳細は [PRIVACY.md](PRIVACY.md) を参照してください。

### Recommended Mitigations *(PRs welcome)*

- Replace static QR codes with TOTP-based one-time codes
- Add IP/geolocation binding per user session
- Implement anomaly detection on login patterns

---
## プロジェクト構成

```
shift-app/
├── cmd/server/
│   └── main.go               # エントリーポイント・ルーティング
├── internal/
│   ├── model/model.go         # ドメインモデル・リクエスト/レスポンス型
│   ├── repository/repository.go # DB操作（sqlx）
│   ├── handler/handler.go     # HTTPハンドラー
│   └── validator/shift_validator.go # 二重アサインバリデーション
├── db/migrations/
│   └── 001_init.sql           # DBスキーマ
├── frontend/
│   ├── static/                # CSS / JS
│   └── templates/index.html   # SPAエントリーポイント
├── Dockerfile
├── compose.yaml
├── go.mod
├── API_DESIGN.md              # API仕様書
└── README.md
```

---

## クイックスタート

### 事前準備：ENV設定

起動コマンドの以下の値を自分の環境に合わせて書き換えてください：

| 変数 | デフォルト値 | 変更が必要なケース |
|------|------------|-----------------|
| `JWT_SECRET` | `local-dev-secret-32chars-minimum!!` | **本番環境では必ず**32文字以上のランダム文字列に変更 |
| `TZ` | `Asia/Tokyo` | タイムゾーンが異なる場合 |

JWTシークレットの生成例：
```bash
openssl rand -base64 32
```

プッシュ通知を使う場合は追加で VAPID KEY も設定してください（後述）。

### Clone直後はこの1コマンドで起動

```bash
# Clone して 必要なENV設定終わったら以下のコマンドで起動
mkdir -p data && rm -f shift.db shift.db-shm shift.db-wal && docker build -t shift-app . && docker rm -f shift-app 2>/dev/null; docker run --name shift-app -p 8989:8989 -v "$(pwd)/data:/app/data" -e JWT_SECRET="local-dev-secret-32chars-minimum!!" -e TZ=Asia/Tokyo -e DEMO_LOGIN=true shift-app
```

起動したら `http://localhost:8989` を開いてログイン：

| ロール | ID | パスワード |
|--------|-----|-----------|
| 管理者 | `admin` | `admin1234` |
| 作業者（例） | `w001` | `worker1234` |

> ⚠️ **本番運用前に必ずパスワードを変更してください。**

---

## MacBook Pro ローカル動作確認手順（Docker使用）

### 1. Docker Desktop のインストール

まだ入っていない場合は以下からダウンロード：
https://www.docker.com/products/docker-desktop/

インストール後、Docker Desktop を起動してメニューバーにクジラアイコンが出ればOK。

```bash
# インストール確認
docker --version
# → Docker version 25.x.x などが表示されればOK
```

---

### 2. プロジェクトの準備

```bash
# ZIPを展開してプロジェクトディレクトリに移動
unzip shift-app-design.zip
cd shift-app

# DBデータ永続化用ディレクトリを作成
mkdir -p data
```

> ⚠️ **重要**: プロジェクトルート直下に `shift.db` が残っていると古いDBが参照されてログインできなくなります。
> もし存在する場合は削除してください：
> ```bash
> rm -f shift.db shift.db-shm shift.db-wal
> ```

---

### 3. Dockerイメージのビルド

```bash
docker build -t shift-app .
```

初回はGoパッケージのダウンロードがあるため 3〜5分 かかります。
以下のように進めば正常です：

```
[1/2] FROM golang:1.26-alpine ...
[2/2] RUN go mod download ...
Successfully built xxxxxxxx
Successfully tagged shift-app:latest
```

---

### 4. コンテナ起動

```bash
docker run \
  --name shift-app \
  -p 8989:8989 \
  -v "$(pwd)/data:/app/data" \
  -e JWT_SECRET="local-dev-secret-32chars-minimum!!" \
  -e TZ=Asia/Tokyo \
  shift-app
```

起動すると以下のログが出ます：
```
2025/05/25 09:00:00 起動: http://localhost:8989
```

> ⚠️ **注意**: `-e` のオプション値をコピペするときに余計な文字列が混入しないよう注意してください。
> 特に `JWT_SECRET` の値に別のコマンドが混入するとログインに失敗します。

---

### 5. ブラウザで確認

```
http://localhost:8989
```

#### 開発用ログイン情報

| ロール | ID | パスワード |
|--------|-----|-----------|
| 管理者 | `admin` | `admin1234` |
| 作業者（例） | `w001` | `worker1234` |

> ⚠️ **本番運用前に必ずパスワードを変更してください。**

---

### 6. コンテナの停止・再起動

```bash
# 停止（Ctrl+C でも可）
docker stop shift-app

# 再起動（データはそのまま）
docker start shift-app

# ログ確認
docker logs shift-app

# コンテナ削除（イメージは残る）
docker rm shift-app
```

---

### 7. コードを修正して反映するとき

```bash
docker rm -f shift-app
docker build -t shift-app .
docker run \
  --name shift-app \
  -p 8989:8989 \
  -v "$(pwd)/data:/app/data" \
  -e JWT_SECRET="local-dev-secret-32chars-minimum!!" \
  -e TZ=Asia/Tokyo \
  shift-app
```

---

### 8. DBを初期化したいとき（データをリセット）

```bash
docker rm -f shift-app
rm -rf ./data
mkdir ./data
docker run \
  --name shift-app \
  -p 8989:8989 \
  -v "$(pwd)/data:/app/data" \
  -e JWT_SECRET="local-dev-secret-32chars-minimum!!" \
  -e TZ=Asia/Tokyo \
  shift-app
```

> ⚠️ `./data` を削除するとすべてのデータが消えます。本番環境では実行しないでください。

---

### docker compose を使う場合（推奨）

`compose.yaml` がプロジェクトルートにあればコマンド1本で起動できます：

```bash
# 起動（コード変更も --build で反映）
docker compose up --build

# バックグラウンド起動
docker compose up -d --build

# 停止
docker compose down
```

---

### トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| `Failed to fetch` でログインできない | コンテナが起動していない | `docker ps` で確認、`docker start shift-app` で再起動 |
| ログインで401エラー | 古いDBが残っている | ルートの `shift.db` を削除してDBリセット |
| `Unable to find image` エラー | イメージが未ビルド | `docker build -t shift-app .` を実行 |
| `migration: skipped (already applied)` が全部出る | 古いDBが参照されている | ルートの `shift.db` を削除 |
| プッシュ通知が動かない | VAPID KEYが未設定 | 下記「環境変数一覧」を参照 |

---

## 環境変数一覧

| 変数名 | デフォルト値 | 説明 |
|--------|------------|------|
| `JWT_SECRET` | （必須） | JWTシークレット（本番は32文字以上のランダム文字列） |
| `DB_PATH` | `/app/data/shift.db` | SQLiteファイルパス |
| `PORT` | `8989` | サーバーポート |
| `TZ` | `Asia/Tokyo` | タイムゾーン |
| `VAPID_PUBLIC_KEY` | （任意） | プッシュ通知用公開鍵 |
| `VAPID_PRIVATE_KEY` | （任意） | プッシュ通知用秘密鍵 |
| `ATTENDANCE_ENABLED` | `false` | `true` で出退勤打刻機能を有効化 |
| `DEMO_LOGIN` | `false` | `true` でログイン画面にデモ用クイックログインを表示（**本番では設定しない**） |
| `BASE_URL` | `http://localhost:<PORT>` | 公開URL（Stripe Checkoutのリダイレクト先） |
| `BACKUP_ENABLED` | `true` | `false` で日次DBバックアップを無効化 |
| `BACKUP_DIR` | `<DATA_DIR>/backups` | バックアップ保存先 |
| `BACKUP_KEEP_DAYS` | `14` | バックアップの保持日数 |
| `STRIPE_SECRET_KEY` 他 | （任意） | セルフサーブ課金用。下記「オンライン申込の設定」参照 |

---

## データベースの定期バックアップ

デフォルトで有効です。毎日 03:00 (JST) に稼働中のDBから安全にスナップショットを取得し
（SQLiteの `VACUUM INTO`）、gzip圧縮して `<DATA_DIR>/backups/` に保存します。
14日より古いバックアップは自動削除されます。

**オフサイト保存（推奨）**: Cloudflare R2 の環境変数
（`R2_ACCOUNT_ID` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_BUCKET`）が設定されていれば、
バックアップは R2 の `backups/` 配下にも自動アップロードされます。
サーバーのディスク故障・ホスト消失に備えるため、本番では設定を推奨します。

### リストア手順

```bash
# 1. アプリを停止する
# 2. バックアップを解凍して DB_PATH に配置（-wal/-shm が残っていれば削除）
gunzip -c data/backups/backup-20260902-030000.db.gz > data/shift.db
rm -f data/shift.db-wal data/shift.db-shm
# 3. アプリを起動する（マイグレーションは適用済み記録に従い自動スキップされる）
```

---

## オンライン申込の設定（Stripe）

`/signup` からのセルフサーブ契約を有効にする手順:

1. [Stripeダッシュボード](https://dashboard.stripe.com)で商品を3つ作成（entry / basic / pro の月額）し、各 **Price ID**（`price_...`）を控える
   - プラン内容: entry=作業員10名まで / basic=50名まで+月次日報CSV / pro=100名まで
2. 開発者 → APIキー から **シークレットキー**（`sk_...`）を取得
3. 開発者 → Webhook でエンドポイント `https://<公開URL>/api/stripe/webhook` を登録し、
   イベント `checkout.session.completed` / `customer.subscription.updated` /
   `customer.subscription.deleted` を選択 → **署名シークレット**（`whsec_...`）を取得
4. 環境変数を設定して起動:
   ```
   STRIPE_SECRET_KEY=sk_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_ENTRY=price_...
   STRIPE_PRICE_BASIC=price_...
   STRIPE_PRICE_PRO=price_...
   BASE_URL=https://<公開URL>
   ```

5変数が揃っていない場合、課金機能は無効のまま従来どおり動作します。
ローカルでのWebhookテストは `stripe listen --forward-to localhost:8989/api/stripe/webhook`（Stripe CLI）が便利です。

> 💡 決済情報・請求先はStripe側にのみ保存され、本アプリのDBには各種IDのみが残ります。
> 申込完了画面の初期パスワードは一度表示すると破棄されます（メールは送信しない＝保持しない）。

#### VAPID KEYの生成方法

```bash
docker run --rm golang:1.26-alpine sh -c \
  'go install github.com/SherClockHolmes/webpush-go/cmd/vapid@latest && vapid'
```

---

## デプロイ先候補（本番運用時）

| サービス | 特徴 | 月額目安 |
|---------|------|---------|
| Railway | Dockerそのままデプロイ・無料枠あり | 無料〜$5 |
| Render | 同上・スリープあり（無料枠） | 無料〜$7 |
| Fly.io | 小さいVMで常時稼働・低コスト | $2〜 |
| VPS（さくら等） | 完全自由・SQLite永続化しやすい | ¥500〜 |

---

## 実装状況

### 実装済み
- DB設計・JWT認証・二重アサインバリデーション
- 現場・作業者マスタ（管理画面）
- シフトボード（週/日表示・D&D・一括アサイン・ロック）
- 職長アサイン・優先順位・自動提案・チーム日報一括入力
- 日報・月報（提出確定・管理者サマリ）
- QRコードログイン（個別/一括印刷・トークン再発行）
- Webプッシュ通知（希望提出・毎日19時の翌日シフトリマインド）
- 出退勤打刻（`ATTENDANCE_ENABLED=true`・写真つき）
- 電話番号E2E暗号化（詳細は [PRIVACY.md](PRIVACY.md)）
- 月次日報CSVエクスポート（給与計算向け・ベーシックプラン以上）
- Stripeセルフサーブ課金（3プラン・人数上限・オンライン解約）

### 未実装
- パスワードリセット
