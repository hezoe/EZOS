// EZbrowser 用のファイル操作ヘルパー。すべての操作を /home/debian 配下に限定する。
// realpath 検証で ../ とシンボリックリンクによるルート脱出を遮断する。
import fs from 'node:fs';
import path from 'node:path';

// 許可ルート。起動時に一度だけ realpath で正規化して保持する。
export const REAL_ROOT = (() => {
  try { return fs.realpathSync(process.env.HOME || '/home/debian'); }
  catch { return process.env.HOME || '/home/debian'; }
})();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function within(p, root) { return p === root || p.startsWith(root + path.sep); }

// 入力パスを解決し「許可ルート内」であることを検証して返す。
// mustExist: 既存パス → realpath 全展開して検証。
// !mustExist: 新規作成対象 → 親を realpath 検証し、basename を再構成(../等を拒否)。
export async function safePath(input, { mustExist = true } = {}) {
  const abs = path.resolve(REAL_ROOT, String(input == null ? '.' : input));
  if (mustExist) {
    let real;
    try { real = await fs.promises.realpath(abs); }
    catch { throw new HttpError(404, '見つかりません'); }
    if (!within(real, REAL_ROOT)) throw new HttpError(403, 'アクセスできない場所です');
    return real;
  }
  let parent;
  try { parent = await fs.promises.realpath(path.dirname(abs)); }
  catch { throw new HttpError(404, '親フォルダがありません'); }
  if (!within(parent, REAL_ROOT)) throw new HttpError(403, 'アクセスできない場所です');
  const name = path.basename(abs);
  if (!name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) {
    throw new HttpError(400, '不正な名前です');
  }
  return path.join(parent, name);
}

// dir(親フォルダ) と basename から、許可ルート内の既存パスを検証して返す。
// 複数対象(削除/DL/アーカイブ)で親を1回検証し、各名前は basename に限定する。
export async function childPath(dir, name, { mustExist = true } = {}) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) {
    throw new HttpError(400, '不正な名前です');
  }
  return safePath(path.join(dir, name), { mustExist });
}

const EDITABLE_EXT = /\.(txt|md|markdown|json|html?|css|js|mjs|cjs|jsx|ts|tsx|xml|yml|yaml|csv|log|sh|bash|zsh|py|rb|go|rs|c|h|cpp|java|php|sql|conf|cfg|ini|env|toml|svg|gitignore)$/i;
export function isEditableName(name) {
  return EDITABLE_EXT.test(name) || !path.extname(name); // 拡張子なし(READMEやドットファイル)も編集可
}

// 先頭 8KB に NUL バイトが無ければテキストとみなす。
export function isTextFile(buf) {
  return !buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

// dirent/stat から一覧エントリを組み立てる。
export async function statEntry(dir, name) {
  const full = path.join(dir, name);
  const ls = await fs.promises.lstat(full);
  const isSymlink = ls.isSymbolicLink();
  let st = ls;
  if (isSymlink) { try { st = await fs.promises.stat(full); } catch { st = ls; } }
  return {
    name,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    mtime: st.mtimeMs,
    mode: st.mode & 0o777,
    isSymlink,
    editable: st.isFile() && isEditableName(name),
  };
}
