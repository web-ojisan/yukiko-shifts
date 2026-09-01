package handler

import (
	"encoding/json"
	"net/http"

	"github.com/yourorg/shift-app/internal/model"
	"github.com/yourorg/shift-app/internal/repository"
)

// CryptoHandler は連絡先E2E暗号化のテナント別設定を扱う。
// サーバはKDFソルトと検証用暗号文を保管するだけで、復号鍵（パスフレーズ）は
// 一切受け取らない・保持しない。
type CryptoHandler struct {
	repo *repository.CryptoRepository
}

func NewCryptoHandler(repo *repository.CryptoRepository) *CryptoHandler {
	return &CryptoHandler{repo: repo}
}

// GET /api/crypto-settings — 暗号化設定を取得（未設定なら enabled: false）
func (h *CryptoHandler) Get(w http.ResponseWriter, r *http.Request) {
	s, err := h.repo.Get(r.Context(), currentTenantID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "設定の取得に失敗しました")
		return
	}
	if s == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":  true,
		"kdf_salt": s.KDFSalt,
		"verifier": s.Verifier,
	})
}

// POST /api/admin/crypto-settings — 暗号化を有効化（初回のみ）
// 上書きは既存の暗号文を復号不能にするため許可しない。
func (h *CryptoHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req model.CreateCryptoSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "リクエストの形式が不正です")
		return
	}
	if req.KDFSalt == "" || req.Verifier == "" {
		writeError(w, http.StatusBadRequest, "kdf_salt と verifier は必須です")
		return
	}

	tenantID := currentTenantID(r)
	existing, err := h.repo.Get(r.Context(), tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "設定の確認に失敗しました")
		return
	}
	if existing != nil {
		writeError(w, http.StatusConflict, "暗号化は既に有効化されています")
		return
	}

	if err := h.repo.Create(r.Context(), tenantID, req.KDFSalt, req.Verifier); err != nil {
		writeError(w, http.StatusInternalServerError, "設定の保存に失敗しました")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"enabled": true})
}
