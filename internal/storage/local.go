package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// localStorage は開発用。写真を dataDir/photos/ に保存し /photos/{key} で返す。
type localStorage struct {
	dir string
}

func (s *localStorage) Upload(_ context.Context, key string, data []byte) (string, error) {
	path := filepath.Join(s.dir, key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("local storage mkdir: %w", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", fmt.Errorf("local storage write: %w", err)
	}
	return "/photos/" + key, nil
}
