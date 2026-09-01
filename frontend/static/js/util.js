// util.js — 画面共通ユーティリティ

/** HTMLエスケープ（テンプレートリテラルに値を埋め込む前に必ず通す） */
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
