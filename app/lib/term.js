// WebSocket <-> pty ブリッジ。tmuxで永続セッション化する
// (切断しても継続し、PC/スマホから同じセッションに再接続できる)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { txa } from './tmux.js';
import { removeTerminal } from './terminals.js';

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
      // マウス操作を有効化(ホイールで履歴スクロール)。
      execFile('tmux', txa(['set-option', '-g', 'mouse', 'on']), () => {});
      // 履歴保持行数。tmuxはこの行数×セッション数分をサーバープロセスに常駐保持するため、
      // 総メモリ約1GBの小型機では抑えめにする(3000行あれば実用上の遡りは十分)。
      // クライアント側 xterm も scrollback を持つので、直近の見返しはブラウザ側でも効く。
      execFile('tmux', txa(['set-option', '-g', 'history-limit', '3000']), () => {});
      // Claude Code のセッション recap(away summary)を無効化。稼働中の tmux サーバーにも
      // グローバル環境として設定し、以後この端末で起動する claude では recap を出さない
      // (GUI 上部の情報と重複するため。tmux.js の process.env 設定と二重で担保)。
      execFile('tmux', txa(['set-environment', '-g', 'CLAUDE_CODE_ENABLE_AWAY_SUMMARY', '0']), () => {});
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
      // シェルを `exit` してtmuxセッションごと終了した場合は、タブ(レジストリ)自体も削除する。
      // ただし p.onExit は「別デバイス接続による -D デタッチ」でも発火し、その場合はセッションが
      // 生存しているので削除してはいけない。has-session でセッションの生死を確認して切り分ける
      // (消滅=本当に終了 → タブ削除。次の poll で syncTerminals がタブUIを消す)。
      if (HAS_TMUX) {
        execFile('tmux', txa(['has-session', '-t', `ez_${name}`]), (err) => {
          if (err) removeTerminal(name).catch(() => {});
        });
      } else {
        removeTerminal(name).catch(() => {}); // 素のbash: プロセス終了=タブ終了
      }
    });

    // 右端スクロールバー用: tmuxの現在のスクロール位置/履歴行数/画面高を返す。
    // scroll_position は copy-mode 中のみ値を持ち(=最下部から遡った行数)、通常時は空=0。
    // history_size は履歴(スクロールバック)の総行数、pane_height は表示行数。
    const sendScrollInfo = () => {
      if (!HAS_TMUX) return;
      execFile('tmux', txa(['display-message', '-p', '-t', `ez_${name}`,
        '#{scroll_position}\t#{history_size}\t#{pane_height}\t#{mouse_any_flag}']), (err, stdout) => {
        if (err || ws.readyState !== ws.OPEN) return;
        // 非copy-mode時 scroll_position は空。trim()すると先頭空フィールドが消えて
        // 各値がズレるため、末尾の改行だけ落として split する。
        // mouse は mouse_any_flag(=Claude等がマウス入力を自前処理=1)。1なら履歴スクロールでなく
        // アプリへホイールを転送すべきことをクライアントに伝える。
        const [p0, h0, ph, mf] = String(stdout).replace(/[\r\n]+$/, '').split('\t');
        ws.send(JSON.stringify({
          t: 'scr',
          pos: parseInt(p0, 10) || 0,
          hist: parseInt(h0, 10) || 0,
          h: parseInt(ph, 10) || 0,
          mouse: parseInt(mf, 10) || 0,
        }));
      });
    };

    ws.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let m;
      try {
        m = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      if (m.t === 'ping') {
        // クライアントのアプリ層ハートビート。pongを返して「生存」を知らせる
        // (低速回線でブラウザが接続の生死を判定できるようにするため)。
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
      } else if (m.t === 'i' && typeof m.d === 'string') {
        p.write(m.d);
      } else if (m.t === 'r' && m.c && m.r) {
        try {
          p.resize(Math.max(20, Math.min(500, m.c | 0)), Math.max(5, Math.min(200, m.r | 0)));
        } catch { /* resize race */ }
      } else if (m.t === 'scr') {
        sendScrollInfo(); // 右端スクロールバーの現在位置を返す
      } else if (m.t === 'scrline') {
        // 1行ずつスクロール(Shift+↑/↓用)。ホイールの1ノッチ=複数行と違い、tmuxの
        // copy-mode を精密に1行動かす。-e で最下部まで下げると自動的にcopy-modeを抜ける。
        if (HAS_TMUX) {
          const dir = m.dir === 'down' ? 'scroll-down' : 'scroll-up';
          const n = Math.max(1, Math.min(200, m.n | 0 || 1));
          execFile('tmux', txa(['copy-mode', '-e', '-t', `ez_${name}`]), () => {
            execFile('tmux', txa(['send-keys', '-t', `ez_${name}`, '-X', '-N', String(n), dir]),
              () => sendScrollInfo());
          });
        }
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

    // WebSocketプロトコル ping で接続を保温しつつ(NAT/プロキシのアイドル切断を防ぐ)、
    // pong応答で生死を判定する。低速・断続回線ではデタッチ済みのゾンビ接続が残って
    // pty/attach がリークしやすいので、一定回数 pong が返らなければ terminate して回収する
    // (tmuxセッション自体は永続=安全)。keep-alive頻度(25s)と生死判定(未応答2回≈50s)を
    // 分け、高遅延でも正常な接続を誤って切らないようにする。
    let missed = 0;
    ws.on('pong', () => { missed = 0; });
    const ping = setInterval(() => {
      if (ws.readyState !== ws.OPEN) { clearInterval(ping); return; }
      if (missed >= 2) { try { ws.terminate(); } catch { /* noop */ } clearInterval(ping); return; }
      missed += 1;
      try { ws.ping(); } catch { /* 次周期で terminate される */ }
    }, 25000);
    ws.on('close', () => clearInterval(ping));
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
