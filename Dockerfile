# ── ビルドステージ ────────────────────────────────────────
# SQLiteドライバは Pure Go (modernc.org/sqlite) のため Cコンパイラ不要
FROM golang:1.26-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux \
    go build -ldflags="-s -w" -o shift-server ./cmd/server

# ── 実行ステージ ────────────────────────────────────────
FROM alpine:3.22 AS production

RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo

WORKDIR /app
COPY --from=builder /app/shift-server .
COPY --from=builder /app/db           ./db
COPY --from=builder /app/frontend     ./frontend

# データ永続化用ボリューム
VOLUME ["/app/data"]

ENV DB_PATH=/app/data/shift.db
ENV PORT=8989

EXPOSE 8989
CMD ["./shift-server"]
