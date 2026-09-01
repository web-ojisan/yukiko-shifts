// dates.js — 日付ユーティリティ
// 日付は 'YYYY-MM-DD' 文字列と Date オブジェクトの2形態を扱う。

export const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** Date → 'YYYY-MM-DD' */
export function fmtDate(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** ISO 8601 文字列 → 'YYYY-MM-DD'（日付部分のみ抽出） */
export function parseWorkDate(isoStr) {
  return String(isoStr).substring(0, 10);
}

/** 基準日を含む週の月曜〜日曜の Date 配列を返す */
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

/** Date → 'M/D' */
export function fmtMonthDay(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }

/** 'YYYY-MM-DD' → 'Y年M月D日' */
export function fmtDateJa(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

/** Date → 'Y年M月D日' */
export function fmtFull(d) { return fmtDateJa(fmtDate(d)); }
