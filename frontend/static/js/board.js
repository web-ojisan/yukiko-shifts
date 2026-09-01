// board.js — 管理者シフトボード（司令塔）
// データ取得・全体描画・イベントバインドを担う。
// 描画は board-views.js、状態は board-state.js、
// モーダルは board-bulk.js / board-foreman.js に分離。

import { apiGetBoard, apiGetSites, apiCreateAssign, apiDeleteAssign,
         apiGetLockStatus, apiUnlockMonth, apiGetWorkers,
         apiGetForemanAssignments } from './api.js';
import { escHtml } from './util.js';
import { showToast } from './toast.js';
import { fmtDate, parseWorkDate, getWeekDates, DOW_JA } from './dates.js';
import { st, buildMaps, buildWorkerDisplayNames } from './board-state.js';
import { renderKanban, renderWeekTable, renderToolbar } from './board-views.js';
import { openBulkModal } from './board-bulk.js';
import { openForemanLockModal, openForemanPopover } from './board-foreman.js';

// DnD 転送中の情報
let _drag = null; // { assignId, userId, slot, fromSiteId, fromDate }

// ─── Load ────────────────────────────────────────────────────
// silent: true のときはローディングスピナーを出さずにデータだけ更新する
export async function loadBoard({ silent = false } = {}) {
  if (!silent) {
    st.loading = true;
    renderAll();
  }

  let from, to;
  if (st.viewMode === 'week') {
    const dates = getWeekDates(st.currentDate);
    from = fmtDate(dates[0]);
    to   = fmtDate(dates[6]);
  } else {
    from = to = fmtDate(st.currentDate);
  }

  // ロック対象の年月（1日表示なら当月、週表示なら開始週の月）
  const lockY = st.viewMode === 'week'
    ? getWeekDates(st.currentDate)[0].getFullYear()
    : st.currentDate.getFullYear();
  const lockM = st.viewMode === 'week'
    ? getWeekDates(st.currentDate)[0].getMonth() + 1
    : st.currentDate.getMonth() + 1;

  try {
    const [assignments, sites, lockData, workers, foremanAssigns] = await Promise.all([
      apiGetBoard(from, to),
      apiGetSites().catch(() => []),
      apiGetLockStatus(lockY, lockM).catch(() => ({ locked: false })),
      apiGetWorkers().catch(() => []),
      apiGetForemanAssignments(from, to).catch(() => []),
    ]);
    st.assignments = assignments ?? [];
    st.siteList    = sites ?? [];
    st.locked      = lockData?.locked ?? false;
    buildMaps(st.assignments);
    for (const s of st.siteList) {
      if (s.id) st.siteMap[s.id] = s.name;
    }
    // 作業者マスタから workerMap / workerDispMap を構築
    st.workers = workers ?? [];
    for (const w of st.workers) {
      if (w.id) st.workerMap[w.id] = w.last_name && w.first_name
        ? w.last_name + ' ' + w.first_name
        : w.name;
    }
    st.workerDispMap = buildWorkerDisplayNames(st.workers);
    // 職長資格セット構築
    st.foremanQualSet = new Set(st.workers.filter(w => w.is_foreman_qualified).map(w => w.id));
    // 職長マップ構築
    st.foremanMap = {};
    for (const fa of (foremanAssigns ?? [])) {
      const key = `${fa.site_id}_${String(fa.work_date).substring(0, 10)}`;
      st.foremanMap[key] = fa;
    }
  } catch (e) {
    showToast('データ取得エラー: ' + e.message, 'error');
    st.assignments = [];
  }

  st.loading = false;
  renderAll();
}

// ─── Main Render ─────────────────────────────────────────────
export function renderAll() {
  const root = document.getElementById('board-root');
  if (!root) return;

  if (st.loading) {
    root.innerHTML = `
      ${renderToolbar()}
      <div class="board-container">
        <div class="loading-screen"><div class="spinner"></div></div>
      </div>`;
    bindToolbar();
    return;
  }

  const content = st.viewMode === 'week' ? renderWeekTable() : renderKanban();
  root.innerHTML = `
    ${renderToolbar()}
    <div class="board-container">${content}</div>`;

  bindToolbar();
  bindCells();
  bindDrag();
}

// ─── Toolbar Bind ────────────────────────────────────────────
function bindToolbar() {
  document.getElementById('btn-day')?.addEventListener('click', () => {
    if (st.viewMode === 'day') return;
    st.viewMode = 'day'; loadBoard();
  });
  document.getElementById('btn-week')?.addEventListener('click', () => {
    if (st.viewMode === 'week') return;
    st.viewMode = 'week'; loadBoard();
  });
  document.getElementById('btn-prev')?.addEventListener('click',  () => navDate(-1));
  document.getElementById('btn-next')?.addEventListener('click',  () => navDate(1));
  document.getElementById('btn-today')?.addEventListener('click', () => {
    st.currentDate = new Date(); loadBoard();
  });

  document.getElementById('btn-lock')?.addEventListener('click', async () => {
    const d = st.viewMode === 'week' ? getWeekDates(st.currentDate)[0] : st.currentDate;
    const y = d.getFullYear(), m = d.getMonth() + 1;
    try {
      if (st.locked) {
        if (!confirm(`${y}年${m}月のロックを解除しますか？`)) return;
        await apiUnlockMonth(y, m);
        showToast(`${m}月のロックを解除しました`, 'success');
        loadBoard();
      } else {
        openForemanLockModal(y, m);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function navDate(dir) {
  const d = new Date(st.currentDate);
  d.setDate(d.getDate() + (st.viewMode === 'week' ? 7 : 1) * dir);
  st.currentDate = d;
  loadBoard();
}

// ─── 休み一覧ポップオーバー ──────────────────────────────────
// 週表示の休み行は人数バッジのみ表示するため、クリックで一覧を出す
function openUnassignedPopover(dateStr, triggerEl) {
  document.getElementById('ua-popover')?.remove();

  const assignedIds = new Set(
    st.assignments.filter(a => parseWorkDate(a.work_date) === dateStr).map(a => a.user_id)
  );
  const unassigned = st.workers.filter(w => !assignedIds.has(w.id));

  const chips = unassigned.map(w => {
    const qual = st.foremanQualSet.has(w.id) ? `<span class="ua-qual-badge">★</span>` : '';
    return `<span class="ua-chip">${qual}${escHtml(st.workerDispMap[w.id] ?? w.name)}</span>`;
  }).join('');

  const rect = triggerEl.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 6, window.innerHeight - 240);
  const left = Math.min(rect.left, window.innerWidth - 300);

  const [, m, d] = dateStr.split('-');
  const dow = DOW_JA[new Date(
    Number(dateStr.slice(0, 4)), Number(m) - 1, Number(d)).getDay()];

  const pop = document.createElement('div');
  pop.id = 'ua-popover';
  pop.className = 'ua-popover';
  pop.style.cssText = `top:${top}px;left:${left}px`;
  pop.innerHTML = `
    <div class="fpop-header">
      <span class="fpop-title">${parseInt(m)}/${parseInt(d)}（${dow}）の休み ${unassigned.length}名</span>
      <button class="fpop-close">×</button>
    </div>
    <div class="ua-pop-chips">${chips}</div>`;
  document.body.appendChild(pop);

  const close = () => pop.remove();
  pop.querySelector('.fpop-close').addEventListener('click', close);
  const onOutside = e => {
    if (!pop.contains(e.target) && e.target !== triggerEl) {
      close();
      document.removeEventListener('mousedown', onOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
}

// ─── Cell / Card Bind ────────────────────────────────────────
function bindCells() {
  // 休み人数バッジ → 一覧ポップオーバー（作業者閲覧モードでも使える）
  document.querySelectorAll('.ua-count-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openUnassignedPopover(btn.dataset.date, btn);
    });
  });

  if (st.readOnly) return; // 作業者閲覧モード: 編集操作をすべてスキップ

  // 翌日コピーボタン
  document.querySelectorAll('.btn-copy-date').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      copyDateShifts(btn.dataset.from, btn.dataset.to);
    });
  });

  // ＋ボタン → 一括設定モーダルを開く
  document.querySelectorAll('.btn-add-assign').forEach(btn => {
    btn.addEventListener('click', () =>
      openBulkModal(Number(btn.dataset.site), btn.dataset.date));
  });

  // 週表示バッジ・カンバンカード本体クリック → 同じく一括設定モーダル
  document.querySelectorAll('.week-badge, .kanban-card').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.badge-del, .kcard-del')) return; // 削除ボタンは別処理
      openBulkModal(Number(el.dataset.siteId), el.dataset.date);
    });
  });

  // 職長変更ボタン（カンバン行ヘッダー・週バッジ内）
  document.querySelectorAll('.js-chg-foreman').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openForemanPopover(Number(btn.dataset.siteId), btn.dataset.date, btn);
    });
  });

  // 削除ボタン（バッジ内）
  document.querySelectorAll('.badge-del, .kcard-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (!confirm('このアサインを削除しますか？')) return;
      try {
        await apiDeleteAssign(id);
        showToast('削除しました', 'success');
        await loadBoard({ silent: true });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ─── Drag & Drop ─────────────────────────────────────────────
function bindDrag() {
  if (st.readOnly) return; // 作業者閲覧モード: DnD 無効

  // カンバンカード
  document.querySelectorAll('.kanban-card[draggable]').forEach(card => {
    card.addEventListener('dragstart', e => {
      _drag = {
        assignId:   Number(card.dataset.assignId),
        userId:     Number(card.dataset.userId),
        slot:       card.dataset.slot,
        fromSiteId: Number(card.dataset.siteId),
        fromDate:   card.dataset.date,
      };
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  // 週表示バッジ
  document.querySelectorAll('.week-badge[draggable]').forEach(badge => {
    badge.addEventListener('dragstart', e => {
      _drag = {
        assignId:   Number(badge.dataset.assignId),
        userId:     Number(badge.dataset.userId),
        slot:       badge.dataset.slot,
        fromSiteId: Number(badge.dataset.siteId),
        fromDate:   badge.dataset.date,
      };
      e.dataTransfer.effectAllowed = 'move';
      badge.classList.add('dragging');
    });
    badge.addEventListener('dragend', () => badge.classList.remove('dragging'));
  });

  document.querySelectorAll('.kanban-drop-zone, .week-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => {
      if (!_drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (!_drag) return;

      const toSiteId = Number(zone.dataset.siteId);
      const toDate   = zone.dataset.date;

      if (toSiteId === _drag.fromSiteId && toDate === _drag.fromDate) {
        _drag = null; return;
      }

      const drag = _drag;
      _drag = null;

      try {
        await apiDeleteAssign(drag.assignId);
        await apiCreateAssign(toSiteId, toDate, drag.userId, drag.slot);
        showToast('移動しました', 'success');
        await loadBoard({ silent: true });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ─── Copy Date Shifts ────────────────────────────────────────
async function copyDateShifts(fromDate, toDate) {
  const assigns = st.assignments.filter(a => parseWorkDate(a.work_date) === fromDate);

  if (assigns.length === 0) {
    showToast('コピー元にアサインがありません', 'error');
    return;
  }

  const [fy, fm, fd] = fromDate.split('-');
  const [ty, tm, td] = toDate.split('-');
  const fromDisp = `${parseInt(fm)}/${parseInt(fd)}`;
  const toDisp   = `${parseInt(tm)}/${parseInt(td)}`;

  if (!confirm(`${fromDisp} の全シフト（${assigns.length}件）を ${toDisp} にコピーしますか？`)) return;

  const results = await Promise.allSettled(
    assigns.map(a => apiCreateAssign(a.site_id, toDate, a.user_id, a.time_slot))
  );

  const success = results.filter(r => r.status === 'fulfilled').length;
  const skipped = results.filter(r => r.status === 'rejected').length; // 重複など

  if (success > 0) {
    const msg = skipped > 0
      ? `${success}件コピーしました（${skipped}件は重複のためスキップ）`
      : `${success}件コピーしました`;
    showToast(msg, 'success');
    await loadBoard({ silent: true });
  } else {
    showToast('コピーできませんでした（全件が重複または重複エラー）', 'error');
  }
}

// ─── Init ─────────────────────────────────────────────────────
export function initBoard({ readOnly = false } = {}) {
  st.readOnly = readOnly;
  loadBoard();
}
