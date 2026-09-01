// board-foreman.js — 職長ロックモーダル・職長変更ポップオーバー

import { apiLockMonth, apiUpsertForemanAssignment,
         apiDeleteForemanAssignment, apiGetForemanSuggestions } from './api.js';
import { escHtml } from './util.js';
import { showToast } from './toast.js';
import { parseWorkDate } from './dates.js';
import { st } from './board-state.js';
import { loadBoard, renderAll } from './board.js';

// ─── Foreman Lock Modal ──────────────────────────────────────
// ロック前に職長自動提案を確認・修正するモーダル
export async function openForemanLockModal(year, month) {
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
export function openForemanPopover(siteId, dateStr, triggerEl) {
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
