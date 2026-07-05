// WebSocket <-> pty ブリッジ。tmuxで永続セッション化する
// (切断しても継続し、PC/スマホから同じセッションに再接続できる)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { txa } from './tmux.js';

const HOME = process.env.HOME || '/home/debian';
const HAS_TMUX = fs.existsSync('/usr/bin/tmux');
// 特に指定のない新規ターミナルの起点。workspaceがあればそこ、無ければHOME
const WORKSPACE = fs.existsSync(path.join(HOME, 'workspace'))
  ? path.join(HOME, 'workspace')
  : HOME;

export function createTermServer({ isAuthed, origin }) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 80));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 24));
    // セッション名を分ければ複数ターミナルも持てる (既定は main)
    const name = (url.searchParams.get('s') || 'main').replace(/[^\w-]/g, '').slice(0, 20) || 'main';

    // -D: アタッチ時に他クライアントを切り離す。異なる画面サイズのクライアントが
    //     同時にぶら下がると tmux がウィンドウを1サイズに固定し、はみ出た領域に埋め草
    //     (「....」)が出るため。常に「今見ているデバイス」にウィンドウを一致させる。
    const [cmd, args] = HAS_TMUX
      ? ['tmux', txa(['new-session', '-A', '-D', '-s', `ez_${name}`])]
      : ['bash', ['-l']];

    if (HAS_TMUX) {
      // 複数クライアントが同一セッションに繋いだとき、最小ではなく最後に操作した
      // クライアントのサイズに追従させる (スマホ+PC同時接続時の表示崩れ回避)
      execFile('tmux', txa(['set-option', '-g', 'window-size', 'latest']), () => {});
      // マウス操作を有効化(ホイールで履歴スクロール)。履歴保持行数も拡大。
      execFile('tmux', txa(['set-option', '-g', 'mouse', 'on']), () => {});
      execFile('tmux', txa(['set-option', '-g', 'history-limit', '10000']), () => {});
    }

    let p;
    try {
      p = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols, rows,
        cwd: WORKSPACE,
        env: { ...process.env, HOME, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
      });
    } catch (e) {
      ws.send(JSON.stringify({ t: 'err', m: `pty起動失敗: ${e.message}` }));
      ws.close();
      return;
    }

    p.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(data, 'utf8'), { binary: true });
      }
    });
    p.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
        ws.close();
      }
    });

    ws.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let m;
      try {
        m = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      if (m.t === 'i' && typeof m.d === 'string') {
        p.write(m.d);
      } else if (m.t === 'r' && m.c && m.r) {
        try {
          p.resize(Math.max(20, Math.min(500, m.c | 0)), Math.max(5, Math.min(200, m.r | 0)));
        } catch { /* resize race */ }
      } else if (m.t === 'kill') {
        // タブを閉じたときの明示終了: tmuxセッションごと破棄する
        if (HAS_TMUX) {
          execFile('tmux', txa(['kill-session', '-t', `ez_${name}`]), () => {});
        }
        try { p.kill(); } catch { /* already dead */ }
      }
    });

    ws.on('close', () => {
      // 明示killでなければ tmux はデタッチ扱い(セッション生存)、素のbashなら終了
      try { p.kill(); } catch { /* already dead */ }
    });

    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
      else clearInterval(ping);
    }, 20000);
  });

  // http(s)サーバーの upgrade イベントに接続する
  return function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/term') {
      socket.destroy();
      return;
    }
    // 認証 + Origin チェック
    const reqOrigin = req.headers.origin || '';
    if (!isAuthed(req) || (reqOrigin && reqOrigin !== origin)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
}
