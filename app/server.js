// EZOS サーバー: パスキー認証 + Claude Code チャット
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { ROOT, readJson, writeJson, loadConfig } from './lib/store.js';
import { runClaude } from './lib/claude.js';
import { createTermServer } from './lib/term.js';
import { getStates, sendKey, getTitles, getCwd, createSession } from './lib/termstate.js';
import { listTerminals, addTerminal, removeTerminal } from './lib/terminals.js';
import { REAL_ROOT, HttpError, safePath, childPath, isTextFile, statEntry } from './lib/filemgr.js';

const cfg = loadConfig();
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 認証まわり ---------------- */

const AUTH_TTL_MS = 30 * 24 * 3600 * 1000;
// challenge は短命なのでメモリ保持でよい
const challenges = new Map(); // id -> { challenge, purpose, expires }

function newChallengeId(challenge, purpose) {
  const id = randomUUID();
  challenges.set(id, { challenge, purpose, expires: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of challenges) {
    if (v.expires < Date.now()) challenges.delete(k);
  }
  return id;
}

function takeChallenge(id, purpose) {
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.purpose !== purpose || c.expires < Date.now()) return null;
  return c.challenge;
}

function getAuthTokens() {
  return readJson('auth_tokens.json', {});
}

function issueAuthToken() {
  const tokens = getAuthTokens();
  const now = Date.now();
  for (const [t, exp] of Object.entries(tokens)) {
    if (exp < now) delete tokens[t];
  }
  const token = randomBytes(32).toString('base64url');
  tokens[token] = now + AUTH_TTL_MS;
  writeJson('auth_tokens.json', tokens);
  return token;
}

function isAuthed(req) {
  const m = /(?:^|;\s*)ezsess=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const exp = getAuthTokens()[m[1]];
  return typeof exp === 'number' && exp > Date.now();
}

function getCredentials() {
  return readJson('credentials.json', []);
}

/* ---------------- 会話ストレージ ---------------- */

function getConversations() {
  return readJson('conversations.json', []);
}

// conversations.json は関連APIごとに丸ごとメモリへ読み込まれる正本なので、際限なく
// 膨らむと(特に Claude の長大な出力や巨大な貼り付けで)そのままヒープを圧迫する。
// 保存のたびに次の3段で上限をかけ、常駐サイズを一定に保つ。UIの表示履歴を削るだけで、
// Claude 側の会話継続(claudeSessionId 経由)には影響しない。
const MAX_MSG_CHARS = 200 * 1024;   // 1メッセージあたりの保持文字数(巨大出力/貼り付けの丸め)
const MAX_MSGS_PER_CONV = 400;      // 1会話で保持する直近メッセージ数
const MAX_CONVS = 100;              // 保持する会話数(古いものから間引く)

function trimConversations(list) {
  const recent = list
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_CONVS);
  for (const conv of recent) {
    if (!Array.isArray(conv.messages)) continue;
    if (conv.messages.length > MAX_MSGS_PER_CONV) {
      conv.messages = conv.messages.slice(-MAX_MSGS_PER_CONV);
    }
    for (const m of conv.messages) {
      if (typeof m.text === 'string' && m.text.length > MAX_MSG_CHARS) {
        m.text = m.text.slice(0, MAX_MSG_CHARS) + '\n…(省略: 表示履歴を短縮しました)';
      }
    }
  }
  return recent;
}

function saveConversations(list) {
  writeJson('conversations.json', trimConversations(list));
}

/* ---------------- HTTPユーティリティ ---------------- */

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// 生バイトのボディを Buffer で読む(ファイルアップロード用)。上限超過は 'body too large' で reject
async function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// dir配下に base 名で衝突しない安全なパスを返す(new→new-2, foo.txt→foo-2.txt ...)
async function uniqueChild(dir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 1000; i += 1) {
    const name = i === 1 ? base : `${stem}-${i}${ext}`;
    const dest = await childPath(dir, name, { mustExist: false });
    try { await fs.promises.access(dest); } catch { return dest; } // 存在しなければ採用
  }
  throw new HttpError(409, '名前が重複しています');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isMobileUA(ua) {
  return /iPhone|iPod|Windows Phone|webOS|BlackBerry|Android.+Mobile/i.test(ua || '');
}

// UA判定 + クッキー/クエリによる表示モード ('mobile' | 'desktop')
function viewMode(req, res, url) {
  const auto = isMobileUA(req.headers['user-agent']) ? 'mobile' : 'desktop';
  const q = url.searchParams.get('view');
  if (q === 'mobile' || q === 'desktop') {
    res.setHeader('Set-Cookie',
      `ezview=${q}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`);
    return q;
  }
  if (q === 'auto') {
    res.setHeader('Set-Cookie', 'ezview=; Path=/; Max-Age=0; Secure; SameSite=Lax');
    return auto;
  }
  const m = /(?:^|;\s*)ezview=(mobile|desktop)/.exec(req.headers.cookie || '');
  return m ? m[1] : auto;
}

/* ---------------- 実行中チャットの管理 ---------------- */

const running = new Map(); // convId -> { kill }

/* ---------------- サーバー ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  try {
    // xterm.js (node_modules から配信)
    const vendor = {
      '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
      '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
      '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
      '/vendor/addon-clipboard.js': ['node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js', 'text/javascript'],
      '/vendor/addon-web-links.js': ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'text/javascript'],
    };
    if (vendor[p]) {
      const [rel, type] = vendor[p];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(path.join(ROOT, rel)).pipe(res);
      return;
    }

    // 静的アセット
    if (p.startsWith('/assets/')) {
      const file = path.join(PUBLIC_DIR, path.normalize(p.slice('/assets/'.length)));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const types = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
      res.writeHead(200, {
        'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // トップページ
    if (p === '/' && req.method === 'GET') {
      const view = viewMode(req, res, url);
      const authed = isAuthed(req);
      const hasCreds = getCredentials().length > 0;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPage({ authed, view, hasCreds }));
      return;
    }

    // ---- API ----
    if (!p.startsWith('/api/')) {
      res.writeHead(404).end('not found');
      return;
    }

    // CSRF対策: POSTは独自ヘッダー必須
    if (req.method === 'POST' && req.headers['x-requested-with'] !== 'ezos') {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    /* --- 認証不要のAPI --- */

    if (p === '/api/reg-options' && req.method === 'POST') {
      const body = await readBody(req);
      if (!isAuthed(req)) {
        if (body.setupKey !== cfg.setupKey) {
          await new Promise((r) => setTimeout(r, 1500));
          sendJson(res, 403, { error: 'セットアップキーが違います' });
          return;
        }
      }
      const creds = getCredentials();
      const options = await generateRegistrationOptions({
        rpName: 'EZOS',
        rpID: cfg.rpID,
        userName: cfg.userName,
        attestationType: 'none',
        excludeCredentials: creds.map((c) => ({ id: c.id })),
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      });
      const challengeId = newChallengeId(options.challenge, 'reg');
      sendJson(res, 200, { options, challengeId });
      return;
    }

    if (p === '/api/reg-verify' && req.method === 'POST') {
      const body = await readBody(req);
      const challenge = takeChallenge(body.challengeId, 'reg');
      if (!challenge) {
        sendJson(res, 400, { error: 'チャレンジが無効です。やり直してください' });
        return;
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.attResp,
          expectedChallenge: challenge,
          expectedOrigin: cfg.origin,
          expectedRPID: cfg.rpID,
          requireUserVerification: true,
        });
      } catch (e) {
        sendJson(res, 400, { error: '登録に失敗しました: ' + e.message });
        return;
      }
      if (!verification.verified) {
        sendJson(res, 400, { error: '検証に失敗しました' });
        return;
      }
      const { credential } = verification.registrationInfo;
      const creds = getCredentials();
      creds.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: body.attResp?.response?.transports ?? [],
        label: String(body.label || '').slice(0, 60) || `passkey-${new Date().toISOString().slice(0, 10)}`,
        createdAt: Date.now(),
      });
      writeJson('credentials.json', creds);
      const token = issueAuthToken();
      res.setHeader('Set-Cookie',
        `ezsess=${token}; Path=/; Max-Age=${AUTH_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/login-options' && req.method === 'POST') {
      const creds = getCredentials();
      if (!creds.length) {
        sendJson(res, 404, { error: 'パスキーが未登録です' });
        return;
      }
      const options = await generateAuthenticationOptions({
        rpID: cfg.rpID,
        userVerification: 'required',
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
      });
      const challengeId = newChallengeId(options.challenge, 'auth');
      sendJson(res, 200, { options, challengeId });
      return;
    }

    if (p === '/api/login-verify' && req.method === 'POST') {
      const body = await readBody(req);
      const challenge = takeChallenge(body.challengeId, 'auth');
      if (!challenge) {
        sendJson(res, 400, { error: 'チャレンジが無効です。やり直してください' });
        return;
      }
      const creds = getCredentials();
      const cred = creds.find((c) => c.id === body.authResp?.id);
      if (!cred) {
        sendJson(res, 403, { error: '未知のパスキーです' });
        return;
      }
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.authResp,
          expectedChallenge: challenge,
          expectedOrigin: cfg.origin,
          expectedRPID: cfg.rpID,
          requireUserVerification: true,
          credential: {
            id: cred.id,
            publicKey: Buffer.from(cred.publicKey, 'base64'),
            counter: cred.counter,
            transports: cred.transports,
          },
        });
      } catch (e) {
        sendJson(res, 403, { error: 'ログインに失敗しました: ' + e.message });
        return;
      }
      if (!verification.verified) {
        sendJson(res, 403, { error: '検証に失敗しました' });
        return;
      }
      cred.counter = verification.authenticationInfo.newCounter;
      writeJson('credentials.json', creds);
      const token = issueAuthToken();
      res.setHeader('Set-Cookie',
        `ezsess=${token}; Path=/; Max-Age=${AUTH_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* --- ここからログイン必須 --- */

    if (!isAuthed(req)) {
      sendJson(res, 401, { error: 'ログインが必要です' });
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'ezsess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/status' && req.method === 'GET') {
      // Claude Codeのログイン状態を軽く確認 (credentialsファイルの存在で判定)
      const home = process.env.HOME || '/home/debian';
      const loggedIn = fs.existsSync(path.join(home, '.claude', '.credentials.json'));
      sendJson(res, 200, { claudeLoggedIn: loggedIn });
      return;
    }

    /* --- EZeditor で開いているファイル一覧(全デバイス共有・永続) --- */
    // 端末タブと同じく「サーバーが正本」。どの端末で開いても同じ開き状態を引き継げる。
    if (p === '/api/editor/state' && req.method === 'GET') {
      const st = readJson('editor.json', { open: [], active: null });
      sendJson(res, 200, { open: Array.isArray(st.open) ? st.open : [], active: st.active || null });
      return;
    }
    if (p === '/api/editor/state' && req.method === 'POST') {
      const body = await readBody(req, 256 * 1024);
      try {
        // 実在＆REAL_ROOT配下のファイルだけ残す(削除済み/範囲外/重複は捨てる)
        const wanted = Array.isArray(body.open) ? body.open.slice(0, 100) : [];
        const open = [];
        for (const pth of wanted) {
          try {
            const abs = await safePath(pth); // mustExist=true。実在＆境界内のみ通過
            const st = await fs.promises.stat(abs);
            if (st.isFile() && !open.includes(abs)) open.push(abs);
          } catch { /* 無効なパスはスキップ */ }
        }
        let active = null;
        if (body.active) { try { const a = await safePath(body.active); if (open.includes(a)) active = a; } catch { /* skip */ } }
        writeJson('editor.json', { open, active, updatedAt: Date.now() });
        sendJson(res, 200, { ok: true, open, active });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    /* --- ターミナル一覧(全ブラウザ共有) + Claude状態 --- */

    // タブ構成 + 各ターミナルの状態をまとめて返す (全デバイスで同一)
    // タイトルは各ターミナルの現在ディレクトリ名 (cdに追従)。
    // 同じディレクトリが複数あるときは workspace1, workspace2 と枝番を付ける
    if (p === '/api/term/view' && req.method === 'GET') {
      try {
        const [terminals, states, titles] = await Promise.all([listTerminals(), getStates(), getTitles()]);
        const bases = terminals.map((t) => titles[t.sid] || t.title);
        const counts = {};
        bases.forEach((b) => { counts[b] = (counts[b] || 0) + 1; });
        const seen = {};
        sendJson(res, 200, {
          terminals: terminals.map((t, i) => {
            const b = bases[i];
            let title = b;
            if (counts[b] > 1) { seen[b] = (seen[b] || 0) + 1; title = `${b}${seen[b]}`; }
            return { sid: t.sid, title, ...(states[t.sid] || { state: 'unknown' }) };
          }),
        });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // 指定ターミナルの現在ディレクトリ(相対パスのファイルクリックをEZeditorで開く際の基準)
    if (p === '/api/term/cwd' && req.method === 'GET') {
      const cwd = await getCwd(url.searchParams.get('sid'));
      sendJson(res, 200, { cwd: cwd || null });
      return;
    }

    if (p === '/api/term/add' && req.method === 'POST') {
      const body = await readBody(req);
      const term = addTerminal(body.title);
      // EZbrowserからの追加: dir指定があればその場所でtmuxセッションを事前生成(CLI/Claude)
      if (body.dir) {
        try {
          const dir = await safePath(body.dir); // /home/debian 配下のみ
          await createSession(term.sid, dir, body.kind === 'claude' ? 'claude' : 'cli');
        } catch { /* 事前生成失敗でもレジストリは作成済み。WS接続時に既定生成される */ }
      }
      sendJson(res, 200, { terminal: term });
      return;
    }

    if (p === '/api/term/remove' && req.method === 'POST') {
      const body = await readBody(req);
      await removeTerminal(body.sid);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/term/send' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sendKey(body.sid, body.key);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // ファイルアップロード: 生バイトを受け取り、指定端末のカレントディレクトリ直下に保存する。
    // クエリ ?sid=<端末sid>&name=<元ファイル名>。保存後の絶対パスを返す。
    if (p === '/api/upload' && req.method === 'POST') {
      let buf;
      try {
        buf = await readRawBody(req);
      } catch {
        sendJson(res, 413, { error: 'ファイルが大きすぎます (上限25MB)' });
        return;
      }
      if (!buf.length) { sendJson(res, 400, { error: 'ファイルが空です' }); return; }

      // 保存先: ?dir= 指定があれば(EZbrowserの現在フォルダ) realpath検証してそこへ、
      // なければ端末のCWD配下の docs/ フォルダ。CWDが取れなければ HOME へ退避。
      let dir;
      const dirParam = url.searchParams.get('dir');
      try {
        if (dirParam) {
          dir = await safePath(dirParam); // /home/debian 配下のみ許可
        } else {
          const baseDir = (await getCwd(url.searchParams.get('sid'))) || process.env.HOME || '/home/debian';
          dir = path.join(baseDir, 'docs');
        }
      } catch (e) {
        sendJson(res, e.status || 500, { error: e.message });
        return;
      }

      // ファイル名の安全化: basename → 制御文字/スラッシュ/空白を除去し、衝突回避の時刻接頭辞を付与
      const raw = path.basename(String(url.searchParams.get('name') || 'file'));
      let clean = raw.replace(/[\x00-\x1f/\\]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
      if (!clean) clean = 'file';
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDhhmmss
      const safeName = `${stamp}_${clean}`;

      // パストラバーサル防止: 解決後のパスが dir 配下に収まることを検証
      const dest = path.resolve(dir, safeName);
      if (dest !== path.join(path.resolve(dir), safeName)) {
        sendJson(res, 400, { error: '不正なファイル名です' });
        return;
      }
      try {
        await fs.promises.mkdir(dir, { recursive: true }); // docs/ が無ければ作成
        await fs.promises.writeFile(dest, buf);
        sendJson(res, 200, { path: dest, name: safeName });
      } catch (e) {
        sendJson(res, 500, { error: `保存に失敗しました: ${e.message}` });
      }
      return;
    }

    // ===== EZbrowser: ファイルシステム API (すべて /home/debian 配下のみ, 認証必須) =====
    if (p === '/api/fs/list' && req.method === 'GET') {
      try {
        const dir = await safePath(url.searchParams.get('path') || REAL_ROOT);
        const st = await fs.promises.stat(dir);
        if (!st.isDirectory()) throw new HttpError(400, 'フォルダではありません');
        const showHidden = url.searchParams.get('hidden') === '1';
        let names = await fs.promises.readdir(dir);
        if (!showHidden) names = names.filter((n) => !n.startsWith('.'));
        const entries = [];
        for (const n of names) {
          try { entries.push(await statEntry(dir, n)); } catch { /* 壊れたsymlink等は無視 */ }
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        sendJson(res, 200, { path: dir, parent: dir === REAL_ROOT ? null : path.dirname(dir), root: REAL_ROOT, entries });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/read' && req.method === 'GET') {
      try {
        const file = await safePath(url.searchParams.get('path'));
        const st = await fs.promises.stat(file);
        if (!st.isFile()) throw new HttpError(400, 'ファイルではありません');
        if (st.size > 2 * 1024 * 1024) throw new HttpError(413, 'ファイルが大きすぎます (2MB上限)');
        const buf = await fs.promises.readFile(file);
        if (!isTextFile(buf)) { sendJson(res, 415, { error: 'binary' }); return; }
        sendJson(res, 200, { path: file, name: path.basename(file), content: buf.toString('utf8'), mode: st.mode & 0o777 });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/write' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      try {
        const file = await safePath(body.path);
        const st = await fs.promises.stat(file);
        if (!st.isFile()) throw new HttpError(400, 'ファイルではありません');
        const tmp = file + '.eztmp';
        await fs.promises.writeFile(tmp, String(body.content ?? ''), 'utf8');
        await fs.promises.rename(tmp, file);
        const s2 = await fs.promises.stat(file);
        sendJson(res, 200, { ok: true, mtime: s2.mtimeMs });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/create' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      try {
        const dir = await safePath(body.dir);
        const dest = await uniqueChild(dir, (body.name && String(body.name)) || 'new.txt');
        await fs.promises.writeFile(dest, String(body.content ?? ''), { flag: 'wx' });
        sendJson(res, 200, { ok: true, path: dest, name: path.basename(dest) });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const dir = await safePath(body.dir);
        const dest = await uniqueChild(dir, 'new');
        await fs.promises.mkdir(dest);
        sendJson(res, 200, { ok: true, path: dest, name: path.basename(dest) });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/rename' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const dir = await safePath(body.dir);
        const src = await childPath(dir, body.name);
        const dst = await childPath(dir, body.newName, { mustExist: false });
        await fs.promises.rename(src, dst);
        if (body.mode != null) {
          const m = Number(body.mode);
          if (!Number.isInteger(m) || m < 0 || m > 0o777) throw new HttpError(400, '権限指定が不正です');
          await fs.promises.chmod(dst, m);
        }
        sendJson(res, 200, { ok: true, name: path.basename(dst) });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/chmod' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const dir = await safePath(body.dir);
        const target = await childPath(dir, body.name);
        const m = Number(body.mode);
        if (!Number.isInteger(m) || m < 0 || m > 0o777) throw new HttpError(400, '権限指定が不正です');
        await fs.promises.chmod(target, m);
        sendJson(res, 200, { ok: true, mode: m });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/delete' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const dir = await safePath(body.dir);
        const names = Array.isArray(body.names) ? body.names : [];
        if (!names.length) throw new HttpError(400, '対象がありません');
        let n = 0;
        for (const name of names) {
          const target = await childPath(dir, name);
          if (target === REAL_ROOT) throw new HttpError(400, 'ルートは削除できません');
          await fs.promises.rm(target, { recursive: true, force: true });
          n += 1;
        }
        sendJson(res, 200, { ok: true, deleted: n });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/download' && req.method === 'GET') {
      try {
        const dir = await safePath(url.searchParams.get('dir'));
        const target = await childPath(dir, url.searchParams.get('name') || '');
        const st = await fs.promises.stat(target);
        if (!st.isFile()) throw new HttpError(400, 'フォルダはアーカイブでDLしてください');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
          'Content-Length': st.size,
        });
        fs.createReadStream(target).pipe(res);
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/fs/archive' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const dir = await safePath(body.dir);
        const names = (Array.isArray(body.names) ? body.names : []).map((n) => path.basename(String(n)));
        if (!names.length) throw new HttpError(400, '対象がありません');
        for (const name of names) await childPath(dir, name); // 各存在＋basename検証
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const fn = names.length === 1 ? `${names[0]}.tar.gz` : `ezbrowser_${stamp}.tar.gz`;
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`,
        });
        // シェル非経由(spawn+配列) + -C で親へ移動 + -- でオプション終端 + basenameのみ = 引数注入なし
        const child = spawn('/usr/bin/tar', ['-czf', '-', '-C', dir, '--', ...names], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.pipe(res);
        req.on('close', () => child.kill('SIGKILL'));
        child.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'アーカイブ作成に失敗' }); else res.end(); });
      } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      return;
    }

    if (p === '/api/conversations' && req.method === 'GET') {
      const list = getConversations()
        .map(({ id, title, updatedAt, messages }) => ({
          id, title, updatedAt, count: messages.length,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      sendJson(res, 200, { conversations: list });
      return;
    }

    if (p === '/api/conversation' && req.method === 'GET') {
      const conv = getConversations().find((c) => c.id === url.searchParams.get('id'));
      if (!conv) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, { conversation: conv });
      return;
    }

    if (p === '/api/conversation-delete' && req.method === 'POST') {
      const body = await readBody(req);
      saveConversations(getConversations().filter((c) => c.id !== body.id));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/stop' && req.method === 'POST') {
      const body = await readBody(req);
      running.get(body.convId)?.kill();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(res, 400, { error: 'プロンプトが空です' });
        return;
      }

      const convs = getConversations();
      let conv = body.convId ? convs.find((c) => c.id === body.convId) : null;
      if (!conv) {
        conv = {
          id: randomUUID(),
          title: prompt.slice(0, 40),
          claudeSessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        convs.push(conv);
      }
      if (running.has(conv.id)) {
        sendJson(res, 409, { error: 'この会話は実行中です' });
        return;
      }

      // SSE開始
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
      });
      const send = (ev, data) => {
        res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('meta', { convId: conv.id, title: conv.title });

      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

      let assistantText = '';
      const proc = runClaude({
        prompt,
        resumeSessionId: conv.claudeSessionId,
        allowTools: !!body.tools,
        onEvent: (ev) => {
          switch (ev.type) {
            case 'init':
              send('init', { model: ev.model });
              break;
            case 'delta':
              assistantText += ev.text;
              send('delta', { text: ev.text });
              break;
            case 'thinking':
              send('thinking', { text: ev.text });
              break;
            case 'tool':
              send('tool', { name: ev.name });
              break;
            case 'result': {
              if (ev.sessionId) conv.claudeSessionId = ev.sessionId;
              const finalText = assistantText || ev.text;
              conv.messages.push({ role: 'user', text: prompt, ts: Date.now() });
              conv.messages.push({ role: 'assistant', text: finalText, ts: Date.now() });
              conv.updatedAt = Date.now();
              saveConversations(convs);
              send('done', {
                convId: conv.id,
                isError: ev.isError,
                errorText: ev.isError && !assistantText ? ev.text : undefined,
                durationMs: ev.durationMs,
                costUsd: ev.costUsd,
              });
              break;
            }
            case 'error':
              send('error', { message: ev.message });
              break;
          }
        },
      });

      running.set(conv.id, proc);
      req.on('close', () => proc.kill());
      await proc.done;
      running.delete(conv.id);
      clearInterval(heartbeat);
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'server error' });
    } else {
      res.end();
    }
  }
});

/* ---------------- ページレンダリング ---------------- */

function renderPage({ authed, view, hasCreds }) {
  const bodyClass = `view-${view} ${authed ? 'authed' : 'anon'}`;
  const loginHtml = `
  <div class="login-wrap"><div class="login-box">
    <h1>🖊 EZOS</h1>
    <p class="sub">Claude を Web から使う</p>
    ${hasCreds ? `
      <button id="btn-login" class="btn primary big">🔑 パスキーでログイン</button>
      <p class="hint">1Passwordなどに保存したパスキーで認証します</p>
      <details class="setup-details">
        <summary>新しい端末のパスキーを追加登録する</summary>
        <input id="setup-key" type="password" placeholder="セットアップキー" autocomplete="off">
        <input id="reg-label" type="text" placeholder="端末名 (例: iPhone)" autocomplete="off">
        <button id="btn-register" class="btn">パスキーを登録</button>
      </details>
    ` : `
      <p class="sub">初期セットアップ: 最初のパスキーを登録してください</p>
      <input id="setup-key" type="password" placeholder="セットアップキー" autocomplete="off">
      <input id="reg-label" type="text" placeholder="端末名 (例: メインPC)" autocomplete="off">
      <button id="btn-register" class="btn primary big">🔐 パスキーを登録</button>
      <p class="hint">セットアップキーはサーバーの setup.js 実行時に表示されたものです</p>
    `}
    <p id="login-msg" class="err" hidden></p>
  </div></div>`;

  const termHtml = `
  <div id="term-app">
    <header id="term-bar">
      <button id="mode-cycle" class="mode-cycle" title="EZterminal / EZbrowser / EZeditor 切替" aria-label="モード切替"></button>
      <div id="term-tabs"><button id="btn-add-tab" title="新しいターミナル">＋</button></div>
      <span class="spacer"></span>
      <span id="conn-state" class="dot off" title="ターミナル接続状態"></span>
      <div class="tb-actions">
        <button id="btn-reconnect" class="btn small" title="ページを再読込" aria-label="再読込" hidden>🔄</button>
        <a class="btn small" href="?view=${view === 'mobile' ? 'desktop' : 'mobile'}">${view === 'mobile' ? '🖥' : '📱'}</a>
      </div>
    </header>

    <div id="term-main">
      <div id="terminals"></div>
      <div id="ez-browser" hidden></div>
      <div id="ez-editor" hidden></div>
    </div>
  </div>`;


  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#14161c">
<title>EZOS</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/app.css">
${authed ? '<link rel="stylesheet" href="/assets/ezeditor.css"><link rel="stylesheet" href="/vendor/xterm.css">' : ''}
</head>
<body class="${esc(bodyClass)}">
${authed ? termHtml : loginHtml}
<script>window.EZ = { authed: ${authed}, view: ${JSON.stringify(view)} };</script>
${authed
    ? '<script src="/vendor/xterm.js"></script><script src="/vendor/addon-fit.js"></script><script src="/vendor/addon-clipboard.js"></script><script src="/vendor/addon-web-links.js"></script><script src="/assets/term.js"></script><script src="/assets/ezhl.js"></script><script src="/assets/ezeditor.js"></script><script src="/assets/ezbrowser.js"></script>'
    : '<script src="/assets/app.js"></script>'}
</body>
</html>`;
}

// WebSocketターミナル
const handleUpgrade = createTermServer({ isAuthed, origin: cfg.origin });

// Caddy(Dockerコンテナ)から host.docker.internal 経由で届くよう docker0 側にもバインドする
const PORT = cfg.port || 3100;
const HOSTS = cfg.hosts || ['127.0.0.1', '172.17.0.1'];
// docker0(172.17.0.1)は Docker デーモン起動後に現れるため、起動順によっては
// bind 時点でアドレス未存在(EADDRNOTAVAIL)になりうる。その場合は現れるまでリトライする。
function bindHost(host, isPrimary) {
  const s = isPrimary ? server : http.createServer(server.listeners('request')[0]);
  s.on('upgrade', handleUpgrade);
  s.on('error', (e) => {
    if (e.code === 'EADDRNOTAVAIL') {
      console.error(`listen ${host}:${PORT} failed: ${e.message}; retrying in 3s`);
      setTimeout(() => s.listen(PORT, host), 3000);
    } else {
      console.error(`listen ${host}:${PORT} failed: ${e.message}`);
    }
  });
  s.listen(PORT, host, () => console.log(`EZOS listening on ${host}:${PORT}`));
}
HOSTS.forEach((host, i) => bindHost(host, i === 0));
