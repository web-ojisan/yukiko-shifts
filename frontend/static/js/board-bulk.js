// board-bulk.js — 一括アサインモーダル
// 現場×日付に対して複数作業者を一括設定するモーダル

import { apiCreateAssign, apiDeleteAssign } from './api.js';
import { escHtml } from './util.js';
import { showToast } from './toast.js';
import { parseWorkDate, fmtDateJa } from './dates.js';
import { st, SLOT_CLS } from './board-state.js';
import { loadBoard, renderAll } from './board.js';

let _bulkSlot     = 'AM';
let _bulkSelected = new Set(); // 選択中の userId

// 指定セルの現在のアサイン一覧を返す
function cellAssigns(siteId, date) {
  return st.assignments.filter(a =>
    Number(a.site_id) === Number(siteId) && parseWorkDate(a.work_date) === date
  );
}

// モーダルのメインコンテンツ HTML を組み立てる（再描画にも使用）
function buildBulkBody(siteId, date) {
  const current = cellAssigns(siteId, date);
  const assignedIds = new Set(current.map(a => Number(a.user_id)));

  // 現在のアサイン
  const workerPhoneMap = Object.fromEntries(
    st.workers.map(w => [w.id, w.phone ?? null])
  );
  const currentHTML = current.length === 0
    ? `<p class="bulk-empty">まだアサインがありません</p>`
    : current.map(a => {
        const name  = escHtml(st.workerDispMap[a.user_id] ?? a.user_name ?? `ID:${a.user_id}`);
        const cls   = SLOT_CLS[a.time_slot] ?? 'badge-am';
        const phone = workerPhoneMap[a.user_id];
        const phoneHTML = phone
          ? `<a class="bulk-assign-phone" href="tel:${escHtml(phone)}">${escHtml(phone)}</a>`
          : '';
        return `
          <div class="bulk-assign-row">
            <span class="badge ${cls} bulk-badge">${a.time_slot}</span>
            <span class="bulk-assign-name">${name}</span>
            ${phoneHTML}
            <button class="bulk-del" data-assign-id="${a.id}" title="削除">×</button>
          </div>`;
      }).join('');

  // 追加できる作業者（いずれかのスロットでアサイン済みの人を除く）
  const available = st.workers.filter(w => !assignedIds.has(Number(w.id)));

  // 選択中 ID を available に限定してクリーンアップ
  const availIds = new Set(available.map(w => w.id));
  for (const id of _bulkSelected) {
    if (!availIds.has(id)) _bulkSelected.delete(id);
  }

  const selCount = _bulkSelected.size;

  const chipsHTML = available.length === 0
    ? `<p class="bulk-empty">全員アサイン済みです</p>`
    : available.map(w => {
        const name = escHtml(st.workerDispMap[w.id] ?? w.name);
        const qual = st.foremanQualSet.has(w.id)
          ? `<span class="chip-qual">★</span>` : '';
        const sel  = _bulkSelected.has(w.id) ? ' selected' : '';
        return `<span class="bulk-chip${sel}" data-uid="${w.id}" data-name="${name}">${qual}${name}</span>`;
      }).join('');

  const slotBtns = ['AM', 'PM', 'ALL'].map(s =>
    `<button class="slot-opt${s === _bulkSlot ? ' active' : ''}" data-slot="${s}">${s}</button>`
  ).join('');

  return `
    <div class="bulk-section">
      <div class="bulk-section-label">現在のアサイン</div>
      <div class="bulk-current-list" id="bulk-current">${currentHTML}</div>
    </div>
    <div class="bulk-section">
      <div class="bulk-section-label">
        作業者を追加
        <span class="bulk-sel-count${selCount > 0 ? ' visible' : ''}" id="bulk-sel-count">
          ${selCount}名選択中
        </span>
      </div>
      <div class="bulk-slot-row">
        <span class="bulk-slot-label">時間帯</span>
        <div class="slot-group" id="bulk-slot-group">${slotBtns}</div>
      </div>
      <div class="bulk-search-wrap">
        <input type="text" class="bulk-search" id="bulk-search"
               placeholder="名前で絞り込み…" autocomplete="off">
      </div>
      <div class="bulk-chip-cloud" id="bulk-chip-cloud">${chipsHTML}</div>
    </div>
    <div class="modal-error" id="bulk-err"></div>`;
}

export function openBulkModal(siteId, date) {
  document.getElementById('bulk-modal')?.remove();
  _bulkSelected = new Set(); // モーダルを開くたびにリセット

  const siteName = st.siteMap[siteId] ?? `現場#${siteId}`;

  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'bulk-modal';
  el.innerHTML = `
    <div class="modal bulk-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title">${escHtml(siteName)}</span>
        <span class="bulk-modal-date">${fmtDateJa(date)}</span>
        <button class="modal-close" id="bulk-close">×</button>
      </div>
      <div class="modal-body" id="bulk-body">
        ${buildBulkBody(siteId, date)}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bulk-cancel">閉じる</button>
        <button class="btn btn-primary" id="bulk-submit">追加</button>
      </div>
    </div>`;

  document.body.appendChild(el);
  bindBulkModal(el, siteId, date, siteName);
}

function bindBulkModal(el, siteId, date, siteName) {
  const close = () => { el.remove(); };

  el.querySelector('#bulk-close').addEventListener('click', close);
  el.querySelector('#bulk-cancel').addEventListener('click', close);
  el.addEventListener('click', e => { if (e.target === el) close(); });

  // 時間帯切替
  el.querySelectorAll('.slot-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      _bulkSlot = btn.dataset.slot;
      el.querySelectorAll('.slot-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  bindBulkDeletes(el, siteId, date, siteName);
  bindBulkChips(el);
  el.querySelector('#bulk-submit').addEventListener('click', () =>
    bulkSubmit(el, siteId, date, siteName));
}

// チップ選択 & 検索フィルターのバインド（再描画後も呼ばれる）
function bindBulkChips(el) {
  // ライブ検索: data-name属性でフィルタリング（★は除外）
  el.querySelector('#bulk-search')?.addEventListener('input', e => {
    const q = e.target.value.trim();
    el.querySelectorAll('.bulk-chip').forEach(chip => {
      const match = !q || chip.dataset.name.includes(q);
      chip.style.display = match ? '' : 'none';
    });
  });

  // チップクリックでトグル選択
  el.querySelectorAll('.bulk-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const uid = Number(chip.dataset.uid);
      if (_bulkSelected.has(uid)) {
        _bulkSelected.delete(uid);
        chip.classList.remove('selected');
      } else {
        _bulkSelected.add(uid);
        chip.classList.add('selected');
      }
      // カウント更新
      const countEl = el.querySelector('#bulk-sel-count');
      if (countEl) {
        countEl.textContent = `${_bulkSelected.size}名選択中`;
        countEl.classList.toggle('visible', _bulkSelected.size > 0);
      }
      // 追加ボタンのテキスト更新
      const submitBtn = el.querySelector('#bulk-submit');
      if (submitBtn) {
        submitBtn.textContent = _bulkSelected.size > 0
          ? `${_bulkSelected.size}名を追加` : '追加';
      }
    });
  });
}

// 個別削除ボタンのバインド（再描画後も呼ばれる）
function bindBulkDeletes(el, siteId, date, siteName) {
  el.querySelectorAll('.bulk-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.assignId);
      btn.disabled = true;
      try {
        await apiDeleteAssign(id);
        st.assignments = st.assignments.filter(a => a.id !== id);
        refreshBulkBody(el, siteId, date, siteName);
        renderAll();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

// モーダルのボディのみ再描画（_bulkSelected は維持）
function refreshBulkBody(el, siteId, date, siteName) {
  el.querySelector('#bulk-body').innerHTML = buildBulkBody(siteId, date);
  el.querySelectorAll('.slot-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      _bulkSlot = btn.dataset.slot;
      el.querySelectorAll('.slot-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  bindBulkDeletes(el, siteId, date, siteName);
  bindBulkChips(el);
  // ボタンテキストを選択数に合わせて更新
  const submitBtn = el.querySelector('#bulk-submit');
  if (submitBtn) {
    submitBtn.textContent = _bulkSelected.size > 0
      ? `${_bulkSelected.size}名を追加` : '追加';
    submitBtn.addEventListener('click', () => bulkSubmit(el, siteId, date, siteName));
  }
}

async function bulkSubmit(el, siteId, date, siteName) {
  const errEl     = el.querySelector('#bulk-err');
  const submitBtn = el.querySelector('#bulk-submit');

  if (_bulkSelected.size === 0) {
    errEl.textContent = '作業者を1人以上選んでください';
    errEl.classList.add('visible');
    return;
  }

  submitBtn.disabled    = true;
  submitBtn.textContent = '追加中…';
  errEl.classList.remove('visible');

  const results = await Promise.allSettled(
    [..._bulkSelected].map(uid => apiCreateAssign(Number(siteId), date, uid, _bulkSlot))
  );

  const failed  = results.filter(r => r.status === 'rejected');
  const success = results.filter(r => r.status === 'fulfilled').length;

  if (failed.length > 0) {
    errEl.textContent = failed.map(r => r.reason.message).join(' / ');
    errEl.classList.add('visible');
  }
  if (success > 0) {
    _bulkSelected = new Set(); // 追加完了後はリセット
    showToast(`${success}名を追加しました`, 'success');
    await loadBoard({ silent: true });
    refreshBulkBody(el, siteId, date, siteName);
  }

  submitBtn.disabled    = false;
  submitBtn.textContent = '選択した作業者を追加';
}
