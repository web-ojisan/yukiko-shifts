// board-state.js — シフトボードの状態と純粋データ変換

import { parseWorkDate } from './dates.js';

// ─── State ───────────────────────────────────────────────────
export const st = {
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

// ─── Slot 表示定数 ───────────────────────────────────────────
export const SLOT_CLS   = { AM: 'badge-am', PM: 'badge-pm', ALL: 'badge-all' };
export const SLOT_LABEL = { AM: '前', PM: '後', ALL: '全' };

// ─── Worker Display Names ────────────────────────────────────
// 苗字が重複するときだけ名前の頭1文字を付加する
export function buildWorkerDisplayNames(workers) {
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

// ─── Data Grouping ────────────────────────────────────────────
export function buildMaps(assignments) {
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
