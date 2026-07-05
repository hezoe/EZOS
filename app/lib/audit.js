// 監査ログの tail -f 相当をSSEで配信する。
// フック(bin/ez-hook.sh)が data/audit/audit.log に追記したものを読み取り、
// 初回に末尾を送り、その後はファイルの伸びた分だけを1行ずつ流す。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const AUDIT_DIR = path.join(DATA_DIR, 'audit');
export const AUDIT_LOG = path.join(AUDIT_DIR, 'audit.log');

const SEED_BYTES = 96 * 1024; // 初回に読む末尾サイズ
const POLL_MS = 600;          // 追記のポーリング間隔

// offset から末尾までを読み、完全な行だけ返す。未完の行は pending として返す。
function readFrom(offset) {
  const st = fs.statSync(AUDIT_LOG);
  if (st.size <= offset) return { offset, text: '' };
  const fd = fs.openSync(AUDIT_LOG, 'r');
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { offset: st.size, text: buf.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

export function streamAudit(res) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_LOG)) fs.writeFileSync(AUDIT_LOG, '', { mode: 0o600 });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  let offset = 0;
  let pending = ''; // 直近の未完行(末尾に改行が無い分)を次回に持ち越す

  // 初回シード: 末尾 SEED_BYTES を読む
  try {
    const st = fs.statSync(AUDIT_LOG);
    const start = Math.max(0, st.size - SEED_BYTES);
    const r = readFrom(start);
    offset = r.offset;
    let text = r.text;
    if (start > 0) {
      // 途中から読んだので欠けている先頭行を捨てる
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const lines = text.split('\n');
    pending = lines.pop();
    send('seed', { lines: lines.filter((l) => l.length) });
  } catch {
    offset = 0;
    send('seed', { lines: [] });
  }

  const tick = () => {
    let st;
    try { st = fs.statSync(AUDIT_LOG); } catch { return; }
    if (st.size < offset) {
      // ローテーション/切り詰めを検知したら最初から読み直す
      offset = 0;
      pending = '';
      send('reset', {});
    }
    if (st.size === offset) return;
    try {
      const r = readFrom(offset);
      offset = r.offset;
      const text = pending + r.text;
      const lines = text.split('\n');
      pending = lines.pop();
      const out = lines.filter((l) => l.length);
      if (out.length) send('line', { lines: out });
    } catch { /* 一時的な読み取り失敗は次のtickで回収 */ }
  };

  const poll = setInterval(tick, POLL_MS);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = () => { clearInterval(poll); clearInterval(ping); };
  res.on('close', cleanup);
  res.on('error', cleanup);
}
