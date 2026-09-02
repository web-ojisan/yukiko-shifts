package backup

import (
	"compress/gzip"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

type mockUploader struct {
	keys []string
	size int
}

func (m *mockUploader) Upload(_ context.Context, key string, data []byte) (string, error) {
	m.keys = append(m.keys, key)
	m.size = len(data)
	return "https://example.com/" + key, nil
}

func newTestDB(t *testing.T, dir string) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Open("sqlite", filepath.Join(dir, "test.db")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	db.MustExec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
	db.MustExec(`INSERT INTO t (v) VALUES ('こんにちは'), ('バックアップ')`)
	return db
}

func TestRun_CreatesRestorableBackup(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)
	backupDir := filepath.Join(dir, "backups")

	up := &mockUploader{}
	gzPath, err := Run(t.Context(), db, backupDir, 14, up)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// 圧縮前ファイルは残っていない
	if _, err := os.Stat(gzPath[:len(gzPath)-3]); !os.IsNotExist(err) {
		t.Errorf("圧縮前の.dbファイルが残っている")
	}

	// gz を解凍して実際に開けるか（リストア可能性の検証）
	f, err := os.Open(gzPath)
	if err != nil {
		t.Fatalf("open gz: %v", err)
	}
	defer f.Close()
	gr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	restored := filepath.Join(dir, "restored.db")
	out, _ := os.Create(restored)
	if _, err := io.Copy(out, gr); err != nil {
		t.Fatalf("解凍: %v", err)
	}
	out.Close()

	rdb, err := sqlx.Open("sqlite", restored)
	if err != nil {
		t.Fatalf("restored open: %v", err)
	}
	defer rdb.Close()
	var n int
	if err := rdb.Get(&n, `SELECT COUNT(*) FROM t`); err != nil || n != 2 {
		t.Errorf("リストアデータ: n=%d err=%v", n, err)
	}

	// アップロードが呼ばれている
	if len(up.keys) != 1 || up.size == 0 {
		t.Errorf("upload: %+v size=%d", up.keys, up.size)
	}
}

func TestRun_NilUploader(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)
	if _, err := Run(t.Context(), db, filepath.Join(dir, "b"), 14, nil); err != nil {
		t.Fatalf("nil uploaderでエラー: %v", err)
	}
}

func TestRotate_RemovesOldBackups(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "backup-20200101-030000.db.gz")
	recent := filepath.Join(dir, "backup-new.db.gz")
	other := filepath.Join(dir, "keep-this.txt")
	for _, p := range []string{old, recent, other} {
		os.WriteFile(p, []byte("x"), 0o644)
	}
	oldTime := time.Now().AddDate(0, 0, -30)
	os.Chtimes(old, oldTime, oldTime)

	if err := rotate(dir, 14); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("古いバックアップが削除されていない")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Errorf("新しいバックアップが消された")
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("無関係のファイルが消された")
	}
}
