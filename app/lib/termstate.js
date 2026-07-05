// ターミナル(tmux)上のClaude Codeの状態を画面から読み取り、確認プロンプトを解析する。
// 送信も tmux send-keys 経由なので、ブラウザの接続有無に依存せず制御できる。
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const HAS_TMUX = fs.existsSync('/usr/bin/tmux');
const HOME = process.env.HOME || '/home/debian';

// パスから表示用ディレクトリ名を作る (ホームは ~)
function dirName(path) {
  if (!path) return '';
  const p = path.replace(/\/+$/, '');
  if (p === HOME) return '~';
  return p.split('/').pop() || '/';
}

/** 各ターミナルの現在ディレクトリ名を { sid: 名前 } で返す (cdに追従) */
export async function getTitles() {
  if (!HAS_TMUX) return {};
  try {
    const { stdout } = await pexec('tmux', ['list-sessions', '-F', '#{session_name}::#{pane_current_path}']);
    const out = {};
    for (const line of stdout.split('\n')) {
      const i = line.indexOf('::');
      if (i < 0) continue;
      const name = line.slice(0, i);
      if (name.startsWith('ez_')) out[name.slice(3)] = dirName(line.slice(i + 2));
    }
    return out;
  } catch {
    return {};
  }
}

const sanitizeSid = (s) => String(s || '').replace(/[^\w-]/g, '').slice(0, 20);

/** 指定sidのターミナルの現在ディレクトリ(絶対パス)を返す。取得不可なら null */
export async function getCwd(sid) {
  if (!HAS_TMUX) return null;
  const name = sanitizeSid(sid);
  if (!name) return null;
  try {
    const { stdout } = await pexec('tmux', ['display-message', '-p', '-t', `ez_${name}`, '#{pane_current_path}']);
    const dir = stdout.trim();
    return dir || null;
  } catch {
    return null;
  }
}

/** ez_ プレフィックスのtmuxセッション一覧(=各ターミナルタブ)のsidを返す */
export async function listSids() {
  if (!HAS_TMUX) return [];
  try {
    const { stdout } = await pexec('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('ez_'))
      .map((s) => s.slice(3));
  } catch {
    return [];
  }
}

async function capturePane(sid) {
  const { stdout } = await pexec('tmux', ['capture-pane', '-p', '-t', `ez_${sanitizeSid(sid)}`]);
  return stdout;
}

// 選択肢テキストから種別を推定 (ボタンの色分け・ラベルに使う)
function kindOf(text) {
  const t = text.toLowerCase();
  if (/^\s*no\b/.test(t) || /\bno[,.]/.test(t)) return 'reject';
  if (/(all|session|don'?t ask|every time|auto)/.test(t)) return 'accept_all';
  if (/\byes\b/.test(t)) return 'accept';
  return 'other';
}

const OPT_RE = /^(\s*)(❯\s*)?([1-9])\.\s+(.+?)\s*$/u;

/** capture-paneのテキストを状態オブジェクトに変換 */
export function parsePane(text) {
  const lines = text.replace(/\r/g, '').split('\n');

  // 連番メニュー(❯付き)を探す
  const byN = new Map(); // n -> {text, selected, idx}
  let hasCursor = false;
  lines.forEach((line, idx) => {
    const m = OPT_RE.exec(line);
    if (!m) return;
    const selected = !!m[2];
    if (selected) hasCursor = true;
    byN.set(Number(m[3]), { text: m[4], selected, idx }); // 同番号は後方(最新描画)優先
  });

  // 1から連続していて、かつ選択カーソル(❯)があれば確認メニューとみなす
  const menu = [];
  let k = 1;
  while (byN.has(k)) { menu.push({ n: k, ...byN.get(k) }); k += 1; }

  if (menu.length >= 2 && hasCursor) {
    // 質問文: 最初の選択肢の直前で '?' で終わる行
    let question = '';
    for (let i = menu[0].idx - 1; i >= 0 && i >= menu[0].idx - 8; i -= 1) {
      const t = lines[i].trim();
      if (t.endsWith('?')) { question = t; break; }
    }
    return {
      state: 'confirm',
      question,
      options: menu.map((o) => ({
        n: o.n,
        text: o.text.replace(/\s*\((?:shift\+tab|esc|tab)[^)]*\)\s*$/i, '').trim(),
        kind: kindOf(o.text),
      })),
    };
  }

  if (/esc to interrupt/i.test(text)) return { state: 'running' };
  if (/\? for shortcuts/i.test(text)) return { state: 'idle' };
  return { state: 'unknown' };
}

/** 全ターミナルの状態を { sid: stateObj } で返す */
export async function getStates() {
  const sids = await listSids();
  const out = {};
  await Promise.all(sids.map(async (sid) => {
    try {
      out[sid] = parsePane(await capturePane(sid));
    } catch {
      out[sid] = { state: 'unknown' };
    }
  }));
  return out;
}

// 送信可能なキー(ホワイトリスト)。任意文字列の注入は許さない
const KEY_MAP = {
  1: ['-l', '1'], 2: ['-l', '2'], 3: ['-l', '3'], 4: ['-l', '4'], 5: ['-l', '5'],
  6: ['-l', '6'], 7: ['-l', '7'], 8: ['-l', '8'], 9: ['-l', '9'],
  escape: ['Escape'], enter: ['Enter'], up: ['Up'], down: ['Down'], interrupt: ['C-c'],
};

/** 指定ターミナルへ制御キーを送信 */
export async function sendKey(sid, key) {
  if (!HAS_TMUX) throw new Error('tmux未対応の環境です');
  const s = sanitizeSid(sid);
  const spec = KEY_MAP[key];
  if (!s || !spec) throw new Error('不正なキーです');
  await pexec('tmux', ['send-keys', '-t', `ez_${s}`, ...spec]);
}

/** 指定ターミナルのtmuxセッションを破棄 (存在しなくてもエラーにしない) */
export async function killSession(sid) {
  if (!HAS_TMUX) return;
  const s = sanitizeSid(sid);
  if (!s) return;
  try { await pexec('tmux', ['kill-session', '-t', `ez_${s}`]); } catch { /* 既に無い */ }
}
