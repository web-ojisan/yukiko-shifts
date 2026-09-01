/**
 * sites.test.js — sites.js のユニットテスト (vanilla, Node.js)
 *
 * 実行: node frontend/static/js/sites.test.js
 */

// ─── Minimal test framework ───────────────────────────────────
let _pass = 0, _fail = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`  ✓  ${desc}`);
    _pass++;
  } catch (e) {
    console.error(`  ✗  ${desc}`);
    console.error(`     ${e.message}`);
    _fail++;
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`expected falsy, got ${JSON.stringify(actual)}`);
    },
  };
}

// ─── 本物のコードを import してテストする ─────────────────────
import { fmtDate, fmtBudget, statusLabel, statusClass, buildSitePayload } from './sites.js';
import { escHtml } from './util.js';

// ─── fmtDate ──────────────────────────────────────────────────
console.log('\n── fmtDate ──────────────────────────────────────────────');

test('ISO 8601 を年/月/日 に変換する', () => {
  expect(fmtDate('2026-05-01T00:00:00Z')).toBe('2026/5/1');
});
test('YYYY-MM-DD を年/月/日 に変換する', () => {
  expect(fmtDate('2026-12-31')).toBe('2026/12/31');
});
test('先頭ゼロを除いた月・日を返す', () => {
  expect(fmtDate('2026-01-05')).toBe('2026/1/5');
});
test('null → 空文字', () => {
  expect(fmtDate(null)).toBe('');
});
test('undefined → 空文字', () => {
  expect(fmtDate(undefined)).toBe('');
});
test('空文字 → 空文字', () => {
  expect(fmtDate('')).toBe('');
});

// ─── fmtBudget ────────────────────────────────────────────────
console.log('\n── fmtBudget ────────────────────────────────────────────');

test('整数を 3桁区切り + 円 で返す', () => {
  expect(fmtBudget(5000000)).toBe('5,000,000円');
});
test('0 → 0円', () => {
  expect(fmtBudget(0)).toBe('0円');
});
test('null → 空文字', () => {
  expect(fmtBudget(null)).toBe('');
});
test('undefined → 空文字', () => {
  expect(fmtBudget(undefined)).toBe('');
});

// ─── statusLabel ──────────────────────────────────────────────
console.log('\n── statusLabel ──────────────────────────────────────────');

test('active → 稼働中', () => {
  expect(statusLabel('active')).toBe('稼働中');
});
test('completed → 完了', () => {
  expect(statusLabel('completed')).toBe('完了');
});
test('deleted → 削除', () => {
  expect(statusLabel('deleted')).toBe('削除');
});
test('未知の値はそのまま返す', () => {
  expect(statusLabel('unknown')).toBe('unknown');
});

// ─── statusClass ──────────────────────────────────────────────
console.log('\n── statusClass ──────────────────────────────────────────');

test('active → badge-status-active', () => {
  expect(statusClass('active')).toBe('badge-status-active');
});
test('completed → badge-status-done', () => {
  expect(statusClass('completed')).toBe('badge-status-done');
});
test('未知の値 → 空文字', () => {
  expect(statusClass('unknown')).toBe('');
});

// ─── escHtml ──────────────────────────────────────────────────
console.log('\n── escHtml ──────────────────────────────────────────────');

test('< > をエスケープする', () => {
  expect(escHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
});
test('& をエスケープする', () => {
  expect(escHtml('A & B')).toBe('A &amp; B');
});
test('" をエスケープする', () => {
  expect(escHtml('"value"')).toBe('&quot;value&quot;');
});
test('null は空文字として扱う', () => {
  expect(escHtml(null)).toBe('');
});
test('undefined は空文字として扱う', () => {
  expect(escHtml(undefined)).toBe('');
});
test('日本語テキストはそのまま', () => {
  expect(escHtml('東京本社ビル')).toBe('東京本社ビル');
});

// ─── buildPayload ロジック（フォームなし版）────────────────────
console.log('\n── buildPayload（ロジック）────────────────────────────────');

// sites.js の buildSitePayload（本物）をテストする
const buildPayloadLogic = buildSitePayload;

test('空の optional フィールドは null になる', () => {
  const p = buildPayloadLogic({ name: 'テスト', client: '', address: '', status: 'active' });
  expect(p.client).toBe(null);
  expect(p.address).toBe(null);
});
test('budget_yen が数値文字列の場合は整数に変換される', () => {
  const p = buildPayloadLogic({ name: 'A', budget_yen: '5000000', status: 'active' });
  expect(p.budget_yen).toBe(5000000);
});
test('budget_yen が空文字の場合は null になる', () => {
  const p = buildPayloadLogic({ name: 'A', budget_yen: '', status: 'active' });
  expect(p.budget_yen).toBe(null);
});
test('status が未指定のとき active になる', () => {
  const p = buildPayloadLogic({ name: 'A' });
  expect(p.status).toBe('active');
});
test('name はそのまま保持される', () => {
  const p = buildPayloadLogic({ name: 'トヨタ分室', status: 'active' });
  expect(p.name).toBe('トヨタ分室');
});

// ─── Summary ─────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
const total = _pass + _fail;
console.log(`  ${_pass} passed, ${_fail} failed  (total: ${total})\n`);
if (_fail > 0) process.exit(1);
