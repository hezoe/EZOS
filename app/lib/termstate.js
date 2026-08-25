// ターミナル(tmux)上のClaude Codeの状態を画面から読み取り、確認プロンプトを解析する。
// 送信も tmux send-keys 経由なので、ブラウザの接続有無に依存せず制御できる。
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { txa } from './tmux.js';

const pexec = promisify(execFile);
const HAS_TMUX = fs.existsSync('/usr/bin/tmux');
const HOME = process.env.HOME || '/home/debian';
const HOST = (process.env.HOSTNAME || os.hostname() || '').split('.')[0];

// pane_title(端末が OSC で設定するタイトル)から作業内容ラベルを取り出す。
// Claude Code は現在の作業要約を pane_title に入れる(例:「navlogプロジェクトで…」)ので、
// これをタブに出すと cwd を移動しなくても端末ごとに何をしているか見分けられる。
// 先頭のスピナー記号(点字ブレイル ⠂/⠐ 等・✳ ✻ · * などの回転文字)と空白は削る。
const SPINNER_RE = /^[\s⠀-⣿·•✻✽✢✶✳✷✺✦✴✷⋆∗*∘◦]+/u;
const SHELLS = new Set(['claude', 'bash', 'sh', 'zsh', '-bash', 'fish', 'node', 'tmux']);
function cleanTitle(raw) {
  const s = String(raw || '').trim().replace(SPINNER_RE, '').trim();
  // 使えるラベルか判定: 空/パス/~/ホスト名/素のシェル名は「作業内容ではない」ので不採用。
  if (!s || s === '~' || /^[/~]/.test(s)) return '';
  if (s === HOST || SHELLS.has(s.toLowerCase())) return '';
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// パスから表示用ディレクトリ名を作る (ホームは ~)
function dirName(path) {
  if (!path) return '';
  const p = path.replace(/\/+$/, '');
  if (p === HOME) return '~';
  return p.split('/').pop() || '/';
}

// cwd から「作業プロジェクト名」を導く。末尾のサブディレクトリ名ではなく、
// プロジェクトのルート名を返すので、プロジェクト内のどこにいても同じ名前になる。
//  1) 最寄りの .git を持つ祖先(=リポジトリルート)の名前。例: navlog/EZOS/Takikawa-WEB
//  2) 無ければ ~ または ~/workspace 直下のディレクトリ名(git管理外のプロジェクト。例: pAIP)
//  3) いずれにも当てはまらなければ従来どおり末尾ディレクトリ名
function projectName(path) {
  if (!path) return '';
  const p = path.replace(/\/+$/, '');
  if (p === HOME) return '~';

  // 1) 最寄りの .git を持つ祖先を探す(HOME自体・ルートは除外)
  let dir = p;
  while (dir && dir !== '/' && dir !== HOME) {
    try { if (fs.existsSync(`${dir}/.git`)) return dir.split('/').pop() || dir; } catch { /* noop */ }
    const up = dir.slice(0, dir.lastIndexOf('/'));
    if (!up || up === dir) break;
    dir = up;
  }

  // 2) ~ / ~/workspace 直下のプロジェクトディレクトリ名(より深い workspace を優先)
  for (const base of [`${HOME}/workspace`, HOME]) {
    if (p === base) return dirName(p);
    if (p.startsWith(`${base}/`)) return p.slice(base.length + 1).split('/')[0];
  }

  // 3) それ以外は末尾ディレクトリ名(従来動作)
  return dirName(p);
}

/** 各ターミナルのタブ表示名を { sid: 名前 } で返す。
   Claude Code が pane_title に入れる作業要約を優先し(cd不要で作業内容を出し分け)、
   要約が無い素の端末では cwd から導いた作業プロジェクト名にフォールバックする。 */
export async function getTitles() {
  if (!HAS_TMUX) return {};
  try {
    // pane_title / pane_current_path はスペースや `::` を含みうるので \x1f 区切りにする
    const { stdout } = await pexec('tmux', txa(['list-sessions', '-F', '#{session_name}\x1f#{pane_title}\x1f#{pane_current_path}']));
    const out = {};
    for (const line of stdout.split('\n')) {
      const [name, title, cwd] = line.split('\x1f');
      if (!name || !name.startsWith('ez_')) continue;
      out[name.slice(3)] = cleanTitle(title) || projectName(cwd || '');
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
    const { stdout } = await pexec('tmux', txa(['display-message', '-p', '-t', `ez_${name}`, '#{pane_current_path}']));
    const dir = stdout.trim();
    return dir || null;
  } catch {
    return null;
  }
}

/** 指定sidのtmuxセッションを、指定ディレクトリで事前生成する(EZbrowserからの端末追加用)。
   kind==='claude' なら生成後に対話シェルへ `claude` を送って起動する(PATH解決を確実に)。 */
export async function createSession(sid, dir, kind) {
  if (!HAS_TMUX) return;
  const name = sanitizeSid(sid);
  if (!name) return;
  const args = ['new-session', '-d', '-s', `ez_${name}`, '-x', '220', '-y', '50'];
  if (dir) args.push('-c', dir);
  try { await pexec('tmux', txa(args)); } catch { return; } // 既存/失敗時は素のまま(WS接続時に既定生成)
  if (kind === 'claude') {
    try { await pexec('tmux', txa(['send-keys', '-t', `ez_${name}`, 'claude', 'Enter'])); } catch { /* noop */ }
  }
}

/** ez_ プレフィックスのtmuxセッション一覧(=各ターミナルタブ)のsidを返す */
export async function listSids() {
  if (!HAS_TMUX) return [];
  try {
    const { stdout } = await pexec('tmux', txa(['list-sessions', '-F', '#{session_name}']));
    return stdout.split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('ez_'))
      .map((s) => s.slice(3));
  } catch {
    return [];
  }
}

async function capturePane(sid) {
  const { stdout } = await pexec('tmux', txa(['capture-pane', '-p', '-t', `ez_${sanitizeSid(sid)}`]));
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

// 自由文の英字選択肢(例: 「- A. …」「B) …」)。TUIの連番メニューではなく、
// Claudeが本文で「A / B のどちらにしますか」と尋ねて入力待ち(idle)になっている状況を拾う。
// 誤検知を避けるため英字(A,B,C…)限定・A始まり連続・直前に選択を促す手がかりが必要。
const LETTER_OPT_RE = /^\s*(?:[-*・]\s*)?([A-Z])[.．)、]\s+(\S.*)$/u;
const CHOICE_CUE_RE = /(選ん|選択|お選び|どちら|いずれ|どれ|進めます|choose|select|option)/i;

/** idle(入力待ち)のペインから、本文中の英字選択肢(A/B/…)を解析する。
   選択肢が見つからなければ null(=通常のidle)。 */
function parseLetterChoices(lines) {
  // 末尾側(入力欄の直上)にある英字リストを拾う。同じ文字は後方(最新描画)優先。
  const byL = new Map(); // letter -> { text, idx }
  lines.forEach((line, idx) => {
    const m = LETTER_OPT_RE.exec(line);
    if (m) byL.set(m[1], { text: m[2], idx });
  });
  // A から連続している分だけを選択肢列として採用(最大6=A..F)
  const seq = [];
  for (let c = 0; c < 6; c += 1) {
    const L = String.fromCharCode(65 + c);
    if (!byL.has(L)) break;
    seq.push({ letter: L, ...byL.get(L) });
  }
  if (seq.length < 2) return null;

  // 手がかり: 最初の選択肢の少し上に「?/？」で終わる疑問文、または選択を促す語があること。
  // 単なる「:」終わりの見出し(例「ファイル構成:」)は箇条書きでも多発するので手がかりにしない。
  let question = '';
  let hasCue = false;
  for (let i = seq[0].idx - 1; i >= 0 && i >= seq[0].idx - 12; i -= 1) {
    const t = lines[i].trim();
    if (!t) continue;
    const isQ = /[?？]$/.test(t);
    if (isQ || CHOICE_CUE_RE.test(t)) {
      hasCue = true;
      if (!question) question = t.replace(/[:：]$/, '').trim();
      if (isQ) { question = t; break; } // 疑問文を最優先
    }
  }
  if (!hasCue) return null;

  return {
    state: 'confirm',
    freeform: true, // 送信は番号キーではなく「英字＋Enter」
    question,
    options: seq.map((o, i) => ({
      n: i + 1,
      letter: o.letter,
      text: o.text.replace(/\s*[…。]+\s*$/u, '').trim().slice(0, 120),
      kind: kindOf(o.text),
    })),
  };
}

// 実行中の指標(いずれか1つでも出ていれば作業中とみなす):
//  1) 「esc to interrupt」割り込み案内
//  2) 「↑/↓ Nk tokens」トークンカウンタ(ライブのスピナー行にのみ出る)
//  3) 「to run in background)」前景でシェルコマンド実行中の案内
//  4) スピナー行: 行頭のスピナー字(✻ ✽ · 等)+ 現在進行形(「…」で終わる)。
//     例: 「✻ Considering…」「· Caramelizing… (10s · thinking)」(トークン数が無い思考中も拾う)。
//     行頭(^)限定なので、フッター内の中黒「… · ← for agents」等では誤検知しない。
//     ※完了サマリ「✻ Brewed for 7s」は「…」が無いので除外される。
//     ※スクロールバックの完了行「  - foo… (13s · 5 lines)」は行頭がスピナー字でないので除外。
//  5) 「Running N shell command…」ツール実行中の行(フェーズ境界の保険)。
//     完了すると「Ran N shell command」(過去形・「…」無し)に変わるので idle を潰さない。
//     ※経過時間だけの緩い条件は使わない(scrollbackの「(13s · 5 lines)」でidleを潰さないため)。
const RUNNING_RE = /esc to interrupt|[↑↓]\s*[\d.]+k?\s+tokens|to run in background\)|Running \d+ \w+ commands?|^[ \t]*[·•✻✽✢✶✳✷✺✦✴✷⋆∗*]\s+\S[^\n]*(?:…|\.\.\.)/im;

// プロンプト入力ボックスの検出。現行UIは「❯」の行が「────」罫線で上下を囲まれている。
// これがあれば(実行中でなければ)入力待ち=idle とみなす。
function hasInputBox(lines) {
  const isBorder = (s) => /^\s*[─—-]{10,}\s*$/.test(s);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*❯/.test(lines[i]) && (isBorder(lines[i - 1] || '') || isBorder(lines[i + 1] || ''))) {
      return true;
    }
  }
  return false;
}

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

  // 実行中: 「esc to interrupt」または スピナーの経過時間/トークンカウンタ
  // (例: 「✢ Cerebrating… (33s · ↓ 1.5k tokens)」)を検出。
  if (RUNNING_RE.test(text)) return { state: 'running' };

  // 入力待ち: プロンプト入力ボックス(❯ が ─── 罫線で囲まれている)があれば idle。
  // 旧UIの「? for shortcuts」にも後方互換で対応。本文にA/B選択肢があれば confirm(freeform)。
  if (hasInputBox(lines) || /\? for shortcuts/i.test(text)) {
    return parseLetterChoices(lines) || { state: 'idle' };
  }
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

// 自由文の英字選択(A..F)への回答: 文字を入力して Enter で送信する。
const ANS_RE = /^ans([A-F])$/;

/** 指定ターミナルへ制御キーを送信 */
export async function sendKey(sid, key) {
  if (!HAS_TMUX) throw new Error('tmux未対応の環境です');
  const s = sanitizeSid(sid);
  if (!s) throw new Error('不正なキーです');

  // 英字選択肢への回答(freeform): 「A」を打鍵してから Enter で確定
  const am = ANS_RE.exec(String(key));
  if (am) {
    await pexec('tmux', txa(['send-keys', '-t', `ez_${s}`, '-l', am[1]]));
    await pexec('tmux', txa(['send-keys', '-t', `ez_${s}`, 'Enter']));
    return;
  }

  const spec = KEY_MAP[key];
  if (!spec) throw new Error('不正なキーです');
  await pexec('tmux', txa(['send-keys', '-t', `ez_${s}`, ...spec]));
}

/** 指定ターミナルのtmuxセッションを破棄 (存在しなくてもエラーにしない) */
export async function killSession(sid) {
  if (!HAS_TMUX) return;
  const s = sanitizeSid(sid);
  if (!s) return;
  try { await pexec('tmux', txa(['kill-session', '-t', `ez_${s}`])); } catch { /* 既に無い */ }
}
