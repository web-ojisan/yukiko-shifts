// board-views.js — シフトボードの描画（純粋なHTML生成のみ、イベントバインドは board.js）

import { HOLIDAYS } from './holidays.js';
import { escHtml } from './util.js';
import { DOW_JA, fmtDate, parseWorkDate, getWeekDates, fmtMonthDay, fmtFull } from './dates.js';
import { st, SLOT_CLS, SLOT_LABEL, groupWeek, groupDay } from './board-state.js';

// ─── Card / Badge Renders ────────────────────────────────────

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
export function renderKanban() {
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
export function renderWeekTable() {
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
export function renderToolbar() {
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
