# ── ビルドステージ ────────────────────────────────────────
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /app
COPY go.mod ./
RUN go mod tidy || true

COPY . .
RUN go mod tidy && \
    CGO_ENABLED=1 GOOS=linux \
    go build -ldflags="-s -w" -o shift-server ./cmd/server

# ── 実行ステージ ────────────────────────────────────────
FROM alpine:3.19 AS production

RUN apk add --no-cache sqlite-libs tzdata
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
