// Package backup — SQLiteの日次バックアップ。
// VACUUM INTO でスナップショット(WALモードでも稼働中に安全・アトミック)→
// gzip圧縮 → ローテーション → R2設定があればオフサイトにもアップロード。
package backup

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// Uploader はオフサイト転送先（storage.PhotoStorage と互換）
type Uploader interface {
	Upload(ctx context.Context, key string, data []byte) (string, error)
}

// Run はバックアップを1回実行し、作成したファイルのパスを返す。
// up が nil の場合、オフサイト転送はスキップする（ローカル保存のみ）。
func Run(ctx context.Context, db *sqlx.DB, backupDir string, keepDays int, up Uploader) (string, error) {
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return "", fmt.Errorf("backup dir作成: %w", err)
	}

	name := "backup-" + time.Now().Format("20060102-150405") + ".db"
	rawPath := filepath.Join(backupDir, name)

	// VACUUM INTO は既存ファイルがあると失敗するため念のため消しておく
	os.Remove(rawPath)
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, rawPath); err != nil {
		return "", fmt.Errorf("VACUUM INTO: %w", err)
	}

	gzPath, err := gzipFile(rawPath)
	os.Remove(rawPath) // 圧縮前のファイルは残さない
	if err != nil {
		return "", fmt.Errorf("圧縮: %w", err)
	}

	if err := rotate(backupDir, keepDays); err != nil {
		return gzPath, fmt.Errorf("ローテーション: %w", err)
	}

	if up != nil {
		data, err := os.ReadFile(gzPath)
		if err != nil {
			return gzPath, fmt.Errorf("アップロード用読込: %w", err)
		}
		if _, err := up.Upload(ctx, "backups/"+filepath.Base(gzPath), data); err != nil {
			return gzPath, fmt.Errorf("オフサイトアップロード: %w", err)
		}
	}

	return gzPath, nil
}

func gzipFile(path string) (string, error) {
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()

	gzPath := path + ".gz"
	dst, err := os.Create(gzPath)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	gw := gzip.NewWriter(dst)
	if _, err := io.Copy(gw, src); err != nil {
		return "", err
	}
	return gzPath, gw.Close()
}

// rotate は keepDays 日より古いバックアップ(backup-*.db.gz)を削除する
func rotate(backupDir string, keepDays int) error {
	if keepDays <= 0 {
		return nil
	}
	cutoff := time.Now().AddDate(0, 0, -keepDays)
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "backup-") || !strings.HasSuffix(e.Name(), ".db.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			os.Remove(filepath.Join(backupDir, e.Name()))
		}
	}
	return nil
}
