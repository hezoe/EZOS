// tmux サーバーソケットの分離。
// tmux の既定ソケットは OS ユーザー(UID)単位で1つのため、同一ユーザーで複数の
// EZOS を動かすと、どのインストールも同じ tmux サーバー・同じ `ez_*` セッション名を
// 共有してしまい、別ホスト名でもターミナルが同期してしまう。
// インストールごとに専用ソケット(-L ezos<port>)を使うことで完全に分離する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let port = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
  port = String(cfg.port || '');
} catch { /* config未生成時は既定ラベル */ }

// このインストール専用の tmux サーバーソケット名(ポートで一意化)
export const TMUX_LABEL = `ezos${port}`;

// Claude Code の「セッション recap(away summary)」を EZOS の全ターミナルで無効化する。
// EZOS が起動する tmux サーバーはこの Node プロセスの環境を継承し、配下の全 pane
// (手動/自動どちらで起動した claude でも)へ伝播する。既定ONのため 0 で明示オフにする。
// (Claude Code v2.1系: CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0 でオプトアウト)
if (!process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY) {
  process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY = '0';
}

// tmux 引数の先頭に付けるソケット指定。全ての tmux 呼び出しでこれを前置する。
export const TMUX_ARGS = ['-L', TMUX_LABEL];

// tmux コマンド引数を、ソケット指定を前置して組み立てる
export const txa = (rest) => [...TMUX_ARGS, ...rest];
