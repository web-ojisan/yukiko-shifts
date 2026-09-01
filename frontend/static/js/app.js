// app.js — エントリーポイント・認証・ルーティング

import { apiLogin } from './api.js';
import { initBoard } from './board.js';
import { initSites } from './sites.js';
import { initWorker } from './worker.js';
import { initWorkers } from './workers.js';
import { initPush, clearPush } from './push.js';

// ─── Auth helpers ─────────────────────────────────────────────
function getToken() { return localStorage.getItem('shift_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('shift_user')); } catch { return null; }
}
function saveAuth(token, user) {
  localStorage.setItem('shift_token', token);
  localStorage.setItem('shift_user', JSON.stringify(user));
}
function clearAuth() {
  localStorage.removeItem('shift_token');
  localStorage.removeItem('shift_user');
}

// ─── Router ──────────────────────────────────────────────────
// ページ: 'board' | 'sites' | 'worker'
let currentPage = 'board';

function navigate(page) {
  currentPage = page;
  renderContent();
}

// ─── Login Page ──────────────────────────────────────────────

// デモ用クイックログインの有効状態（サーバの DEMO_LOGIN 環境変数で制御）
let _demoLogin = null; // null = 未取得
async function fetchDemoLoginEnabled() {
  if (_demoLogin === null) {
    try {
      const res = await fetch('/api/config');
      _demoLogin = (await res.json()).demo_login === true;
    } catch {
      _demoLogin = false;
    }
  }
  return _demoLogin;
}

async function renderLogin(errMsg = '') {
  const demoLogin = await fetchDemoLoginEnabled();
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-wrapper">
      <div class="login-card">
        <div class="login-logo">
          <h1>シフト管理システム</h1>
          <p>施工会社向け シフト・日報管理</p>
        </div>
        <div class="alert alert-error${errMsg ? ' visible' : ''}" id="login-err">${errMsg}</div>
        <div class="form-group">
          <label for="login-id">社員ID</label>
          <input type="text" id="login-id" class="form-control"
            placeholder="例: admin" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="login-pw">パスワード</label>
          <input type="password" id="login-pw" class="form-control"
            placeholder="パスワードを入力" autocomplete="current-password">
        </div>
        <button class="btn btn-primary" id="login-btn">ログイン</button>
        ${demoLogin ? `
        <div class="demo-section">
          <div class="demo-divider"><span>デモ用クイックログイン</span></div>
          <div class="demo-btns">
            <button class="btn btn-demo btn-demo-admin" id="demo-admin-btn">管理者</button>
            <button class="btn btn-demo btn-demo-worker" id="demo-worker-btn">作業者</button>
          </div>
          <div class="demo-note">
            デモ環境です。データは定期的にリセットされます。<br>実在の個人情報は入力しないでください。
          </div>
        </div>` : ''}
      </div>
    </div>`;

  const idEl  = document.getElementById('login-id');
  const pwEl  = document.getElementById('login-pw');
  const btnEl = document.getElementById('login-btn');
  const errEl = document.getElementById('login-err');

  const doLogin = async () => {
    const id = idEl.value.trim();
    const pw = pwEl.value;
    if (!id || !pw) {
      errEl.textContent = 'IDとパスワードを入力してください';
      errEl.classList.add('visible');
      return;
    }
    btnEl.disabled = true;
    btnEl.textContent = 'ログイン中…';
    errEl.classList.remove('visible');
    try {
      const { token, user } = await apiLogin(id, pw);
      saveAuth(token, user);
      currentPage = 'board';
      renderApp();
      initPush(); // ログイン後にプッシュ購読を登録（許可ダイアログ）
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.add('visible');
      btnEl.disabled = false;
      btnEl.textContent = 'ログイン';
    }
  };

  const doQuickLogin = async (id, pw) => {
    idEl.value = id;
    pwEl.value = pw;
    await doLogin();
  };

  btnEl.addEventListener('click', doLogin);
  pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('demo-admin-btn')?.addEventListener('click', () => doQuickLogin('admin', 'admin1234'));
  document.getElementById('demo-worker-btn')?.addEventListener('click', () => doQuickLogin('w001', 'worker1234'));
  idEl.focus();
}

// ─── App Shell ───────────────────────────────────────────────
function renderApp() {
  const user = getUser();
  if (!user) { renderLogin(); return; }

  const isAdmin   = user.role === 'admin';
  const roleLabel = isAdmin ? '管理者' : '作業者';

  // 作業者はマイシフト・シフトボード以外には遷移させない
  if (!isAdmin && currentPage !== 'worker' && currentPage !== 'board') currentPage = 'worker';

  const navItems = isAdmin
    ? `<button class="nav-item" data-page="board">📅 シフトボード</button>
       <button class="nav-item" data-page="sites">🏗 現場マスタ</button>
       <button class="nav-item" data-page="workers">👷 作業者管理</button>`
    : `<button class="nav-item" data-page="worker">📋 マイシフト</button>
       <button class="nav-item" data-page="board">📅 シフトボード</button>`;

  document.getElementById('app').innerHTML = `
    <div class="app-wrapper">
      <header class="app-header">
        <div class="header-brand">
          <h1>シフト管理システム</h1>
          <span class="header-badge">${roleLabel}</span>
        </div>
        <div class="header-right">
          <span class="header-user">${user.name}</span>
          <button class="btn-logout" id="logout-btn">ログアウト</button>
        </div>
      </header>

      <nav class="app-nav">${navItems}</nav>

      <div id="page-root"
           style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;">
      </div>
    </div>`;

  // デモ環境ではアプリ全体に注意バナーを表示
  fetchDemoLoginEnabled().then(on => {
    if (!on || document.getElementById('demo-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'demo-banner';
    banner.className = 'demo-banner';
    banner.textContent = 'デモ環境 — データは定期的にリセットされます。実在の個人情報は入力しないでください。';
    document.querySelector('.app-wrapper')?.prepend(banner);
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    clearPush().catch(() => {}); // サブスクリプション削除（失敗しても無視）
    clearAuth();
    renderLogin();
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  renderContent();
}

function renderContent() {
  // ナビのアクティブ状態を更新
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === currentPage);
  });

  const root = document.getElementById('page-root');
  if (!root) return;

  if (currentPage === 'board') {
    root.innerHTML = `
      <div id="board-root"
           style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;">
      </div>`;
    const boardUser = getUser();
    initBoard({ readOnly: boardUser?.role !== 'admin' });
  } else if (currentPage === 'sites') {
    root.innerHTML = `
      <div id="sites-root"
           style="flex:1;overflow:auto;padding:20px 24px;">
      </div>`;
    initSites();
  } else if (currentPage === 'workers') {
    root.innerHTML = `
      <div id="workers-root"
           style="flex:1;overflow:auto;padding:20px 24px;">
      </div>`;
    initWorkers();
  } else if (currentPage === 'worker') {
    const user = getUser();
    root.innerHTML = `
      <div id="worker-root"
           style="flex:1;overflow:auto;">
      </div>`;
    initWorker(user.id);
  }
}

// ─── Bootstrap ───────────────────────────────────────────────
if (getToken()) {
  renderApp();
  initPush(); // ページリロード時も購読を維持
} else {
  renderLogin();
}
