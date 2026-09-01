/**
 * board.test.js — board.js のユニットテスト（本物のコードをimportしてテストする）
 *
 * ブラウザ / Node.js 両対応の簡易テストランナー。
 * Node.js で実行:  node frontend/static/js/board.test.js
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
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b)
        throw new Error(`expected ${b}, got ${a}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy, got ${actual}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`expected null, got ${actual}`);
    },
    toHaveLength(n) {
      if ((actual ?? []).length !== n)
        throw new Error(`expected length ${n}, got ${(actual ?? []).length}`);
    },
    toContain(str) {
      if (!String(actual).includes(str))
        throw new Error(`expected "${actual}" to contain "${str}"`);
    },
  };
}

// ─── 本物のコードを import してテストする ─────────────────────
import { fmtDate, parseWorkDate, getWeekDates, groupWeek, groupDay, escHtml } from './board.js';

// ─── Test suites ──────────────────────────────────────────────

console.log('\n── fmtDate ──────────────────────────────────────────────');
test('2026-04-16 を正しくフォーマットする', () => {
  const d = new Date(2026, 3, 16); // month is 0-based
  expect(fmtDate(d)).toBe('2026-04-16');
});
test('1桁の月・日をゼロパディングする', () => {
  const d = new Date(2026, 0, 5);
  expect(fmtDate(d)).toBe('2026-01-05');
});
test('12月31日を正しくフォーマットする', () => {
  const d = new Date(2026, 11, 31);
  expect(fmtDate(d)).toBe('2026-12-31');
});

console.log('\n── parseWorkDate ────────────────────────────────────────');
test('ISO 8601 文字列から日付部分を抽出する', () => {
  expect(parseWorkDate('2026-04-16T00:00:00Z')).toBe('2026-04-16');
});
test('既に YYYY-MM-DD のものはそのまま返す', () => {
  expect(parseWorkDate('2026-04-16')).toBe('2026-04-16');
});

console.log('\n── getWeekDates ─────────────────────────────────────────');
test('月曜日を起点に7日分を返す', () => {
  const thu = new Date(2026, 3, 16); // Thursday
  const dates = getWeekDates(thu);
  expect(dates).toHaveLength(7);
  expect(fmtDate(dates[0])).toBe('2026-04-13'); // Monday
  expect(fmtDate(dates[6])).toBe('2026-04-19'); // Sunday
});
test('月曜日から始めると月曜日が先頭になる', () => {
  const mon = new Date(2026, 3, 13);
  const dates = getWeekDates(mon);
  expect(fmtDate(dates[0])).toBe('2026-04-13');
});
test('日曜日の場合は前週月曜日が先頭', () => {
  const sun = new Date(2026, 3, 19); // Sunday
  const dates = getWeekDates(sun);
  expect(fmtDate(dates[0])).toBe('2026-04-13'); // Monday of that week
});
test('各日付の曜日が月〜日の順', () => {
  const ref = new Date(2026, 3, 16);
  const dates = getWeekDates(ref);
  const dows = dates.map(d => d.getDay());
  expect(dows).toEqual([1, 2, 3, 4, 5, 6, 0]); // Mon=1 ... Sun=0
});

console.log('\n── groupWeek ────────────────────────────────────────────');

const SAMPLE_ASSIGNS = [
  { id: 1, site_id: 1, site_name: 'トヨタ分室', user_id: 4, user_name: '田中 太郎', work_date: '2026-04-14T00:00:00Z', time_slot: 'AM' },
  { id: 2, site_id: 1, site_name: 'トヨタ分室', user_id: 5, user_name: '佐藤 花子', work_date: '2026-04-14T00:00:00Z', time_slot: 'PM' },
  { id: 3, site_id: 2, site_name: '東京本社ビル', user_id: 6, user_name: '鈴木 一郎', work_date: '2026-04-15T00:00:00Z', time_slot: 'ALL' },
];

test('現場ごとにグループ化される', () => {
  const g = groupWeek(SAMPLE_ASSIGNS);
  expect(Object.keys(g)).toHaveLength(2);
  expect(g['1'].name).toBe('トヨタ分室');
  expect(g['2'].name).toBe('東京本社ビル');
});

test('同日・同現場のアサインが1セルにまとまる', () => {
  const g = groupWeek(SAMPLE_ASSIGNS);
  expect(g['1'].days['2026-04-14']).toHaveLength(2);
});

test('別日のアサインは別セルに入る', () => {
  const g = groupWeek(SAMPLE_ASSIGNS);
  expect(g['2'].days['2026-04-15']).toHaveLength(1);
});

test('アサインがゼロの場合は空オブジェクト', () => {
  const g = groupWeek([]);
  expect(Object.keys(g)).toHaveLength(0);
});

console.log('\n── groupDay ─────────────────────────────────────────────');
test('指定日のアサインのみ返す', () => {
  const g = groupDay(SAMPLE_ASSIGNS, '2026-04-14');
  expect(Object.keys(g)).toHaveLength(1);
  expect(g['1'].name).toBe('トヨタ分室');
});

test('cards 配列に全アサインが含まれる', () => {
  const g = groupDay(SAMPLE_ASSIGNS, '2026-04-14');
  expect(g['1'].cards).toHaveLength(2);
});

test('別日のアサインは含まれない', () => {
  const g = groupDay(SAMPLE_ASSIGNS, '2026-04-16');
  expect(Object.keys(g)).toHaveLength(0);
});

test('カードに time_slot が保持される', () => {
  const g = groupDay(SAMPLE_ASSIGNS, '2026-04-15');
  expect(g['2'].cards).toHaveLength(1);
  expect(g['2'].cards[0].time_slot).toBe('ALL');
});

console.log('\n── escHtml ──────────────────────────────────────────────');
test('< と > をエスケープする', () => {
  expect(escHtml('<script>')).toBe('&lt;script&gt;');
});
test('& をエスケープする', () => {
  expect(escHtml('A & B')).toBe('A &amp; B');
});
test('" をエスケープする', () => {
  expect(escHtml('"value"')).toBe('&quot;value&quot;');
});
test('プレーンテキストはそのまま返す', () => {
  expect(escHtml('田中 太郎')).toBe('田中 太郎');
});

// ─── Summary ─────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
const total = _pass + _fail;
console.log(`  ${_pass} passed, ${_fail} failed  (total: ${total})\n`);
if (_fail > 0) process.exit(1);
