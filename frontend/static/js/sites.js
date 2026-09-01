// sites.js — 現場マスタ CRUD 画面

import { apiGetSites, apiCreateSite, apiUpdateSite,
         apiGetForemanPriorities, apiSetForemanPriorities, apiGetWorkers } from './api.js';

// ─── State ───────────────────────────────────────────────────
const st = {
  sites: [],
  foremanPriorityMap: {}, // { siteId: [ForemanPriority] }
  loading: false,
};

// ─── Utilities ──────────────────────────────────────────────
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDate(isoOrDate) {
  if (!isoOrDate) return '';
  const s = String(isoOrDate).substring(0, 10); // YYYY-MM-DD
  if (!s || s === 'null') return '';
  const [y, m, d] = s.split('-');
  return `${y}/${parseInt(m)}/${parseInt(d)}`;
}

export function fmtBudget(yen) {
  if (yen == null) return '';
  return Number(yen).toLocaleString('ja-JP') + '円';
}

export function statusLabel(status) {
  return { active: '稼働中', completed: '完了', deleted: '削除' }[status] ?? status;
}

export function statusClass(status) {
  return { active: 'badge-status-active', completed: 'badge-status-done' }[status] ?? '';
}

// ─── Load ────────────────────────────────────────────────────
async function loadSites() {
  st.loading = true;
  render();
  try {
    st.sites = await apiGetSites() ?? [];
    // 全現場の職長優先順位を並行取得
    const results = await Promise.allSettled(
      st.sites.map(s => apiGetForemanPriorities(s.id))
    );
    st.foremanPriorityMap = {};
    st.sites.forEach((s, i) => {
      st.foremanPriorityMap[s.id] = results[i].status === 'fulfilled'
        ? (results[i].value ?? []) : [];
    });
  } catch (e) {
    showToast('データ取得エラー: ' + e.message, 'error');
    st.sites = [];
  }
  st.loading = false;
  render();
}

// 職長設定列の表示テキスト生成
function fmtForemanPriority(priorities) {
  if (!priorities || priorities.length === 0) {
    return `<span class="fp-unset">未設定</span>`;
  }
  const first = escHtml(priorities[0].user_name ?? '—');
  if (priorities.length === 1) {
    return `<span class="fp-name">${first}</span>`;
  }
  return `<span class="fp-name">${first}</span><span class="fp-extra">…他${priorities.length - 1}名</span>`;
}

// ─── Render ─────────────────────────────────────────────────
function render() {
  const root = document.getElementById('sites-root');
  if (!root) return;

  if (st.loading) {
    root.innerHTML = `
      <div class="page-header">
        <h2 class="page-title">現場マスタ</h2>
      </div>
      <div class="loading-screen"><div class="spinner"></div></div>`;
    return;
  }

  const rows = st.sites.length === 0
    ? `<tr><td colspan="8">
        <div class="empty-state">
          <div class="empty-state-icon">🏗</div>
          <h2>現場データがありません</h2>
          <p>「＋ 新規登録」ボタンから現場を追加してください</p>
        </div>
       </td></tr>`
    : st.sites.map(site => `
        <tr>
          <td class="td-name">
            <span class="site-row-name">${escHtml(site.name)}</span>
            ${site.note ? `<span class="site-row-note">${escHtml(site.note)}</span>` : ''}
          </td>
          <td>${escHtml(site.client ?? '—')}</td>
          <td class="td-address">${escHtml(site.address ?? '—')}</td>
          <td class="td-date">${fmtDate(site.start_date)}</td>
          <td class="td-date">${fmtDate(site.end_date)}</td>
          <td class="td-budget">${fmtBudget(site.budget_yen)}</td>
          <td class="td-foreman">${fmtForemanPriority(st.foremanPriorityMap[site.id])}</td>
          <td class="td-status">
            <span class="badge-status ${statusClass(site.status)}">${statusLabel(site.status)}</span>
          </td>
          <td class="td-actions">
            <button class="btn-row-action" data-id="${site.id}" title="編集">編集</button>
          </td>
        </tr>`
      ).join('');

  root.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">現場マスタ</h2>
      <button class="btn btn-primary btn-new" id="btn-new-site" style="width:auto">
        ＋ 新規登録
      </button>
    </div>
    <div class="sites-table-wrap">
      <table class="sites-table">
        <thead>
          <tr>
            <th>現場名</th>
            <th>元請</th>
            <th>住所</th>
            <th>開始日</th>
            <th>終了日</th>
            <th>予算</th>
            <th>職長設定</th>
            <th>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById('btn-new-site')?.addEventListener('click', () => openModal(null));

  document.querySelectorAll('.btn-row-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const site = st.sites.find(s => s.id === Number(btn.dataset.id));
      if (site) openModal(site);
    });
  });
}

// ─── Modal ───────────────────────────────────────────────────
function openModal(site) {
  const isEdit = site != null;
  const title = isEdit ? '現場を編集' : '現場を新規登録';

  // date fields: backend returns ISO "2026-05-01T00:00:00Z", input[type=date] needs "YYYY-MM-DD"
  const toDateInput = (v) => v ? String(v).substring(0, 10) : '';

  const statusOpts = ['active', 'completed'].map(s =>
    `<option value="${s}" ${(site?.status ?? 'active') === s ? 'selected' : ''}>${statusLabel(s)}</option>`
  ).join('');

  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'site-modal';
  el.innerHTML = `
    <div class="modal modal-lg" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title">${title}</span>
        <button class="modal-close" id="sm-close">×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-group form-col-full">
            <label>現場名 <span class="required">*</span></label>
            <input type="text" class="form-control" id="sm-name"
              value="${escHtml(site?.name ?? '')}" placeholder="例: トヨタ分室" maxlength="100">
          </div>
          <div class="form-group">
            <label>元請会社</label>
            <input type="text" class="form-control" id="sm-client"
              value="${escHtml(site?.client ?? '')}" placeholder="例: トヨタ自動車">
          </div>
          <div class="form-group">
            <label>住所</label>
            <input type="text" class="form-control" id="sm-address"
              value="${escHtml(site?.address ?? '')}" placeholder="例: 愛知県豊田市">
          </div>
          <div class="form-group">
            <label>開始日</label>
            <input type="date" class="form-control" id="sm-start"
              value="${toDateInput(site?.start_date)}">
          </div>
          <div class="form-group">
            <label>終了日</label>
            <input type="date" class="form-control" id="sm-end"
              value="${toDateInput(site?.end_date)}">
          </div>
          <div class="form-group">
            <label>予算（円）</label>
            <input type="number" class="form-control" id="sm-budget"
              value="${site?.budget_yen ?? ''}" placeholder="例: 5000000" min="0">
          </div>
          <div class="form-group">
            <label>状態</label>
            <select class="form-select" id="sm-status">${statusOpts}</select>
          </div>
          <div class="form-group form-col-full">
            <label>備考</label>
            <textarea class="form-control" id="sm-note" rows="3"
              placeholder="補足情報があれば入力">${escHtml(site?.note ?? '')}</textarea>
          </div>
          ${isEdit ? `
          <div class="form-group form-col-full">
            <label>職長優先順位 <span class="sm-hint">（1位が最優先で自動アサイン）</span></label>
            <div id="sm-foreman-section">
              <div class="sm-fp-loading">読み込み中…</div>
            </div>
          </div>` : ''}
        </div>
        <div class="modal-error" id="sm-err"></div>
      </div>
      <div class="modal-footer">
        ${isEdit ? `<button class="btn btn-secondary btn-status-toggle" id="sm-toggle-status"
          data-current="${site.status}">
          ${site.status === 'active' ? '完了にする' : '稼働中に戻す'}
        </button>` : ''}
        <div style="flex:1"></div>
        <button class="btn btn-secondary" id="sm-cancel">キャンセル</button>
        <button class="btn btn-primary" id="sm-submit" style="width:auto">
          ${isEdit ? '更新する' : '登録する'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(el);

  const close = () => { document.getElementById('site-modal')?.remove(); };

  el.querySelector('#sm-close').addEventListener('click', close);
  el.querySelector('#sm-cancel').addEventListener('click', close);
  el.addEventListener('click', e => { if (e.target === el) close(); });

  el.querySelector('#sm-submit').addEventListener('click', () => submitModal(site?.id ?? null, close));

  el.querySelector('#sm-toggle-status')?.addEventListener('click', async () => {
    const newStatus = site.status === 'active' ? 'completed' : 'active';
    try {
      await apiUpdateSite(site.id, { ...buildPayload(), status: newStatus });
      close();
      showToast('ステータスを更新しました', 'success');
      loadSites();
    } catch (e) {
      document.getElementById('sm-err').textContent = e.message;
      document.getElementById('sm-err').classList.add('visible');
    }
  });

  document.getElementById('sm-name').focus();

  // 編集モーダルの場合: 職長優先順位セクションを非同期ロード
  if (isEdit) {
    loadForemanPriorities(site.id);
  }
}

// ─── Foreman Priority Section ────────────────────────────────
async function loadForemanPriorities(siteId) {
  const sec = document.getElementById('sm-foreman-section');
  if (!sec) return;

  try {
    const [priorities, workers] = await Promise.all([
      apiGetForemanPriorities(siteId).catch(() => []),
      apiGetWorkers().catch(() => []),
    ]);

    // 職長資格ありの作業者だけ対象
    const qualified = (workers ?? []).filter(w => w.is_foreman_qualified);
    const priorityUserIds = new Set((priorities ?? []).map(p => p.user_id));
    const available = qualified.filter(w => !priorityUserIds.has(w.id));

    renderForemanSection(sec, siteId, priorities ?? [], available);
  } catch (e) {
    sec.innerHTML = `<p class="sm-fp-error">読み込みエラー: ${escHtml(e.message)}</p>`;
  }
}

function renderForemanSection(sec, siteId, priorities, available) {
  const listHTML = priorities.length === 0
    ? `<p class="sm-fp-empty">優先順位未設定</p>`
    : priorities.map((p, i) => `
        <div class="sm-fp-row" data-user-id="${p.user_id}">
          <span class="sm-fp-rank">${i + 1}</span>
          <span class="sm-fp-name">${escHtml(p.user_name || `ID:${p.user_id}`)}</span>
          <div class="sm-fp-actions">
            ${i > 0
              ? `<button class="sm-fp-btn" data-action="up" data-idx="${i}" title="優先度を上げる">↑</button>`
              : '<span class="sm-fp-btn-placeholder"></span>'}
            ${i < priorities.length - 1
              ? `<button class="sm-fp-btn" data-action="down" data-idx="${i}" title="優先度を下げる">↓</button>`
              : '<span class="sm-fp-btn-placeholder"></span>'}
            <button class="sm-fp-btn sm-fp-remove" data-action="remove" data-idx="${i}" title="削除">×</button>
          </div>
        </div>`).join('');

  const addHTML = available.length > 0 ? `
    <div class="sm-fp-add-row">
      <select class="form-select sm-fp-select" id="sm-fp-add-sel">
        <option value="">— 追加する職長を選択 —</option>
        ${available.map(w => `<option value="${w.id}">${escHtml(w.last_name && w.first_name ? w.last_name + ' ' + w.first_name : w.name)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-secondary" id="sm-fp-add-btn">追加</button>
    </div>` : '';

  sec.innerHTML = `
    <div class="sm-fp-list" id="sm-fp-list">${listHTML}</div>
    ${addHTML}
    <div class="sm-fp-footer">
      <button class="btn btn-sm btn-primary" id="sm-fp-save">職長優先順位を保存</button>
    </div>`;

  // up/down/remove ボタン
  sec.querySelectorAll('.sm-fp-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const idx    = Number(btn.dataset.idx);
      if (action === 'up' && idx > 0) {
        [priorities[idx - 1], priorities[idx]] = [priorities[idx], priorities[idx - 1]];
      } else if (action === 'down' && idx < priorities.length - 1) {
        [priorities[idx], priorities[idx + 1]] = [priorities[idx + 1], priorities[idx]];
      } else if (action === 'remove') {
        const removed = priorities.splice(idx, 1)[0];
        available.push({ id: removed.user_id, name: removed.user_name });
      }
      renderForemanSection(sec, siteId, priorities, available);
    });
  });

  // 追加ボタン
  document.getElementById('sm-fp-add-btn')?.addEventListener('click', () => {
    const sel = document.getElementById('sm-fp-add-sel');
    const uid = Number(sel.value);
    if (!uid) return;
    const w = available.find(w => w.id === uid);
    if (!w) return;
    priorities.push({ user_id: uid, user_name: w.name || w.last_name || '' });
    available.splice(available.indexOf(w), 1);
    renderForemanSection(sec, siteId, priorities, available);
  });

  // 保存ボタン
  document.getElementById('sm-fp-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('sm-fp-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await apiSetForemanPriorities(siteId, priorities.map((p, i) => ({
        user_id: p.user_id, priority_order: i,
      })));
      // 一覧の職長設定列をリアルタイム更新
      st.foremanPriorityMap[siteId] = priorities;
      render();
      showToast('職長優先順位を保存しました', 'success');
    } catch (e) {
      showToast('保存エラー: ' + e.message, 'error');
    }
    saveBtn.disabled = false;
    saveBtn.textContent = '職長優先順位を保存';
  });
}

// フォーム値からAPIペイロードを組み立てる（純粋ロジック部・テスト対象）
export function buildSitePayload({ name, client, address, start_date, end_date, budget_yen, note, status }) {
  const opt = v => (v == null || v === '' ? null : v);
  return {
    name:       name ?? '',
    client:     opt(client),
    address:    opt(address),
    start_date: opt(start_date),
    end_date:   opt(end_date),
    budget_yen: budget_yen == null || budget_yen === '' ? null : parseInt(budget_yen, 10),
    note:       opt(note),
    status:     status || 'active',
  };
}

function buildPayload() {
  const val = id => document.getElementById(id)?.value.trim() ?? '';
  return buildSitePayload({
    name:       val('sm-name'),
    client:     val('sm-client'),
    address:    val('sm-address'),
    start_date: val('sm-start'),
    end_date:   val('sm-end'),
    budget_yen: val('sm-budget'),
    note:       val('sm-note'),
    status:     val('sm-status'),
  });
}

async function submitModal(siteId, close) {
  const errEl = document.getElementById('sm-err');
  const submitBtn = document.getElementById('sm-submit');
  errEl.classList.remove('visible');

  const payload = buildPayload();
  if (!payload.name) {
    errEl.textContent = '現場名は必須です';
    errEl.classList.add('visible');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '保存中…';

  try {
    if (siteId) {
      await apiUpdateSite(siteId, payload);
      showToast('現場情報を更新しました', 'success');
    } else {
      await apiCreateSite(payload);
      showToast('現場を登録しました', 'success');
    }
    close();
    loadSites();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.add('visible');
    submitBtn.disabled = false;
    submitBtn.textContent = siteId ? '更新する' : '登録する';
  }
}

// ─── Toast (shared) ───────────────────────────────────────────
function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '⚠'}</span>
    <span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ─── Init ─────────────────────────────────────────────────────
export function initSites() {
  loadSites();
}
