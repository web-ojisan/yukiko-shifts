// board.js — 管理者シフトボード

import { apiGetBoard, apiGetSites, apiCreateAssign, apiDeleteAssign,
         apiGetLockStatus, apiLockMonth, apiUnlockMonth, apiGetWorkers,
         apiGetForemanAssignments, apiUpsertForemanAssignment,
         apiDeleteForemanAssignment, apiGetForemanSuggestions } from './api.js';
import { HOLIDAYS } from './holidays.js';

// ─── State ───────────────────────────────────────────────────
const st = {
  viewMode: 'week',
  currentDate: new Date(),
  assignments: [],
  siteList: [],        // GET /api/sites から取得した全現場
  siteMap: {},         // { siteId: siteName }
  workerMap: {},       // { userId: userName (フルネーム) }
  workerDispMap: {},   // { userId: 表示名（苗字 or 苗字+頭文字） }
  workers: [],         // 作業者マスタ全件
  foremanMap: {},      // { "siteId_date": ForemanAssignment }
  foremanQualSet: new Set(), // 職長資格保持者の userId セット
  locked: false,
  loading: false,
  readOnly: false,     // 作業者閲覧モード（編集UI非表示）
};

// ─── Worker Display Names ────────────────────────────────────
// 苗字が重複するときだけ名前の頭1文字を付加する
function buildWorkerDisplayNames(workers) {
  const lastNameCount = {};
  for (const w of workers) {
    const ln = w.last_name || w.name;
    lastNameCount[ln] = (lastNameCount[ln] || 0) + 1;
  }
  const disp = {};
  for (const w of workers) {
    const ln = w.last_name || w.name;
    if (lastNameCount[ln] > 1 && w.first_name) {
      disp[w.id] = ln + w.first_name[0];   // 例: 田中一, 田中二
    } else {
      disp[w.id] = ln;                      // 例: 佐藤
    }
  }
  return disp;
}

// DnD 転送中の情報
let _drag = null; // { assignId, userId, slot, fromSiteId, fromDate }

// ─── Date Utilities ──────────────────────────────────────────
const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function fmtDate(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function parseWorkDate(isoStr) {
  return String(isoStr).substring(0, 10);
}

export function getWeekDates(ref) {
  const day  = ref.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(ref);
  mon.setDate(ref.getDate() + diff);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

function fmtMonthDay(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
function fmtFull(d)     { return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; }

// ─── Utilities ──────────────────────────────────────────────
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Data Grouping ────────────────────────────────────────────
function buildMaps(assignments) {
  for (const a of assignments) {
    if (a.site_id && a.site_name) st.siteMap[a.site_id] = a.site_name;
    if (a.user_id && a.user_name) st.workerMap[a.user_id] = a.user_name;
  }
}

/** 週表示: { siteId: { name, days: { 'YYYY-MM-DD': [assign] } } } */
export function groupWeek(assignments) {
  const g = {};
  for (const a of assignments) {
    const sid  = String(a.site_id);
    const date = parseWorkDate(a.work_date);
    if (!g[sid]) g[sid] = { name: a.site_name ?? `現場#${sid}`, days: {} };
    if (!g[sid].days[date]) g[sid].days[date] = [];
    g[sid].days[date].push(a);
  }
  return g;
}

/** 日表示（カンバン）: { siteId: { name, cards: [assign...] } } */
export function groupDay(assignments, dateStr) {
  const g = {};
  for (const a of assignments) {
    if (parseWorkDate(a.work_date) !== dateStr) continue;
    const sid = String(a.site_id);
    if (!g[sid]) g[sid] = { name: a.site_name ?? `現場#${sid}`, cards: [] };
    g[sid].cards.push(a);
  }
  return g;
}

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

// ─── Card / Badge Renders ────────────────────────────────────
const SLOT_CLS   = { AM: 'badge-am', PM: 'badge-pm', ALL: 'badge-all' };
const SLOT_LABEL = { AM: '前', PM: '後', ALL: '全' };

/** カンバン用カード（1日表示） */
function renderKanbanCard(a) {
  const cls     = SLOT_CLS[a.time_slot] ?? 'badge-am';
  const label   = SLOT_LABEL[a.time_slot] ?? a.time_slot;
  const name    = escHtml(st.workerDispMap[a.user_id] ?? a.user_name ?? `ID:${a.user_id}`);
  const date    = parseWorkDate(a.work_date);
  const isForeman  = st.foremanMap[`${a.site_id}_${date}`]?.user_id === a.user_id;
  const isQualified = st.foremanQualSet.has(a.user_id);
  const delBtn  = st.readOnly ? '' : `<button class="kcard-del" data-id="${a.id}" title="削除">×</button>`;
  return `
    <div class="kanban-card ${cls}${isForeman ? ' is-foreman' : ''}"
         ${st.readOnly ? '' : 'draggable="true"'}
         data-assign-id="${a.id}"
         data-user-id="${a.user_id}"
         data-slot="${a.time_slot}"
         data-site-id="${a.site_id}"
         data-date="${date}">
      <span class="kcard-slot">${label}</span>
      ${isForeman ? '<span class="kcard-foreman-badge">職長</span>' : (isQualified ? '<span class="kcard-qual-badge" title="職長資格あり">★</span>' : '')}
      <span class="kcard-name">${name}</span>
      ${delBtn}
    </div>`;
}

/** 週表示用バッジ（ドラッグ可能） */
function renderWeekBadge(a) {
  const cls      = SLOT_CLS[a.time_slot] ?? 'badge-am';
  const label    = SLOT_LABEL[a.time_slot] ?? a.time_slot;
  const name     = escHtml(st.workerDispMap[a.user_id] ?? a.user_name ?? `ID:${a.user_id}`);
  const date     = parseWorkDate(a.work_date);
  const isForeman   = st.foremanMap[`${a.site_id}_${date}`]?.user_id === a.user_id;
  const isQualified = st.foremanQualSet.has(a.user_id);
  const delBtn   = st.readOnly ? '' : `<button class="badge-del" data-id="${a.id}" title="削除">×</button>`;
  const qualMark = isForeman
    ? (st.readOnly
        ? '<span class="week-foreman-badge">職</span>'
        : `<button class="week-foreman-badge js-chg-foreman" data-site-id="${a.site_id}" data-date="${date}" title="職長を変更">職</button>`)
    : (isQualified ? '<span class="week-qual-badge" title="職長資格あり">★</span>' : '');
  return `
    <span class="badge week-badge ${cls}${isForeman ? ' is-foreman' : ''}"
          ${st.readOnly ? '' : 'draggable="true"'}
          data-assign-id="${a.id}"
          data-user-id="${a.user_id}"
          data-slot="${a.time_slot}"
          data-site-id="${a.site_id}"
          data-date="${date}"
          title="${name}（${a.time_slot}）${isForeman ? '（職長アサイン済み）' : (isQualified ? '（職長資格あり）' : '')}">
      <span class="badge-slot-label">${label}</span>
      ${qualMark}
      ${name}
      ${delBtn}
    </span>`;
}

// ─── Day Kanban ──────────────────────────────────────────────
function renderKanban() {
  const dateStr = fmtDate(st.currentDate);
  const grouped = groupDay(st.assignments, dateStr);

  // 表示する現場: siteList の順を基準に固定し、末尾にアサインのみの現場を追加
  let sites;
  if (st.siteList.length > 0) {
    const withAssign = new Set(Object.keys(grouped).map(Number));
    // siteList 順を優先（active + アサインあり）
    const inList = st.siteList.filter(s => s.status === 'active' || withAssign.has(s.id));
    const inListIds = new Set(inList.map(s => s.id));
    // siteList にない現場（削除済み等）を末尾に追加
    const extra = [...withAssign]
      .filter(id => !inListIds.has(id))
      .map(id => ({ id, name: grouped[String(id)]?.name ?? `現場#${id}` }));
    sites = [...inList, ...extra];
  } else {
    sites = Object.entries(grouped).map(([id, v]) => ({ id: Number(id), name: v.name }));
  }

  if (sites.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h2>この日のシフトデータがありません</h2>
        <p>現場マスタに稼働中の現場を登録してください</p>
      </div>
      ${renderUnassignedKanbanSection(dateStr)}`;
  }

  const cols = sites.map(site => {
    const sid   = String(site.id);
    const group = grouped[sid];
    const cards = group ? group.cards.map(renderKanbanCard).join('') : '';
    const count = group ? group.cards.length : 0;
    const fa    = st.foremanMap[`${sid}_${dateStr}`];
    const foremanRow = st.readOnly ? '' : (() => {
      const fname = fa
        ? escHtml(st.workerDispMap[fa.user_id] ?? fa.user_name ?? '?')
        : null;
      return `<button class="kanban-foreman-row js-chg-foreman"
                      data-site-id="${sid}" data-date="${dateStr}">
        ${fa
          ? `<span class="kfr-label">職長</span><span class="kfr-name">${fname}</span>`
          : `<span class="kfr-unset">＋ 職長を設定</span>`}
      </button>`;
    })();
    const addBtn = st.readOnly ? '' : `
        <div class="kanban-col-footer">
          <button class="btn-add-assign" data-site="${sid}" data-date="${dateStr}"
                  title="アサイン追加">＋ 追加</button>
        </div>`;
    return `
      <div class="kanban-col">
        <div class="kanban-col-header">
          <span class="kanban-col-name">${escHtml(site.name)}</span>
          <span class="kanban-col-count">${count}名</span>
        </div>
        ${foremanRow}
        <div class="${st.readOnly ? 'kanban-drop-zone-ro' : 'kanban-drop-zone'}"
             data-site-id="${sid}" data-date="${dateStr}">
          ${cards}
        </div>
        ${addBtn}
      </div>`;
  }).join('');

  return `<div class="kanban-board">${cols}</div>
${renderUnassignedKanbanSection(dateStr)}`;
}

// ─── Week View ────────────────────────────────────────────────
function renderWeekTable() {
  const dates   = getWeekDates(st.currentDate);
  const today   = fmtDate(new Date());
  const grouped = groupWeek(st.assignments);

  // 週に表示する現場: siteList の順を基準に固定し、末尾にアサインのみの現場を追加
  // ※ grouped を先に入れると DnD 後にアサインの変化でソート順が変わってしまうため
  const siteIdSet = new Set([
    ...st.siteList.filter(s => s.status === 'active').map(s => s.id),
    ...Object.keys(grouped).map(Number),
  ]);
  const siteIds = [...siteIdSet].map(String);

  const thCols = dates.map(d => {
    const ds          = fmtDate(d);
    const dow         = DOW_JA[d.getDay()];
    const holidayName = HOLIDAYS[ds] ?? null;
    const cls         = [
      ds === today     ? 'col-today'   : '',
      d.getDay() === 6 ? 'col-sat'     : '',
      d.getDay() === 0 || holidayName  ? 'col-sun' : '',
      holidayName      ? 'col-holiday' : '',
    ].filter(Boolean).join(' ');
    // 翌日の日付を計算（週の範囲外でも可）
    const nextDay = new Date(d);
    nextDay.setDate(d.getDate() + 1);
    const nextDs = fmtDate(nextDay);
    const copyBtn = (!st.locked && !st.readOnly)
      ? `<button class="btn-copy-date" data-from="${ds}" data-to="${nextDs}"
             title="${fmtMonthDay(d)} のシフトを ${fmtMonthDay(nextDay)} にコピー">翌日→</button>`
      : '';
    return `<th class="${cls}">
      <span class="day-date">${fmtMonthDay(d)}</span>
      <span class="day-dow">（${dow}）</span>
      ${holidayName ? `<span class="day-holiday">${escHtml(holidayName)}</span>` : ''}
      ${copyBtn}
    </th>`;
  }).join('');

  let rows;
  if (siteIds.length === 0) {
    rows = `<tr><td colspan="${dates.length + 1}">
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h2>シフトデータがありません</h2>
        <p>+ ボタンでアサインを追加してください</p>
      </div>
    </td></tr>` + renderUnassignedWeekRow(dates);
  } else {
    rows = siteIds.map(sid => {
      const siteName = st.siteMap[sid] ?? `現場#${sid}`;
      const siteData = grouped[sid];
      const cells = dates.map(d => {
        const ds      = fmtDate(d);
        const assigns = siteData?.days[ds] ?? [];
        const isToday = ds === today;
        const badges  = assigns.map(renderWeekBadge).join('');
        const addBtn  = st.readOnly ? '' : `<button class="btn-add-assign" data-site="${sid}" data-date="${ds}" title="追加">+</button>`;
        return `<td class="${isToday ? 'col-today' : ''}">
          <div class="cell-content ${st.readOnly ? 'week-drop-zone-ro' : 'week-drop-zone'}"
               data-site-id="${sid}" data-date="${ds}">
            ${badges}${addBtn}
          </div>
        </td>`;
      }).join('');
      return `<tr>
        <td>
          <span class="site-cell-name">${escHtml(siteName)}</span>
          <span class="site-cell-id">#${sid}</span>
        </td>
        ${cells}
      </tr>`;
    }).join('') + renderUnassignedWeekRow(dates);
  }

  return `
    <div class="shift-table-wrap">
      <table class="shift-table">
        <thead><tr><th>現場</th>${thCols}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── Toolbar ─────────────────────────────────────────────────
function renderToolbar() {
  let label;
  if (st.viewMode === 'week') {
    const dates = getWeekDates(st.currentDate);
    label = `${dates[0].getFullYear()}年 ${fmtMonthDay(dates[0])}（月）〜 ${fmtMonthDay(dates[6])}（日）`;
  } else {
    const d = st.currentDate;
    label = `${fmtFull(d)}（${DOW_JA[d.getDay()]}）`;
  }
  return `
    <div class="board-toolbar">
      <div class="view-toggle">
        <button id="btn-day"  class="${st.viewMode === 'day'  ? 'active' : ''}">1日表示</button>
        <button id="btn-week" class="${st.viewMode === 'week' ? 'active' : ''}">1週表示</button>
      </div>
      <div class="toolbar-sep"></div>
      <div class="date-nav">
        <button class="btn-icon" id="btn-prev" title="前へ">‹</button>
        <span class="date-label">${label}</span>
        <button class="btn-icon" id="btn-next" title="次へ">›</button>
      </div>
      <button class="btn-today" id="btn-today">今日</button>
      <div class="toolbar-space"></div>
      ${st.readOnly
        ? (st.locked ? `<span class="lock-status-badge">🔒 確定済み</span>` : '')
        : (st.locked
            ? `<button class="btn-lock active" id="btn-lock" title="ロック解除">🔒 確定済み</button>`
            : `<button class="btn-lock" id="btn-lock" title="この月の希望入力を締め切る">🔓 ロック</button>`)
      }
    </div>`;
}

// ─── Main Render ─────────────────────────────────────────────
function renderAll() {
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

function bindCells() {
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

// ─── Bulk Assignment Modal ───────────────────────────────────
// 現場×日付に対して複数作業者を一括設定するモーダル
let _bulkSlot     = 'AM';
let _bulkSelected = new Set(); // 選択中の userId

function dateFmt(date) {
  const [y, m, d] = date.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

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

function openBulkModal(siteId, date) {
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
        <span class="bulk-modal-date">${dateFmt(date)}</span>
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

// ─── Foreman Lock Modal ──────────────────────────────────────
// ロック前に職長自動提案を確認・修正するモーダル
async function openForemanLockModal(year, month) {
  // 既存モーダルがあれば閉じる
  document.getElementById('foreman-lock-modal')?.remove();

  // ローディング状態のモーダルを表示
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'foreman-lock-modal';
  el.innerHTML = `
    <div class="modal modal-lg foreman-lock-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title">${year}年${month}月 職長確認</span>
        <button class="modal-close" id="flm-close">×</button>
      </div>
      <div class="modal-body" id="flm-body">
        <div class="loading-screen"><div class="spinner"></div></div>
      </div>
    </div>`;
  document.body.appendChild(el);

  const closeModal = () => el.remove();
  el.querySelector('#flm-close').addEventListener('click', closeModal);
  el.addEventListener('click', e => { if (e.target === el) closeModal(); });

  // 職長提案を取得
  let suggestions;
  try {
    suggestions = await apiGetForemanSuggestions(year, month);
  } catch (e) {
    closeModal();
    showToast('職長データ取得エラー: ' + e.message, 'error');
    return;
  }

  if (suggestions.length === 0) {
    // シフトアサインがない月はそのままロック
    el.querySelector('#flm-body').innerHTML = `
      <p class="flm-info">この月にシフトアサインがないため、職長設定は不要です。</p>`;
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.innerHTML = `
      <button class="btn btn-secondary" id="flm-cancel">キャンセル</button>
      <button class="btn btn-primary" id="flm-confirm">ロックする</button>`;
    el.querySelector('.foreman-lock-modal').appendChild(footer);
    el.querySelector('#flm-cancel').addEventListener('click', closeModal);
    el.querySelector('#flm-confirm').addEventListener('click', async () => {
      try {
        await apiLockMonth(year, month);
        closeModal();
        showToast(`${month}月をロックしました`, 'success');
        loadBoard();
      } catch (err) { showToast(err.message, 'error'); }
    });
    return;
  }

  const alertCount = suggestions.filter(s => s.has_alert).length;

  const alertBanner = alertCount > 0
    ? `<div class="flm-alert-banner">⚠ ${alertCount}件で職長資格者が見つかりません。職長未定の行は手動で設定するか、現場の職長優先順位を設定してください。</div>`
    : `<div class="flm-ok-banner">✓ 全${suggestions.length}件で職長が自動設定されます</div>`;

  const rows = suggestions.map(s => {
    const [, sm, sd] = s.work_date.split('-');
    const dateDisp = `${parseInt(sm)}/${parseInt(sd)}`;
    const alertIcon = s.has_alert ? '<span class="flm-warn">⚠</span>' : '';
    const manualIcon = s.is_manual ? '<span class="flm-manual">手動</span>' : '';

    const options = [
      `<option value="">— 未設定 —</option>`,
      ...(s.candidates ?? []).map(c => {
        const selected = s.user_id != null && s.user_id == c.user_id ? 'selected' : '';
        return `<option value="${c.user_id}" ${selected}>${escHtml(c.user_name)}</option>`;
      }),
    ].join('');

    return `
      <tr class="${s.has_alert ? 'flm-row-alert' : ''}">
        <td class="flm-td-date">${dateDisp}</td>
        <td class="flm-td-site">${escHtml(s.site_name)}</td>
        <td class="flm-td-foreman">
          ${alertIcon}${manualIcon}
          <select class="form-select flm-select"
                  data-site-id="${s.site_id}"
                  data-work-date="${s.work_date}">
            ${options}
          </select>
        </td>
      </tr>`;
  }).join('');

  el.querySelector('#flm-body').innerHTML = `
    ${alertBanner}
    <div class="flm-table-wrap">
      <table class="flm-table">
        <thead><tr><th>日付</th><th>現場</th><th>職長</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button class="btn btn-secondary" id="flm-cancel">キャンセル</button>
    <button class="btn btn-primary" id="flm-confirm">確認してロック</button>`;
  el.querySelector('.foreman-lock-modal').appendChild(footer);

  el.querySelector('#flm-cancel').addEventListener('click', closeModal);
  el.querySelector('#flm-confirm').addEventListener('click', async () => {
    const btn = el.querySelector('#flm-confirm');
    btn.disabled = true;
    btn.textContent = '処理中…';

    // 各行のセレクト値を職長アサインとして保存（値があるもののみ）
    const saves = [];
    el.querySelectorAll('.flm-select').forEach(sel => {
      if (sel.value) {
        saves.push(apiUpsertForemanAssignment(
          Number(sel.dataset.siteId),
          sel.dataset.workDate,
          Number(sel.value),
          false, // 自動提案（手動フラグなし）
        ));
      }
    });

    try {
      await Promise.allSettled(saves);
      await apiLockMonth(year, month);
      closeModal();
      showToast(`${month}月をロックしました`, 'success');
      loadBoard();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = '確認してロック';
    }
  });
}

// ─── Foreman Change Popover ──────────────────────────────────
function openForemanPopover(siteId, dateStr, triggerEl) {
  document.getElementById('foreman-popover')?.remove();

  // この現場・日付にアサインされている作業者を候補にする
  const assigned = st.assignments.filter(a =>
    Number(a.site_id) === siteId && parseWorkDate(a.work_date) === dateStr
  );
  // 重複 user_id を除去
  const seen = new Set();
  const candidates = assigned.filter(a => {
    if (seen.has(a.user_id)) return false;
    seen.add(a.user_id); return true;
  });

  const currentForeman = st.foremanMap[`${siteId}_${dateStr}`];

  const options = [
    `<option value="">— 未設定 —</option>`,
    ...candidates.map(a => {
      const name = escHtml(st.workerDispMap[a.user_id] ?? a.user_name ?? `ID:${a.user_id}`);
      const qual = st.foremanQualSet.has(a.user_id) ? ' ★' : '';
      const sel  = currentForeman?.user_id === a.user_id ? 'selected' : '';
      return `<option value="${a.user_id}" ${sel}>${name}${qual}</option>`;
    }),
  ].join('');

  // ポップオーバーの表示位置を算出
  const rect = triggerEl.getBoundingClientRect();
  const top  = rect.bottom + 6;
  const left = Math.min(rect.left, window.innerWidth - 252);

  const [, m, d] = dateStr.split('-');
  const siteName  = escHtml(st.siteMap[siteId] ?? `現場#${siteId}`);

  const pop = document.createElement('div');
  pop.id = 'foreman-popover';
  pop.className = 'foreman-popover';
  pop.style.cssText = `top:${top}px;left:${left}px`;
  pop.innerHTML = `
    <div class="fpop-header">
      <span class="fpop-title">職長を変更</span>
      <button class="fpop-close">×</button>
    </div>
    <div class="fpop-meta">${siteName} · ${parseInt(m)}/${parseInt(d)}</div>
    <select class="form-select fpop-select" id="fpop-sel">${options}</select>
    <div class="fpop-footer">
      <button class="btn btn-sm btn-secondary" id="fpop-cancel">キャンセル</button>
      <button class="btn btn-sm btn-primary"   id="fpop-save">保存</button>
    </div>`;
  document.body.appendChild(pop);

  const close = () => pop.remove();
  pop.querySelector('.fpop-close').addEventListener('click', close);
  pop.querySelector('#fpop-cancel').addEventListener('click', close);

  // 外側クリックで閉じる
  const onOutside = e => {
    if (!pop.contains(e.target) && e.target !== triggerEl) {
      close();
      document.removeEventListener('mousedown', onOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);

  pop.querySelector('#fpop-save').addEventListener('click', async () => {
    const saveBtn = pop.querySelector('#fpop-save');
    const uid     = Number(pop.querySelector('#fpop-sel').value);
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      if (uid) {
        await apiUpsertForemanAssignment(siteId, dateStr, uid, true);
        st.foremanMap[`${siteId}_${dateStr}`] = {
          site_id: siteId, work_date: dateStr, user_id: uid, is_manual: true,
        };
      } else {
        await apiDeleteForemanAssignment(siteId, dateStr);
        delete st.foremanMap[`${siteId}_${dateStr}`];
      }
      showToast('職長を更新しました', 'success');
      close();
      renderAll();
    } catch (err) {
      showToast(err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });
}

// ─── Toast ───────────────────────────────────────────────────
export function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icon  = type === 'success' ? '✓' : '⚠';
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ─── Unassigned Workers Section ──────────────────────────────
// 週表示用: アサインのない作業者を1行にまとめて表示
function renderUnassignedWeekRow(dates) {
  if (st.workers.length === 0) return '';

  const cells = dates.map(d => {
    const ds = fmtDate(d);
    const assignedIds = new Set(
      st.assignments.filter(a => parseWorkDate(a.work_date) === ds).map(a => a.user_id)
    );
    const unassigned = st.workers.filter(w => !assignedIds.has(w.id));

    if (unassigned.length === 0) {
      return `<td class="ua-week-cell"><span class="ua-all-ok">全員</span></td>`;
    }
    const chips = unassigned.map(w => {
      const qual = st.foremanQualSet.has(w.id) ? `<span class="ua-qual-badge">★</span>` : '';
      return `<span class="ua-chip">${qual}${escHtml(st.workerDispMap[w.id] ?? w.name)}</span>`;
    }).join('');
    return `<td class="ua-week-cell">${chips}</td>`;
  }).join('');

  return `
    <tr class="row-unassigned">
      <td class="ua-label-cell">
        <span class="ua-label">休み</span>
      </td>
      ${cells}
    </tr>`;
}

// 1日表示（カンバン）用: アサインのない作業者セクション
function renderUnassignedKanbanSection(dateStr) {
  if (st.workers.length === 0) return '';

  const assignedIds = new Set(
    st.assignments.filter(a => parseWorkDate(a.work_date) === dateStr).map(a => a.user_id)
  );
  const unassigned = st.workers.filter(w => !assignedIds.has(w.id));

  if (unassigned.length === 0) {
    return `
      <div class="ua-kanban-section">
        <span class="ua-all-ok">本日は全員アサイン済みです</span>
      </div>`;
  }

  const chips = unassigned.map(w => {
    const qual = st.foremanQualSet.has(w.id) ? `<span class="ua-qual-badge">★</span>` : '';
    return `<span class="ua-chip">${qual}${escHtml(st.workerDispMap[w.id] ?? w.name)}</span>`;
  }).join('');

  return `
    <div class="ua-kanban-section">
      <div class="ua-kanban-header">
        <span class="ua-label">休み</span>
        <span class="ua-count">${unassigned.length}名</span>
      </div>
      <div class="ua-chips">${chips}</div>
    </div>`;
}

// ─── Init ─────────────────────────────────────────────────────
export function initBoard({ readOnly = false } = {}) {
  st.readOnly = readOnly;
  loadBoard();
}
