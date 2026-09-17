// 実行環境の差(ディストリ・ユーザー名・コマンド設置先)を吸収するヘルパー。
// 特定のOS/ユーザー(例: /home/debian, /usr/bin/tmux)を前提にせず、実行時に解決する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 実行ユーザーのホーム。$HOME が無ければ passwd から引く(os.homedir)
export const HOME = process.env.HOME || os.homedir();

// PATH 上にコマンドがあるか(/usr/bin, /usr/local/bin, /opt/homebrew/bin 等どこでも可)
export function hasCommand(name) {
  for (const dir of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* 次へ */ }
  }
  return false;
}

export const HAS_TMUX = hasCommand('tmux');

// tmux 不在時に使うログインシェル(bash の無い環境もあるため passwd/$SHELL に従う)
export const LOGIN_SHELL = (() => {
  let sh = '';
  try { sh = os.userInfo().shell || ''; } catch { /* 取得不可 */ }
  if (!sh || /nologin|false$/.test(sh)) sh = process.env.SHELL || '';
  if (sh && fs.existsSync(sh)) return sh;
  return hasCommand('bash') ? 'bash' : 'sh';
})();
