# 施工会社シフト管理システム

Go + Vanilla JS による施工会社向け簡易シフト管理WEBアプリ。

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
mkdir -p data && rm -f shift.db shift.db-shm shift.db-wal && docker build -t shift-app . && docker rm -f shift-app 2>/dev/null; docker run --name shift-app -p 8989:8989 -v "$(pwd)/data:/app/data" -e JWT_SECRET="local-dev-secret-32chars-minimum!!" -e TZ=Asia/Tokyo shift-app
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
[1/2] FROM golang:1.22-alpine ...
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

#### VAPID KEYの生成方法

```bash
docker run --rm golang:1.22-alpine sh -c \
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

## 実装フェーズ

- [x] Phase 1: DB設計・認証・モデル・バリデーション
- [ ] Phase 2: 現場・作業者マスタハンドラー実装
- [ ] Phase 3: フロントエンド（Vanilla JS）実装
- [ ] Phase 4: 月次CSV/Excel出力
- [ ] Phase 5: 通知・パスワードリセット
