// worker.js — 作業者向け マイシフト（月次全日表示・希望/日報入力）

import {
  apiGetBoard, apiGetMyReports, apiUpsertReport,
  apiGetLockStatus, apiUpdateSiteClient, apiHopeSubmit,
  apiGetForemanAssignments, apiGetTeamReports, apiUpsertTeamReports,
  apiGetTodayAttendance, apiClockIn, apiClockOut,
} from './api.js';
import { HOLIDAYS } from './holidays.js';
import { escHtml } from './util.js';
import { showToast } from './toast.js';

// ─── State ───────────────────────────────────────────────────
const st = {
  userId:       null,
  currentMonth: new Date(),
  assignments:  [],
  reports:      {},        // { 'YYYY-MM-DD': DailyReport }
  foremanDates: {},        // { 'YYYY-MM-DD': { site_id, site_name } } 職長担当日
  locked:       false,
  expandedDate: null,
  loading:      false,
  todayStatus:  null,      // TodayStatusResponse | null
};

const DOW_JA   = ['日', '月', '火', '水', '木', '金', '土'];
const SLOT_CLS = { AM: 'badge-am', PM: 'badge-pm', ALL: 'badge-all' };

const HOPE_OPTS = [
  { value: '',         label: '—',   cls: 'hope-none',    title: '未記入' },
  { value: 'present',  label: '○',   cls: 'hope-present', title: '出勤希望' },
  { value: 'half_am',  label: '△前', cls: 'hope-half-am', title: '午前のみ可' },
  { value: 'half_pm',  label: '△後', cls: 'hope-half-pm', title: '午後のみ可' },
  { value: 'absent',   label: '×',   cls: 'hope-absent',  title: '休み希望' },
];

// ─── Utilities ──────────────────────────────────────────────
function fmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { return String(s).substring(0, 10); }

function allDaysInMonth(ref) {
  const y = ref.getFullYear(), m = ref.getMonth();
  return Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => new Date(y, m, i + 1));
}


// ─── Load ────────────────────────────────────────────────────
async function load() {
  st.loading = true;
  render();

  const y = st.currentMonth.getFullYear();
  const m = st.currentMonth.getMonth();
  const from = fmtYMD(new Date(y, m, 1));
  const to   = fmtYMD(new Date(y, m + 1, 0));

  try {
    const [boardData, reportData, lockData, foremanData, todayData] = await Promise.all([
      apiGetBoard(from, to).catch(() => []),
      apiGetMyReports(y, m + 1).catch(() => ({ reports: [] })),
      apiGetLockStatus(y, m + 1).catch(() => ({ locked: false })),
      apiGetForemanAssignments(from, to).catch(() => []),
      apiGetTodayAttendance().catch(() => null),
    ]);
    st.todayStatus = todayData;

    st.assignments = (boardData ?? []).filter(a => a.user_id === st.userId);
    st.locked      = lockData?.locked ?? false;

    st.reports = {};
    for (const r of (reportData?.reports ?? [])) {
      st.reports[parseDate(r.work_date)] = r;
    }

    // 自分が職長に設定されている日を抽出
    st.foremanDates = {};
    for (const fa of (foremanData ?? [])) {
      if (fa.user_id === st.userId) {
        const d = parseDate(fa.work_date);
        st.foremanDates[d] = { site_id: fa.site_id, site_name: fa.site_name ?? '' };
      }
    }
  } catch {
    st.assignments = [];
    st.reports     = {};
    st.locked      = false;
  }

  st.loading = false;
  render();
}

// ─── Render ─────────────────────────────────────────────────
function render() {
  const root = document.getElementById('worker-root');
  if (!root) return;

  if (st.loading) {
    root.innerHTML = `<div class="wk-spinner-wrap"><div class="spinner"></div></div>`;
    return;
  }

  const y = st.currentMonth.getFullYear();
  const m = st.currentMonth.getMonth();
  const today      = fmtYMD(new Date());
  const monthLabel = `${y}年${m + 1}月`;
  const lockBadge  = st.locked ? `<span class="wk-lock-badge">🔒 確定済み</span>` : '';

  const assignByDate = {};
  for (const a of st.assignments) {
    (assignByDate[parseDate(a.work_date)] ??= []).push(a);
  }

  const rows = allDaysInMonth(st.currentMonth)
    .map(d => renderDayRow(d, today, assignByDate))
    .join('');

  root.innerHTML = `
    <div class="wk-page">
      ${renderAttendanceCard()}
      <div class="wk-month-header">
        <button class="wk-month-nav" id="wk-prev">‹</button>
        <div class="wk-month-center">
          <span class="wk-month-label">${monthLabel}</span>
          ${lockBadge}
        </div>
        <button class="wk-month-nav" id="wk-next">›</button>
      </div>
      <div class="wk-calendar">${rows}</div>
      ${renderMonthlyTable(y, m + 1, assignByDate)}
    </div>
    <input type="file" id="wk-photo-input" accept="image/*" capture="environment" style="display:none">`;

  // 打刻ボタンのイベント登録
  document.getElementById('wk-btn-clockin')?.addEventListener('click', () => startClock('in'));
  document.getElementById('wk-btn-clockout')?.addEventListener('click', () => startClock('out'));

  document.getElementById('wk-prev').addEventListener('click', () => {
    st.expandedDate = null;
    const d = new Date(st.currentMonth);
    d.setMonth(d.getMonth() - 1);
    st.currentMonth = d;
    load();
  });
  document.getElementById('wk-next').addEventListener('click', () => {
    st.expandedDate = null;
    const d = new Date(st.currentMonth);
    d.setMonth(d.getMonth() + 1);
    st.currentMonth = d;
    load();
  });

  bindRows(root);
  bindMonthlyTable(root, y, m + 1);
}

// ─── Day Row ─────────────────────────────────────────────────
function renderDayRow(d, today, assignByDate) {
  const dateStr  = fmtYMD(d);
  const dow      = DOW_JA[d.getDay()];
  const isSun    = d.getDay() === 0;
  const isSat    = d.getDay() === 6;
  const isToday  = dateStr === today;
  const holiday  = HOLIDAYS[dateStr] ?? null;
  const assigns  = assignByDate[dateStr] ?? [];
  const report   = st.reports[dateStr];
  const expanded = st.expandedDate === dateStr;

  const rowCls = ['wk-day-row',
    isToday          ? 'wk-row-today'   : '',
    isSun || holiday ? 'wk-row-sun'     : '',
    isSat            ? 'wk-row-sat'     : '',
    holiday          ? 'wk-row-holiday' : '',
    expanded         ? 'wk-row-expanded': '',
  ].filter(Boolean).join(' ');

  const foremanInfo = st.foremanDates[dateStr];
  const foremanBtn  = foremanInfo
    ? `<button class="wk-foreman-btn" data-date="${dateStr}"
               data-site-id="${foremanInfo.site_id}"
               data-site-name="${escHtml(foremanInfo.site_name)}"
               title="職長担当日 - クリックでチーム日報を入力">
         <span class="wk-foreman-icon">👷</span><span class="wk-foreman-label">職長</span>
       </button>`
    : '';

  const shiftHtml = assigns.length === 0
    ? `<span class="wk-no-shift">シフトなし</span>`
    : assigns.map(a => `
        <span class="wk-assign">
          <span class="badge ${SLOT_CLS[a.time_slot] ?? ''} wk-list-badge">${a.time_slot}</span>
          <span class="wk-list-site">${escHtml(a.site_name ?? '現場未定')}</span>
        </span>`).join('');

  const currentHope = report?.status ?? '';
  const hopeButtons = HOPE_OPTS.map(o => {
    const isActive = currentHope === o.value ? 'active' : '';
    const disabled = st.locked ? 'disabled' : '';
    return `<button class="wk-hope-btn ${o.cls} ${isActive}"
              data-date="${dateStr}" data-value="${o.value}"
              title="${o.title}" ${disabled}>${o.label}</button>`;
  }).join('');

  const lockIcon = st.locked ? `<span class="wk-lock-icon" title="確定済み">🔒</span>` : '';

  const reportPanel = expanded ? renderReportPanel(dateStr, assigns, report) : '';

  const hasReport   = report && (report.man_days > 0 || report.note || report.overtime_hours > 0);
  const rptBtnLabel = expanded ? '▲' : hasReport ? '✏' : '＋';

  return `
    <div class="${rowCls}" data-date="${dateStr}">
      <div class="wk-day-main">
        <div class="wk-date-col">
          <span class="wk-day-num">${d.getDate()}</span>
          <span class="wk-day-dow">${dow}</span>
          ${holiday ? `<span class="wk-holiday-dot" title="${escHtml(holiday)}">祝</span>` : ''}
        </div>
        <div class="wk-shift-col">${shiftHtml}${foremanBtn}</div>
        <div class="wk-hope-col">
          ${lockIcon}
          <div class="wk-hope-group-inline">${hopeButtons}</div>
        </div>
        <button class="wk-report-btn ${hasReport ? 'has-report' : ''} ${expanded ? 'active' : ''}"
                data-date="${dateStr}" title="${hasReport ? '日報を編集' : '日報を入力'}">${rptBtnLabel}</button>
      </div>
      ${reportPanel}
    </div>`;
}

// ─── Daily Report Panel（人工・残業・車・連絡のみ）────────────
function renderReportPanel(dateStr, assigns, report) {
  const dis = st.locked ? 'disabled' : '';

  // シフトから現場を自動取得（表示のみ）
  const amAssign = assigns.find(a => a.time_slot === 'ALL' || a.time_slot === 'AM');
  const pmAssign = assigns.find(a => a.time_slot === 'PM');
  const siteDisplay = [amAssign?.site_name, pmAssign?.site_name]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)  // 重複除去
    .join(' / ');

  // シフトのsite_idを自動セット用に保持
  const site1Id = amAssign?.site_id ?? null;
  const site2Id = (pmAssign && pmAssign.site_id !== amAssign?.site_id) ? pmAssign.site_id : null;

  const manDays    = report?.man_days       ?? (assigns.length > 0 ? 1.0 : 0);
  const overtime   = report?.overtime_hours ?? 0;
  const usedCar    = report?.used_car       ?? false;

  return `
    <div class="wk-report-panel"
         data-site1="${site1Id ?? ''}" data-site2="${site2Id ?? ''}">
      ${siteDisplay ? `<div class="wk-rpt-site-disp">📍 ${escHtml(siteDisplay)}</div>` : ''}
      <div class="wk-rpt-fields">
        <div class="wk-rpt-field">
          <label class="wk-rpt-label">人工</label>
          <input class="wk-rpt-num" type="number" min="0" max="2" step="0.5"
            value="${manDays}" ${dis}>
        </div>
        <div class="wk-rpt-field">
          <label class="wk-rpt-label">残業</label>
          <input class="wk-rpt-num" type="number" min="0" max="12" step="0.5"
            value="${overtime}" ${dis}>
          <span class="wk-rpt-unit">h</span>
        </div>
        <div class="wk-rpt-field">
          <label class="wk-rpt-label">車使用</label>
          <label class="wk-rpt-radio"><input type="radio" name="car_${dateStr}" value="1"
            ${usedCar ? 'checked' : ''} ${dis}> 有</label>
          <label class="wk-rpt-radio"><input type="radio" name="car_${dateStr}" value="0"
            ${!usedCar ? 'checked' : ''} ${dis}> 無</label>
        </div>
      </div>
      <div class="wk-rpt-note-row">
        <textarea class="wk-rpt-textarea" rows="2"
          placeholder="連絡・備考など自由記入" ${dis}>${escHtml(report?.note ?? '')}</textarea>
      </div>
      <div class="wk-rpt-actions">
        <button class="wk-cancel-btn" data-date="${dateStr}">閉じる</button>
        ${!st.locked ? `<button class="wk-save-rpt-btn btn btn-primary" data-date="${dateStr}">保存</button>` : ''}
      </div>
    </div>`;
}

// ─── Monthly Summary Table ───────────────────────────────────
function renderMonthlyTable(year, month, assignByDate) {
  // 現場ごとに集計
  const siteMap = {};  // siteId -> { name, days, manDays, overtime, clientName }

  for (const [dateStr, assigns] of Object.entries(assignByDate)) {
    const report = st.reports[dateStr];
    for (const a of assigns) {
      if (!siteMap[a.site_id]) {
        siteMap[a.site_id] = {
          name:       a.site_name ?? '現場未定',
          days:       0,
          manDays:    0,
          overtime:   0,
          clientName: '',
        };
      }
      siteMap[a.site_id].days++;
      if (report) {
        if (report.site_id === a.site_id || !report.site_id) {
          siteMap[a.site_id].manDays  += report.man_days       ?? 0;
          siteMap[a.site_id].overtime += report.overtime_hours ?? 0;
        }
        if (report.client_name && !siteMap[a.site_id].clientName) {
          siteMap[a.site_id].clientName = report.client_name;
        }
      }
    }
  }

  const sites = Object.entries(siteMap);
  if (sites.length === 0) return '';

  const dis = st.locked ? 'disabled' : '';

  const rows = sites.map(([siteId, s]) => `
    <tr>
      <td class="wk-tbl-site">${escHtml(s.name)}</td>
      <td class="wk-tbl-client">
        <input class="wk-client-input" type="text"
          data-site-id="${siteId}"
          placeholder="元請を入力"
          value="${escHtml(s.clientName)}" ${dis}>
      </td>
      <td class="wk-tbl-num">${s.manDays > 0 ? s.manDays : '—'}</td>
      <td class="wk-tbl-num">${s.overtime > 0 ? s.overtime + 'h' : '—'}</td>
      ${!st.locked ? `<td class="wk-tbl-save">
        <button class="wk-client-save-btn btn btn-sm"
          data-site-id="${siteId}"
          data-year="${year}" data-month="${month}">保存</button>
      </td>` : '<td></td>'}
    </tr>`).join('');

  // 月計
  const totalManDays  = sites.reduce((s, [, v]) => s + v.manDays,  0);
  const totalOvertime = sites.reduce((s, [, v]) => s + v.overtime, 0);

  // 休み希望日（×）
  const absentDays = Object.entries(st.reports)
    .filter(([, r]) => r.status === 'absent')
    .map(([d]) => parseInt(d.slice(8), 10))
    .sort((a, b) => a - b);
  const absentStr = absentDays.length
    ? absentDays.map(d => `${d}日`).join('・')
    : 'なし';

  return `
    <div class="wk-monthly-section">
      <div class="wk-monthly-title">月次集計</div>
      <table class="wk-monthly-tbl">
        <thead>
          <tr>
            <th>現場</th><th>元請</th><th>人工</th><th>残業</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" class="wk-tbl-total-label">合計</td>
            <td class="wk-tbl-num wk-tbl-total">${totalManDays || '—'}</td>
            <td class="wk-tbl-num wk-tbl-total">${totalOvertime ? totalOvertime + 'h' : '—'}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <div class="wk-absent-summary">休み希望日: ${absentStr}</div>
      ${!st.locked ? `
        <div class="wk-submit-row">
          <button class="btn btn-primary wk-hope-submit-btn"
                  data-year="${year}" data-month="${month}">
            この月の希望を管理者に提出する
          </button>
        </div>` : ''}
    </div>`;
}

// ─── Event Binding ───────────────────────────────────────────
function bindRows(root) {
  // 希望ボタン → 即保存
  root.querySelectorAll('.wk-hope-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const date   = btn.dataset.date;
      const value  = btn.dataset.value;
      const report = st.reports[date] ?? {};
      const newValue = report.status === value && value !== '' ? '' : value;

      try {
        await apiUpsertReport(date, {
          status:         newValue || 'absent',
          site_id:        report.site_id        ?? null,
          site_id2:       report.site_id2       ?? null,
          client_name:    report.client_name    ?? null,
          man_days:       report.man_days       ?? 0,
          overtime_hours: report.overtime_hours ?? 0,
          used_car:       report.used_car       ?? false,
          note:           report.note           ?? null,
        });
        st.reports[date] = { ...report, status: newValue };
        renderRow(root, date);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // 職長ボタン → チーム日報モーダル
  root.querySelectorAll('.wk-foreman-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openForemanTeamModal(btn.dataset.date, Number(btn.dataset.siteId), btn.dataset.siteName);
    });
  });

  // 日報ボタン → 展開トグル
  root.querySelectorAll('.wk-report-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const date = btn.dataset.date;
      st.expandedDate = st.expandedDate === date ? null : date;
      render();
    });
  });

  // 日報保存（人工・残業・車・連絡）
  root.querySelectorAll('.wk-save-rpt-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const date   = btn.dataset.date;
      const panel  = btn.closest('.wk-report-panel');
      const report = st.reports[date] ?? {};

      const site1Id = panel.dataset.site1 ? parseInt(panel.dataset.site1, 10) : null;
      const site2Id = panel.dataset.site2 ? parseInt(panel.dataset.site2, 10) : null;
      const nums    = panel.querySelectorAll('.wk-rpt-num');
      const manDays = parseFloat(nums[0]?.value ?? 0);
      const overtime = parseFloat(nums[1]?.value ?? 0);
      const usedCar  = panel.querySelector(`input[name="car_${date}"][value="1"]`)?.checked ?? false;
      const note     = panel.querySelector('.wk-rpt-textarea')?.value.trim() || null;

      btn.disabled    = true;
      btn.textContent = '保存中…';

      try {
        await apiUpsertReport(date, {
          status:         report.status || 'absent',
          site_id:        site1Id ?? report.site_id ?? null,
          site_id2:       site2Id ?? report.site_id2 ?? null,
          client_name:    report.client_name ?? null,
          man_days:       manDays,
          overtime_hours: overtime,
          used_car:       usedCar,
          note,
        });
        st.reports[date] = {
          ...report,
          site_id:        site1Id ?? report.site_id ?? null,
          site_id2:       site2Id ?? report.site_id2 ?? null,
          man_days:       manDays,
          overtime_hours: overtime,
          used_car:       usedCar,
          note,
        };
        st.expandedDate = null;
        showToast('保存しました', 'success');
        render();
      } catch (err) {
        btn.disabled    = false;
        btn.textContent = '保存';
        showToast(err.message, 'error');
      }
    });
  });

  // 閉じる
  root.querySelectorAll('.wk-cancel-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      st.expandedDate = null;
      render();
    });
  });
}

function bindMonthlyTable(root, year, month) {
  // 希望提出ボタン
  root.querySelector('.wk-hope-submit-btn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      await apiHopeSubmit(year, month);
      showToast(`${year}年${month}月の希望を管理者に送信しました`, 'success');
      btn.textContent = '提出済み ✓';
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'この月の希望を管理者に提出する';
    }
  });

  root.querySelectorAll('.wk-client-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const siteId     = parseInt(btn.dataset.siteId, 10);
      const row        = btn.closest('tr');
      const clientName = row.querySelector('.wk-client-input')?.value.trim() ?? '';

      btn.disabled    = true;
      btn.textContent = '…';

      try {
        await apiUpdateSiteClient(year, month, siteId, clientName);
        // ローカル state に反映
        for (const [, r] of Object.entries(st.reports)) {
          if (r.site_id === siteId || r.site_id2 === siteId) {
            r.client_name = clientName || null;
          }
        }
        showToast('元請を保存しました', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled    = false;
        btn.textContent = '保存';
      }
    });
  });
}

// 1行だけ再描画 → 月次テーブルも更新
function renderRow(root, dateStr) {
  const today = fmtYMD(new Date());
  const assignByDate = {};
  for (const a of st.assignments) {
    (assignByDate[parseDate(a.work_date)] ??= []).push(a);
  }
  const row = root.querySelector(`.wk-day-row[data-date="${dateStr}"]`);
  if (!row) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderDayRow(new Date(dateStr + 'T00:00:00'), today, assignByDate);
  row.replaceWith(tmp.firstElementChild);
  bindRows(root);

  // 月次集計テーブルを差し替え
  const existing = root.querySelector('.wk-monthly-section');
  if (existing) {
    const y = st.currentMonth.getFullYear();
    const m = st.currentMonth.getMonth();
    const frag = document.createElement('div');
    frag.innerHTML = renderMonthlyTable(y, m + 1, assignByDate);
    const newSection = frag.firstElementChild;
    if (newSection) {
      existing.replaceWith(newSection);
      bindMonthlyTable(root, y, m + 1);
    }
  }
}

// ─── Toast ───────────────────────────────────────────────────

// ─── Foreman Team Report Modal ───────────────────────────────
async function openForemanTeamModal(dateStr, siteId, siteName) {
  document.getElementById('ftm-modal')?.remove();

  // ローディングモーダルを先に表示
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'ftm-modal';
  el.innerHTML = `
    <div class="modal ftm-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title">👷 チーム日報入力</span>
        <span class="ftm-meta">${escHtml(siteName)} · ${dateStr.slice(5).replace('-', '/')}</span>
        <button class="modal-close" id="ftm-close">×</button>
      </div>
      <div class="modal-body" id="ftm-body">
        <div class="wk-spinner-wrap"><div class="spinner"></div></div>
      </div>
    </div>`;
  document.body.appendChild(el);

  const close = () => el.remove();
  el.querySelector('#ftm-close').addEventListener('click', close);
  el.addEventListener('click', e => { if (e.target === el) close(); });

  // メンバーデータ取得
  let members;
  try {
    members = await apiGetTeamReports(siteId, dateStr);
  } catch (err) {
    el.querySelector('#ftm-body').innerHTML =
      `<p class="ftm-error">データ取得エラー: ${escHtml(err.message)}</p>`;
    return;
  }

  if (!members || members.length === 0) {
    el.querySelector('#ftm-body').innerHTML =
      `<p class="ftm-empty">この日この現場にアサインされたメンバーがいません</p>`;
    return;
  }

  // メンバーリスト描画
  const rows = members.map((m, i) => `
    <div class="ftm-row${i === 0 ? ' ftm-row-first' : ''}" data-uid="${m.user_id}">
      <span class="ftm-name">${escHtml(m.user_name)}</span>
      <div class="ftm-fields">
        <label class="ftm-field">
          <span class="ftm-field-lbl">人工</span>
          <input class="ftm-man ftm-num" type="number" min="0" max="2" step="0.5"
                 value="${m.man_days}">
        </label>
        <label class="ftm-field">
          <span class="ftm-field-lbl">残業h</span>
          <input class="ftm-ot ftm-num" type="number" min="0" max="24" step="0.5"
                 value="${m.overtime_hours}">
        </label>
        <div class="ftm-field ftm-field-car">
          <span class="ftm-field-lbl">車</span>
          <label class="ftm-radio"><input type="radio" name="ftm_car_${m.user_id}" value="1"
            ${m.used_car ? 'checked' : ''}> 有</label>
          <label class="ftm-radio"><input type="radio" name="ftm_car_${m.user_id}" value="0"
            ${!m.used_car ? 'checked' : ''}> 無</label>
        </div>
      </div>
    </div>`).join('');

  el.querySelector('#ftm-body').innerHTML = `
    <p class="ftm-hint">1人目を入力すると他のメンバーに自動反映されます</p>
    <div class="ftm-list" id="ftm-list">${rows}</div>
    <div class="modal-error" id="ftm-err"></div>`;

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button class="btn btn-secondary" id="ftm-cancel">閉じる</button>
    <button class="btn btn-primary"   id="ftm-save">全員分を保存</button>`;
  el.querySelector('.ftm-modal').appendChild(footer);

  el.querySelector('#ftm-cancel').addEventListener('click', close);

  // 1行目の入力変更 → 他の行に自動反映
  const firstRow = el.querySelector('.ftm-row-first');
  if (firstRow) {
    const syncToOthers = () => {
      const man = firstRow.querySelector('.ftm-man').value;
      const ot  = firstRow.querySelector('.ftm-ot').value;
      const car = firstRow.querySelector(`input[name^="ftm_car_"]:checked`)?.value ?? '0';
      el.querySelectorAll('.ftm-row:not(.ftm-row-first)').forEach(row => {
        row.querySelector('.ftm-man').value = man;
        row.querySelector('.ftm-ot').value  = ot;
        const uid  = row.dataset.uid;
        const radio = row.querySelector(`input[name="ftm_car_${uid}"][value="${car}"]`);
        if (radio) radio.checked = true;
      });
    };
    firstRow.querySelector('.ftm-man').addEventListener('change', syncToOthers);
    firstRow.querySelector('.ftm-ot').addEventListener('change',  syncToOthers);
    firstRow.querySelectorAll('input[type="radio"]').forEach(r =>
      r.addEventListener('change', syncToOthers));
  }

  // 保存
  el.querySelector('#ftm-save').addEventListener('click', async () => {
    const saveBtn = el.querySelector('#ftm-save');
    const errEl   = el.querySelector('#ftm-err');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    errEl.classList.remove('visible');

    const payload = [...el.querySelectorAll('.ftm-row')].map(row => {
      const uid = Number(row.dataset.uid);
      const man = parseFloat(row.querySelector('.ftm-man').value) || 0;
      const ot  = parseFloat(row.querySelector('.ftm-ot').value)  || 0;
      const car = row.querySelector(`input[name="ftm_car_${uid}"][value="1"]`)?.checked ?? false;
      return { user_id: uid, man_days: man, overtime_hours: ot, used_car: car };
    });

    try {
      await apiUpsertTeamReports(siteId, dateStr, payload);
      showToast(`${payload.length}名分の日報を保存しました`, 'success');
      close();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('visible');
      saveBtn.disabled = false;
      saveBtn.textContent = '全員分を保存';
    }
  });
}

// ─── 出退勤カード ────────────────────────────────────────────
function renderAttendanceCard() {
  const s = st.todayStatus;
  // null（未取得）またはレスポンスが正規の TodayStatusResponse でない場合はカード非表示
  if (!s || typeof s.has_shift !== 'boolean') return '';

  if (!s.has_shift) {
    return `
      <div class="atd-card atd-no-shift">
        <span class="atd-no-shift-msg">本日は作業予定はありません</span>
      </div>`;
  }

  const a     = s.attendance;
  const slot  = s.time_slot ?? '';
  const slotBadge = slot ? `<span class="badge ${slot === 'AM' ? 'badge-am' : slot === 'PM' ? 'badge-pm' : 'badge-all'}">${slot}</span>` : '';

  if (!a) {
    return `
      <div class="atd-card atd-ready">
        <div class="atd-site">${escHtml(s.site_name ?? '')} ${slotBadge}</div>
        <button class="atd-btn atd-btn-in" id="wk-btn-clockin">
          📷 出勤する
        </button>
      </div>`;
  }

  const inTime = fmtTime(a.clock_in_at);
  if (!a.clock_out_at) {
    return `
      <div class="atd-card atd-working">
        <div class="atd-site">✅ ${escHtml(s.site_name ?? '')} ${slotBadge}</div>
        <div class="atd-times">出勤 ${inTime}</div>
        <button class="atd-btn atd-btn-out" id="wk-btn-clockout">
          📷 退勤する
        </button>
      </div>`;
  }

  const outTime = fmtTime(a.clock_out_at);
  return `
    <div class="atd-card atd-done">
      <div class="atd-site">${escHtml(s.site_name ?? '')} ${slotBadge}</div>
      <div class="atd-times">出勤 ${inTime} → 退勤 ${outTime}</div>
      <div class="atd-done-msg">お疲れ様でした</div>
    </div>`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── 写真撮影 → 確認 → アップロードフロー ───────────────────
function startClock(direction) {
  const input = document.getElementById('wk-photo-input');
  if (!input) return;

  const handler = async () => {
    input.removeEventListener('change', handler);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    showPhotoPreview(file, direction);
  };

  input.addEventListener('change', handler);
  input.click();
}

function showPhotoPreview(file, direction) {
  const label = direction === 'in' ? '出勤' : '退勤';
  const url   = URL.createObjectURL(file);

  const overlay = document.createElement('div');
  overlay.className = 'atd-overlay';
  overlay.innerHTML = `
    <div class="atd-preview-box">
      <p class="atd-preview-label">📷 ${label}写真の確認</p>
      <img class="atd-preview-img" src="${url}" alt="preview">
      <div class="atd-preview-note">現場の状況が写っていることを確認してください</div>
      <div class="atd-preview-actions">
        <button class="btn-secondary" id="atd-cancel">撮り直す</button>
        <button class="btn-primary"   id="atd-confirm">${label}を記録する</button>
      </div>
      <div class="atd-preview-err" id="atd-err"></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { URL.revokeObjectURL(url); overlay.remove(); };

  document.getElementById('atd-cancel').addEventListener('click', close);

  document.getElementById('atd-confirm').addEventListener('click', async () => {
    const confirmBtn = document.getElementById('atd-confirm');
    const errEl      = document.getElementById('atd-err');
    confirmBtn.disabled    = true;
    confirmBtn.textContent = '送信中…';

    try {
      const compressed = await compressPhoto(file);
      if (direction === 'in') {
        await apiClockIn(compressed);
      } else {
        await apiClockOut(compressed);
      }
      close();
      st.todayStatus = await apiGetTodayAttendance().catch(() => st.todayStatus);
      render();
      showToast(`${label}を記録しました`, 'success');
    } catch (err) {
      errEl.textContent      = err.message || 'エラーが発生しました';
      confirmBtn.disabled    = false;
      confirmBtn.textContent = `${label}を記録する`;
    }
  });
}

async function compressPhoto(file, maxWidth = 1280, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale  = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(bitmap.width  * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// ─── Init ────────────────────────────────────────────────────
export function initWorker(userId) {
  st.userId       = userId;
  st.currentMonth = new Date();
  st.expandedDate = null;
  load();
}
