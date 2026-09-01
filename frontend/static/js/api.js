// api.js — API クライアント

import { isEncrypted, decryptValue } from './crypto.js';

function authHeaders() {
  const token = localStorage.getItem('shift_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(url, options = {}) {
  const res = await fetch(url, { headers: authHeaders(), ...options });
  if (res.status === 401) {
    localStorage.removeItem('shift_token');
    localStorage.removeItem('shift_user');
    window.location.reload();
    return;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// POST /api/auth/login
export async function apiLogin(employeeId, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: employeeId, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'ログインに失敗しました');
  return data; // { token, user }
}

// GET /api/shifts/board?from=YYYY-MM-DD&to=YYYY-MM-DD
export function apiGetBoard(from, to) {
  return request(`/api/shifts/board?from=${from}&to=${to}`);
}

// POST /api/sites/{siteID}/shifts/{date}/assign
export function apiCreateAssign(siteId, date, userId, timeSlot) {
  return request(`/api/sites/${siteId}/shifts/${date}/assign`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, time_slot: timeSlot }),
  });
}

// DELETE /api/shifts/assign/{id}
export function apiDeleteAssign(id) {
  return request(`/api/shifts/assign/${id}`, { method: 'DELETE' });
}

// GET /api/workers
// phone が暗号化(enc.v1)されている場合はブラウザ側で復号して返す。
// 未アンロック時は null に置き換える（暗号文をUIに出さない）。
export async function apiGetWorkers() {
  try {
    const workers = await request('/api/workers');
    if (!Array.isArray(workers)) return workers;
    for (const w of workers) {
      // _phone_plain: サーバに平文のまま保存されている（暗号化移行の対象）
      w._phone_plain = w.phone != null && !isEncrypted(w.phone);
      if (isEncrypted(w.phone)) w.phone = await decryptValue(w.phone);
    }
    return workers;
  } catch {
    return null;
  }
}

// GET /api/crypto-settings — 連絡先E2E暗号化設定
export function apiGetCryptoSettings() {
  return request('/api/crypto-settings');
}

// POST /api/admin/crypto-settings — 暗号化を有効化（初回のみ）
export function apiCreateCryptoSettings(data) {
  return request('/api/admin/crypto-settings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// POST /api/admin/workers
export function apiCreateWorker(data) {
  return request('/api/admin/workers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// PUT /api/admin/workers/{id}
export function apiUpdateWorker(id, data) {
  return request(`/api/admin/workers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// GET /api/admin/workers/qr-tokens
export function apiGetWorkerQRTokens() {
  return request('/api/admin/workers/qr-tokens');
}

// POST /api/admin/workers/{id}/regenerate-qr
export function apiRegenerateQR(id) {
  return request(`/api/admin/workers/${id}/regenerate-qr`, { method: 'POST' });
}

// ─── 現場マスタ ──────────────────────────────────────────────

// GET /api/sites
export function apiGetSites() {
  return request('/api/sites');
}

// GET /api/sites/{id}
export function apiGetSite(id) {
  return request(`/api/sites/${id}`);
}

// POST /api/sites
export function apiCreateSite(data) {
  return request('/api/sites', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// PUT /api/sites/{id}
export function apiUpdateSite(id, data) {
  return request(`/api/sites/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ─── 日報 ─────────────────────────────────────────────────────

// GET /api/reports/my?year=Y&month=M
export function apiGetMyReports(year, month) {
  return request(`/api/reports/my?year=${year}&month=${month}`);
}

// PUT /api/reports/{date}
export function apiUpsertReport(date, data) {
  return request(`/api/reports/${date}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// PUT /api/reports/site-client
export function apiUpdateSiteClient(year, month, siteId, clientName) {
  return request('/api/reports/site-client', {
    method: 'PUT',
    body: JSON.stringify({ year, month, site_id: siteId, client_name: clientName }),
  });
}

// ─── Web Push ────────────────────────────────────────────────

// GET /api/push/vapid-key
export function apiGetVapidKey() {
  return request('/api/push/vapid-key');
}

// POST /api/push/subscribe
export function apiSubscribePush(subJson) {
  // subJson は PushSubscription.toJSON() の結果
  // { endpoint, keys: { p256dh, auth } } の形式
  return request('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      p256dh:   subJson.keys?.p256dh ?? '',
      auth:     subJson.keys?.auth   ?? '',
    }),
  });
}

// DELETE /api/push/subscribe
export function apiUnsubscribePush(endpoint) {
  return request('/api/push/subscribe', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  });
}

// POST /api/push/hope-submit
export function apiHopeSubmit(year, month) {
  return request('/api/push/hope-submit', {
    method: 'POST',
    body: JSON.stringify({ year, month }),
  });
}

// ─── シフトロック ─────────────────────────────────────────────

// GET /api/shifts/lock?year=Y&month=M
export function apiGetLockStatus(year, month) {
  return request(`/api/shifts/lock?year=${year}&month=${month}`);
}

// POST /api/admin/shifts/lock
export function apiLockMonth(year, month) {
  return request('/api/admin/shifts/lock', {
    method: 'POST',
    body: JSON.stringify({ year, month }),
  });
}

// DELETE /api/admin/shifts/lock
export function apiUnlockMonth(year, month) {
  return request('/api/admin/shifts/lock', {
    method: 'DELETE',
    body: JSON.stringify({ year, month }),
  });
}

// ─── 職長 ─────────────────────────────────────────────────────

// GET /api/sites/{siteID}/foreman-priorities
export function apiGetForemanPriorities(siteId) {
  return request(`/api/sites/${siteId}/foreman-priorities`);
}

// PUT /api/sites/{siteID}/foreman-priorities
export function apiSetForemanPriorities(siteId, items) {
  return request(`/api/sites/${siteId}/foreman-priorities`, {
    method: 'PUT',
    body: JSON.stringify(items),
  });
}

// GET /api/foreman/assignments?from=&to=
export function apiGetForemanAssignments(from, to) {
  return request(`/api/foreman/assignments?from=${from}&to=${to}`);
}

// PUT /api/foreman/assignments
export function apiUpsertForemanAssignment(siteId, workDate, userId, isManual) {
  return request('/api/foreman/assignments', {
    method: 'PUT',
    body: JSON.stringify({ site_id: siteId, work_date: workDate, user_id: userId, is_manual: isManual }),
  });
}

// DELETE /api/foreman/assignments
export function apiDeleteForemanAssignment(siteId, workDate) {
  return request(`/api/foreman/assignments?site_id=${siteId}&work_date=${workDate}`, { method: 'DELETE' });
}

// GET /api/foreman/suggest?year=&month=
export function apiGetForemanSuggestions(year, month) {
  return request(`/api/foreman/suggest?year=${year}&month=${month}`);
}

// 職長チーム日報
export function apiGetTeamReports(siteId, workDate) {
  return request(`/api/foreman/team-reports?site_id=${siteId}&work_date=${workDate}`);
}
export function apiUpsertTeamReports(siteId, workDate, members) {
  return request('/api/foreman/team-reports', {
    method: 'PUT',
    body: JSON.stringify({ site_id: siteId, work_date: workDate, members }),
  });
}

// ─── 出退勤打刻 ───────────────────────────────────────────────

// GET /api/attendance/today
export function apiGetTodayAttendance() {
  return request('/api/attendance/today');
}

// POST /api/attendance/clock-in  (photo: Blob)
export function apiClockIn(photoBlob) {
  const token = localStorage.getItem('shift_token');
  const form  = new FormData();
  form.append('photo', photoBlob, 'photo.jpg');
  return fetch('/api/attendance/clock-in', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  }).then(async res => {
    if (res.status === 401) { localStorage.removeItem('shift_token'); window.location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}

// POST /api/attendance/clock-out  (photo: Blob)
export function apiClockOut(photoBlob) {
  const token = localStorage.getItem('shift_token');
  const form  = new FormData();
  form.append('photo', photoBlob, 'photo.jpg');
  return fetch('/api/attendance/clock-out', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  }).then(async res => {
    if (res.status === 401) { localStorage.removeItem('shift_token'); window.location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}
