// workers.js — 作業者管理（管理者用）

import { apiGetWorkers, apiCreateWorker, apiUpdateWorker, apiRegenerateQR,
         apiGetCryptoSettings, apiCreateCryptoSettings } from './api.js';
import { isUnlocked, unlock, setup, encryptValue } from './crypto.js';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _workers = [];
let _editId  = null; // 編集中のworker ID (null = 新規)

// 連絡先E2E暗号化の状態
let _cryptoSettings = null;  // { enabled, kdf_salt, verifier } | null
let _cryptoUnlocked = false; // このタブで復号鍵ロード済みか

// ─── Init ────────────────────────────────────────────────────
export async function initWorkers() {
  const root = document.getElementById('workers-root');
  if (!root) return;
  root.innerHTML = `<div class="wm-loading"><div class="spinner"></div></div>`;
  _cryptoSettings = await apiGetCryptoSettings().catch(() => null);
  _cryptoUnlocked = _cryptoSettings?.enabled ? await isUnlocked() : false;
  _workers = await apiGetWorkers().catch(() => []) ?? [];
  render(root);
}

// ─── 連絡先E2E暗号化 ─────────────────────────────────────────
function cryptoEnabled() {
  return _cryptoSettings?.enabled === true;
}

async function refresh() {
  _workers = await apiGetWorkers().catch(() => []) ?? [];
  const root = document.getElementById('workers-root');
  if (root) render(root);
}

// 暗号化を有効化（初回のみ）。既存の平文電話番号も暗号化して保存し直す。
async function enableCrypto() {
  if (!confirm(
    '電話番号のE2E暗号化を有効にします。\n\n' +
    '・連絡先はパスフレーズがないと復号できなくなります\n' +
    '・パスフレーズを忘れると連絡先は復元できません（再入力が必要）\n' +
    '・サーバ運営者は連絡先を閲覧できなくなります\n\n続行しますか？')) return;
  const p1 = prompt('暗号化用パスフレーズを設定してください（8文字以上）');
  if (!p1) return;
  if (p1.length < 8) { alert('パスフレーズは8文字以上にしてください'); return; }
  const p2 = prompt('確認のためもう一度入力してください');
  if (p1 !== p2) { alert('パスフレーズが一致しません'); return; }
  try {
    const s = await setup(p1);
    await apiCreateCryptoSettings(s);
    _cryptoSettings = { enabled: true, ...s };
    _cryptoUnlocked = true;
    await migratePlaintextPhones();
    alert('暗号化を有効にしました。パスフレーズは安全な場所に控えてください。');
    await refresh();
  } catch (e) {
    alert('暗号化の有効化に失敗しました: ' + e.message);
  }
}

// パスフレーズで復号鍵をロードする。成功時 true。
async function unlockCrypto() {
  const p = prompt('連絡先のパスフレーズを入力してください');
  if (!p) return false;
  const ok = await unlock(p, _cryptoSettings).catch(() => false);
  if (!ok) { alert('パスフレーズが違います'); return false; }
  _cryptoUnlocked = true;
  await migratePlaintextPhones(); // 平文が残っていれば暗号化し直す
  await refresh();
  return true;
}

// サーバに平文のまま残っている電話番号を暗号化して保存し直す
async function migratePlaintextPhones() {
  for (const w of _workers) {
    if (!w._phone_plain || !w.phone) continue;
    try {
      await apiUpdateWorker(w.id, {
        employee_id: w.employee_id,
        last_name:   w.last_name  ?? '',
        first_name:  w.first_name ?? '',
        phone:       await encryptValue(w.phone),
        is_foreman_qualified: !!w.is_foreman_qualified,
      });
    } catch { /* 個別失敗は次回アンロック時に再試行される */ }
  }
}

// ─── Render ─────────────────────────────────────────────────
function render(root) {
  const rows = _workers.map(w => {
    const ln = w.last_name  ?? '';
    const fn = w.first_name ?? '';
    const foremanBadge = w.is_foreman_qualified
      ? `<span class="wm-foreman-badge">職長</span>` : '';
    return `
      <tr>
        <td>${escHtml(w.employee_id)}</td>
        <td>${escHtml(ln)}</td>
        <td>${escHtml(fn)}</td>
        <td>${foremanBadge}</td>
        <td>${escHtml(w.phone ?? '—')}</td>
        <td>
          <button class="wm-edit-btn btn btn-sm" data-id="${w.id}">編集</button>
        </td>
      </tr>`;
  }).join('');

  let cryptoBanner;
  if (!cryptoEnabled()) {
    cryptoBanner = `
      <div class="wm-crypto-banner">
        ⚠ 電話番号は暗号化されずに保存されています
        <button class="btn btn-sm" id="wm-crypto-enable-btn">🔐 E2E暗号化を有効にする</button>
      </div>`;
  } else if (!_cryptoUnlocked) {
    cryptoBanner = `
      <div class="wm-crypto-banner">
        🔒 電話番号は暗号化されています（表示・編集にはパスフレーズが必要）
        <button class="btn btn-sm" id="wm-crypto-unlock-btn">復号する</button>
      </div>`;
  } else {
    cryptoBanner = `
      <div class="wm-crypto-banner wm-crypto-ok">
        🔓 E2E暗号化: 有効（このタブで復号中。サーバには暗号文のみ保存されます）
      </div>`;
  }

  root.innerHTML = `
    <div class="wm-page">
      <div class="wm-header">
        <h2 class="wm-title">作業者管理</h2>
        <button class="btn btn-primary" id="wm-add-btn">＋ 追加</button>
      </div>
      ${cryptoBanner}
      <table class="wm-table">
        <thead>
          <tr>
            <th>社員ID</th><th>苗字</th><th>名前</th><th>職長</th><th>電話</th>
            <th class="wm-th-qr">
              <button class="wm-qr-icon-btn" id="wm-qr-print-btn" title="QRシート印刷（全員）">🖨</button>
            </th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="wm-modal-overlay" id="wm-overlay" style="display:none">
      <div class="wm-modal" id="wm-modal"></div>
    </div>`;

  document.getElementById('wm-crypto-enable-btn')?.addEventListener('click', enableCrypto);
  document.getElementById('wm-crypto-unlock-btn')?.addEventListener('click', unlockCrypto);

  // 暗号化有効かつ未復号のまま編集すると、見えない電話番号を null で上書きして
  // しまうため、編集・追加の前にアンロックを要求する
  const guardUnlock = async () => {
    if (cryptoEnabled() && !_cryptoUnlocked) return unlockCrypto();
    return true;
  };

  document.getElementById('wm-add-btn').addEventListener('click', async () => {
    if (await guardUnlock()) openModal(null);
  });
  document.getElementById('wm-qr-print-btn').addEventListener('click', () => {
    window.open('/static/qr-print.html', '_blank');
  });
  root.querySelectorAll('.wm-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await guardUnlock()) return;
      const w = _workers.find(w => w.id === parseInt(btn.dataset.id, 10));
      if (w) openModal(w);
    });
  });
}

// ─── Modal ───────────────────────────────────────────────────
function openModal(worker) {
  _editId = worker?.id ?? null;
  const isNew = _editId === null;
  const overlay = document.getElementById('wm-overlay');
  const modal   = document.getElementById('wm-modal');

  modal.innerHTML = `
    <div class="wm-modal-header">
      <span>${isNew ? '作業者を追加' : '作業者を編集'}</span>
      <button class="wm-modal-close" id="wm-close">✕</button>
    </div>
    <div class="wm-modal-body">
      <div class="wm-field">
        <label>社員ID <span class="wm-required">*</span></label>
        <input id="wm-empid" class="form-control" type="text"
          value="${escHtml(worker?.employee_id ?? '')}"
          ${isNew ? '' : 'readonly'}>
      </div>
      <div class="wm-field wm-field-row">
        <div class="wm-field">
          <label>苗字 <span class="wm-required">*</span></label>
          <input id="wm-last" class="form-control" type="text"
            value="${escHtml(worker?.last_name ?? '')}">
        </div>
        <div class="wm-field">
          <label>名前 <span class="wm-required">*</span></label>
          <input id="wm-first" class="form-control" type="text"
            value="${escHtml(worker?.first_name ?? '')}">
        </div>
      </div>
      <div class="wm-field">
        <label>電話番号</label>
        <input id="wm-phone" class="form-control" type="tel"
          value="${escHtml(worker?.phone ?? '')}" placeholder="例: 090-1234-5678">
      </div>
      <div class="wm-field">
        <label>${isNew ? 'パスワード' : 'パスワード変更（空欄で変更なし）'}
          ${isNew ? '<span class="wm-required">*</span>' : ''}
        </label>
        <input id="wm-pw" class="form-control" type="password"
          placeholder="${isNew ? 'パスワードを入力' : '変更する場合のみ入力'}">
      </div>
      <div class="wm-field">
        <label class="wm-check-label">
          <input type="checkbox" id="wm-foreman"
            ${worker?.is_foreman_qualified ? 'checked' : ''}>
          職長資格あり
        </label>
      </div>
      ${!isNew ? `
      <div class="wm-field wm-qr-section">
        <label>QRコードログイン</label>
        <div class="wm-qr-btns">
          <button class="btn btn-sm btn-secondary" id="wm-print-qr-btn" type="button">🖨 個別QR印刷</button>
          <button class="btn btn-sm btn-secondary" id="wm-regen-qr-btn" type="button">QRトークンを再発行する</button>
        </div>
        <div class="wm-qr-note">※再発行すると現在のQRコードが無効になります</div>
        <div class="wm-qr-msg" id="wm-qr-msg" style="display:none"></div>
      </div>` : ''}
      <div class="wm-error" id="wm-err" style="display:none"></div>
    </div>
    <div class="wm-modal-footer">
      <button class="wm-cancel btn" id="wm-cancel-btn">キャンセル</button>
      <button class="btn btn-primary" id="wm-save-btn">保存</button>
    </div>`;

  overlay.style.display = 'flex';

  document.getElementById('wm-close').addEventListener('click', closeModal);
  document.getElementById('wm-cancel-btn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.getElementById('wm-save-btn').addEventListener('click', saveWorker);

  if (!isNew) {
    document.getElementById('wm-print-qr-btn')?.addEventListener('click', () => {
      window.open('/static/qr-print.html?id=' + _editId, '_blank');
    });

    document.getElementById('wm-regen-qr-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('wm-regen-qr-btn');
      const msg = document.getElementById('wm-qr-msg');
      if (!confirm('QRトークンを再発行しますか？\n現在のQRコードが無効になります。')) return;
      btn.disabled = true;
      btn.textContent = '再発行中…';
      msg.style.display = 'none';
      try {
        await apiRegenerateQR(_editId);
        msg.textContent = '再発行しました。QRシート印刷から新しいQRコードを印刷してください。';
        msg.style.color = 'green';
        msg.style.display = 'block';
        btn.textContent = '再発行完了';
      } catch (e) {
        msg.textContent = '再発行に失敗しました: ' + e.message;
        msg.style.color = 'red';
        msg.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'QRトークンを再発行する';
      }
    });
  }
}

function closeModal() {
  document.getElementById('wm-overlay').style.display = 'none';
}

async function saveWorker() {
  const empId    = document.getElementById('wm-empid').value.trim();
  const lastName  = document.getElementById('wm-last').value.trim();
  const firstName = document.getElementById('wm-first').value.trim();
  let   phone     = document.getElementById('wm-phone').value.trim() || null;
  const password  = document.getElementById('wm-pw').value;
  const errEl     = document.getElementById('wm-err');
  const saveBtn   = document.getElementById('wm-save-btn');
  const isNew     = _editId === null;

  if (!lastName || !firstName || (isNew && (!empId || !password))) {
    errEl.textContent = isNew
      ? '社員ID・苗字・名前・パスワードは必須です'
      : '苗字・名前は必須です';
    errEl.style.display = 'block';
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = '保存中…';
  errEl.style.display = 'none';

  try {
    // E2E暗号化が有効なら電話番号を暗号化して送信（サーバには暗号文のみ渡る）
    if (phone && cryptoEnabled()) {
      phone = await encryptValue(phone);
    }
    const isForemanQualified = document.getElementById('wm-foreman')?.checked ?? false;
    const data = {
      employee_id: empId, last_name: lastName, first_name: firstName,
      phone, is_foreman_qualified: isForemanQualified,
    };
    if (password) data.password = password;

    if (isNew) {
      await apiCreateWorker(data);
    } else {
      await apiUpdateWorker(_editId, data);
    }

    _workers = await apiGetWorkers().catch(() => []) ?? [];
    closeModal();
    const root = document.getElementById('workers-root');
    if (root) render(root);
  } catch (err) {
    errEl.textContent    = err.message;
    errEl.style.display  = 'block';
    saveBtn.disabled     = false;
    saveBtn.textContent  = '保存';
  }
}
