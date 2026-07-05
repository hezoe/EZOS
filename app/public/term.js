/* EZOS Webターミナル (xterm.js) — 複数タブ + サーバー共有
   タブ構成(ターミナルの数・タイトル・順序)はサーバー(/api/term/*)が正本で、
   全ブラウザ・全デバイスで同一。各タブは tmux セッション ez_<sid> に attach するため、
   複数ブラウザから同じ画面が見える。状態(確認待ち/処理中/完了)も共有。
   localStorageに持つのは「このブラウザでどのタブを見ているか」だけ。 */
'use strict';

(() => {
  console.info('[EZOS] term.js build: tabs(dynamic+, state-dot, pulldown, touch-scroll-fix, vv-pin, keyrow-reorder+wrap, switch-next-to-esc, ctrl-end, actions-stack-when-wrapped, ctrl-keys-no-focus, mobile-no-brand, wrap-hysteresis, git-buttons-submit, send-after-down, shift-tab, sanitize, file-upload, web-links, goto-terminal, file-links-to-editor, local-selection, mic-next-to-switch, prompt-btns-no-kbd, keyrow-no-kbd, mic-to-terminal-when-off, resilient-net, mic-stream-to-terminal, confirm-alarm-pon)(2026-07-05j)'); // 版確認用
  const isMobile = window.EZ.view === 'mobile';
  const ACTIVE_KEY = 'ez_active_sid'; // 閲覧中タブ(このブラウザ限定の表示都合)

  /* ---- 低速・高遅延・断続的な回線(機内Wi-Fi等)でも切れずに使い続けるための調整値 ----
     方針: (1)自動再接続(指数バックオフ+ジッタ, 無限リトライ) (2)アプリ層ハートビートで
     「無通信のまま生きているつもりのゾンビ接続」を検出して張り直す (3)未接続中の入力は
     キューに退避し復帰時にまとめて送出(打った内容を失わない) (4)遅延に強い長めの判定。
     tmux でセッションは永続するので、再接続すれば画面も入力も継続できる。 */
  const HB_MS = 15000;              // ハートビート送信間隔
  const DEAD_MS = 50000;            // この時間 無通信ならゾンビ接続とみなし強制再接続(高遅延に余裕)
  const RECONNECT_BASE_MS = 700;    // 再接続バックオフの基準
  const RECONNECT_MAX_MS = 15000;   // 再接続バックオフの上限
  const API_TIMEOUT_MS = 20000;     // ポーリング等 HTTP が回線ハングで詰まらないよう打ち切る上限
  const SEND_QUEUE_MAX = 5000;      // 未接続中に貯める入力の上限(暴走防止)

  const tabsEl = document.getElementById('term-tabs');
  const btnAddTab = document.getElementById('btn-add-tab');
  const termsEl = document.getElementById('terminals');
  const dot = document.getElementById('conn-state');
  const reconnectBtn = document.getElementById('btn-reconnect');

  /* ---- 確認待ちアラーム音「ポン」。タブが選択確認(confirm)状態になった瞬間に鳴らす ----
     音声ファイルは使わず Web Audio でその場生成(CSP安全)。ブラウザは最初のユーザー操作まで
     音を出せないため、初回操作で AudioContext を有効化しておく。 */
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { /* noop */ });
    return audioCtx;
  }
  // 最初のユーザー操作で音声を解禁(自動再生ブロック対策)
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, ensureAudio, { once: true, passive: true, capture: true }));
  function playPon() {
    const ac = ensureAudio();
    if (!ac || ac.state !== 'running') return; // 未解禁なら鳴らさない
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now); // 少し下降させて「ぽーーん」らしく
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.14);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.30, now + 0.012); // 立ち上がり
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0); // 長めに減衰(余韻)
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 1.05);
  }

  // 各ターミナルに一体化した入力欄・制御キー行の共通定義
  const KEYROW = [
    ['⏎', '\r'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
    ['^C', '\x03'], ['^D', '\x04'], ['^End', '\x1b[1;5F'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Esc', '\x1b'],
  ];
  const HIST_KEY = 'ez_input_history';
  const INPUT_H_KEY = 'ez_input_h';
  let history = [];
  try { const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); if (Array.isArray(h)) history = h; } catch { /* noop */ }
  const applyInputHeight = (px) => document.documentElement.style.setProperty('--tw-input-h', px + 'px');
  { const h = Number(localStorage.getItem(INPUT_H_KEY)); applyInputHeight(h >= 40 ? h : 92); }

  function tabSendRaw(tab, data) {
    // 直接送らずキュー経由にする。未接続なら退避して再接続し、復帰時に自動で送出する
    // (機内Wi-Fi等で一瞬切れても入力を取りこぼさない)。
    enqueueInput(tab, data);
  }

  // 入力欄 ON/OFF (ON=入力欄で編集・ターミナル直接入力ロック / OFF=直接入力・入力欄はスイッチ列のみ)
  let inputOnDefault = (localStorage.getItem('ez_input_on') || 'on') !== 'off';
  function applyInputMode(tab) {
    // ON(入力欄モード)=ターミナルをロック / OFF=直接入力を許可
    try { tab.term.options.disableStdin = tab.inputOn; } catch { /* noop */ }
    tab.wrap.classList.toggle('input-off', !tab.inputOn); // OFF: 入力欄・ハンドルを隠す
    if (tab.switchEl) tab.switchEl.checked = tab.inputOn;
  }
  function setInputMode(tab, on) {
    tab.inputOn = on;
    inputOnDefault = on;
    applyInputMode(tab);
    try { localStorage.setItem('ez_input_on', on ? 'on' : 'off'); } catch { /* noop */ }
    if (tab === active) { fitActive(); (on ? tab.inputEl : tab.term).focus(); }
  }
  function submitTab(tab) {
    const text = tab.inputEl.value;
    // bracketed pasteで内容を挿入(複数行・IME確定済みを安全に)し、Enter(\r)で送出。
    // キュー経由なので未接続でも取りこぼさず、再接続後にまとめて送られる。
    if (text.length) tabSendRaw(tab, '\x1b[200~' + text + '\x1b[201~');
    tabSendRaw(tab, '\r');
    if (text.trim() && history[history.length - 1] !== text) {
      history.push(text); if (history.length > 300) history.shift();
      try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch { /* noop */ }
    }
    tab.histIndex = history.length; tab.histDraft = '';
    tab.inputEl.value = '';
    // スマホ: 送信はプロンプトへ直接入力する操作なので、入力欄へフォーカスを戻して
    // ソフトキーボード(入力モード)を呼び出さない。PCは従来どおり続けて入力できるよう戻す。
    if (!isMobile) tab.inputEl.focus();
  }
  // 入力欄末尾にテキストを挿入(前後に空白を補い、既存文字列と繋がらないように)
  function appendToInput(tab, text) {
    const cur = tab.inputEl.value;
    tab.inputEl.value = (cur && !/\s$/.test(cur) ? cur + ' ' : cur) + text + ' ';
    tab.inputEl.focus();
  }
  // ファイル群を端末のCWDへアップロードし、保存された絶対パスを入力欄に挿入する
  async function uploadFiles(tab, btn, fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const orig = btn.textContent; btn.textContent = '⏳'; btn.disabled = true;
    let n = 0;
    try {
      for (const file of files) {
        // ペースト画像等で名前が無い場合は拡張子を補って命名
        const ext = (file.type.split('/')[1] || 'bin').replace(/[^\w]/g, '');
        const name = file.name || `paste_${Date.now()}_${n}.${ext}`;
        const res = await fetch(`/api/upload?sid=${encodeURIComponent(tab.sid)}&name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'ezos', 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.path) { appendToInput(tab, j.path); n += 1; }
        else { alert(`アップロード失敗: ${j.error || res.status}`); }
      }
    } catch (e) {
      alert(`アップロード失敗: ${e.message}`);
    } finally {
      btn.textContent = orig; btn.disabled = false;
    }
  }
  function histUp(tab) {
    if (!history.length) return;
    if (tab.histIndex === history.length) tab.histDraft = tab.inputEl.value; // 編集中を退避
    if (tab.histIndex > 0) tab.histIndex -= 1;
    tab.inputEl.value = history[tab.histIndex] ?? '';
    if (!isMobile) tab.inputEl.focus(); // スマホ: 入力モードへ勝手に切り替えない
  }
  function histDown(tab) {
    if (tab.histIndex >= history.length) return;
    tab.histIndex += 1;
    tab.inputEl.value = tab.histIndex === history.length ? tab.histDraft : (history[tab.histIndex] ?? '');
    if (!isMobile) tab.inputEl.focus(); // スマホ: 入力モードへ勝手に切り替えない
  }
  function setupResize(handle) {
    let dragging = false, startY = 0, startH = 0;
    const cur = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tw-input-h'), 10) || 92;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; startH = cur();
      try { handle.setPointerCapture(e.pointerId); } catch { /* noop */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      applyInputHeight(Math.max(40, Math.min(Math.round(window.innerHeight * 0.7), startH + (startY - e.clientY))));
      fitActive();
    });
    const end = (e) => {
      if (!dragging) return; dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      try { localStorage.setItem(INPUT_H_KEY, String(cur())); } catch { /* noop */ }
      fitActive();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  const TERM_THEME = {
    background: '#14161c',
    foreground: '#e6e9f0',
    cursor: '#4c8dff',
    selectionBackground: '#2b3a55',
  };

  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** @type {Array<{sid,title,term,fit,wrap,tabBtn,nameEl,dotEl,ws,connected,closedByUser}>} */
  const tabs = [];
  let active = null;
  let lastView = [];

  /* ---- サーバーAPI ---- */
  async function api(path, data) {
    const opt = data !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezos' }, body: JSON.stringify(data) }
      : { headers: { 'X-Requested-With': 'ezos' } };
    // 回線ハングで fetch が永久に返らないと polling が止まるため、上限時間で打ち切る
    // (AbortSignal.timeout 非対応の古い環境では従来どおりタイムアウト無し)。
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(API_TIMEOUT_MS);
    const res = await fetch(path, opt);
    if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
    return res.json().catch(() => ({}));
  }

  /* ---- 接続状態表示 (アクティブタブ基準) ---- */
  function updateConn() {
    // ヘッダーの接続ドット(アクティブタブ基準)。タブの●はClaude状態で色分け(renderConfirm)。
    const on = !!(active && active.connected);
    dot.classList.toggle('on', on);
    dot.classList.toggle('off', !on);
    reconnectBtn.hidden = on;
  }

  /* ---- 送信キュー: 未接続中の入力を退避し、接続復帰時にまとめて送る ----
     機内Wi-Fi等で一瞬切れても「打った内容が消える」ことを防ぐ。tmuxは永続するので
     復帰後に流し込めば続きから操作できる。resize/pingは最新値のみ意味があるので退避しない。 */
  function enqueueInput(tab, data) {
    tab.sendQueue.push({ t: 'i', d: data });
    if (tab.sendQueue.length > SEND_QUEUE_MAX) tab.sendQueue.shift(); // 暴走防止(最古を捨てる)
    flushQueue(tab);
  }
  function flushQueue(tab) {
    const ws = tab.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      while (tab.sendQueue.length) {
        try { ws.send(JSON.stringify(tab.sendQueue[0])); } catch { break; }
        tab.sendQueue.shift();
      }
    } else if (!tab.closedByUser) {
      connect(tab); // 未接続なら張り直す。onopen で再度 flushQueue される
    }
  }

  /* ---- ハートビート: アプリ層 ping/pong で「無通信のゾンビ接続」を検出して張り直す ----
     ブラウザからは WebSocket プロトコル ping を送れないため、{t:'ping'} を送って
     サーバに {t:'pong'} を返させ、一定時間まったく受信が無ければ死んだ接続とみなす。
     受信(端末データ含む)があるたび lastRecv を更新するので、通信中は誤検出しない。 */
  function stopHeartbeat(tab) {
    if (tab.hbTimer) { clearInterval(tab.hbTimer); tab.hbTimer = null; }
  }
  function startHeartbeat(tab) {
    stopHeartbeat(tab);
    tab.lastRecv = Date.now();
    tab.hbTimer = setInterval(() => {
      const ws = tab.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - tab.lastRecv > DEAD_MS) {
        try { ws.close(); } catch { /* noop */ } // onclose が自動再接続を仕掛ける
        return;
      }
      try { ws.send(JSON.stringify({ t: 'ping' })); } catch { /* 次回判定に委ねる */ }
    }, HB_MS);
  }

  /* ---- 自動再接続: 通信断のときだけ指数バックオフ(+ジッタ)で無限リトライ ----
     セッション終了/別デバイスへの切替(gotExit)や、ユーザーが閉じた場合は再接続しない。 */
  function scheduleReconnect(tab) {
    if (tab.closedByUser || tab.gotExit || tab.reconnectTimer) return;
    const n = tab.reconnectAttempts;
    const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n);
    const delay = cap / 2 + Math.random() * (cap / 2); // 同時再接続の集中を避けるジッタ
    tab.reconnectAttempts = n + 1;
    tab.reconnectTimer = setTimeout(() => { tab.reconnectTimer = null; connect(tab); }, delay);
  }
  // 回線復帰(online)/前面復帰(visible)時に、切断中タブを即再接続(バックオフ待ちを飛ばす)
  function kickReconnect(tab) {
    if (tab.closedByUser || tab.gotExit) return;
    const ws = tab.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    tab.reconnectAttempts = 0;
    connect(tab);
  }

  /* ---- WebSocket接続 (tmuxセッションへattach) ---- */
  function connect(tab) {
    // すでに接続確立/確立中なら二重接続しない(flushQueueやタップ連打での多重張りを防ぐ)
    if (tab.ws && (tab.ws.readyState === WebSocket.CONNECTING || tab.ws.readyState === WebSocket.OPEN)) return;
    if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    // 古いソケットが残っていれば確実に閉じてから張り直す
    if (tab.ws) {
      try {
        tab.ws.onopen = tab.ws.onmessage = tab.ws.onclose = tab.ws.onerror = null;
        tab.ws.close();
      } catch { /* noop */ }
      tab.ws = null;
    }
    stopHeartbeat(tab);
    if (tab === active) fitActive();
    const cols = tab.term.cols || 80;
    const rows = tab.term.rows || 24;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    tab.closedByUser = false;
    tab.gotExit = false; // 新規attempt。以降にexitを受けたら立て直す
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/term?s=${encodeURIComponent(tab.sid)}&cols=${cols}&rows=${rows}`);
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;

    ws.onopen = () => {
      tab.connected = true;
      tab.reconnectAttempts = 0;
      tab.reconnectNotified = false;
      startHeartbeat(tab);
      flushQueue(tab); // 未接続中に溜めた入力を送出(打った内容を失わない)
      sendResize(tab); // 復帰直後にサイズを再通知(端末が縮小フレームのままにならないよう)
      updateConn();
      if (tab === active) { fitActive(); (tab.inputOn ? tab.inputEl : tab.term)?.focus(); }
    };
    ws.onmessage = (ev) => {
      tab.lastRecv = Date.now(); // 受信があった=生存。ハートビート判定の基準
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.t === 'pong') return; // ハートビート応答(lastRecv更新のみ)
          if (m.t === 'exit') {
            tab.gotExit = true; // セッション終了/別デバイスへ切替 → 自動再接続しない
            tab.term.write(`\r\n\x1b[90m[セッション終了 (code ${m.code})]\x1b[0m\r\n`);
          }
          if (m.t === 'err') tab.term.write(`\r\n\x1b[31m${m.m}\x1b[0m\r\n`);
        } catch { /* noop */ }
      } else {
        tab.term.write(new Uint8Array(ev.data));
      }
    };
    ws.onclose = () => {
      tab.connected = false;
      stopHeartbeat(tab);
      updateConn();
      if (tab.closedByUser) return;
      if (tab.gotExit) {
        // 別デバイスが接続すると(-D)ここがデタッチされ、tmuxが縮小サイズで再描画した
        // 埋め草フレームが残る。resetで消してから復帰案内を出す(古い画面の残骸を見せない)。
        tab.term.reset();
        tab.term.write('\x1b[90m[別のデバイスで開かれたためデタッチしました。'
          + '再接続ボタン／Enter／このタブをタップで復帰します]\x1b[0m\r\n');
        return;
      }
      // 通信断(機内Wi-Fi等): 自動再接続。案内は一度だけ出す(再試行のたびに汚さない)。
      if (!tab.reconnectNotified) {
        tab.term.write('\r\n\x1b[90m[接続が切れました — 自動的に再接続します…]\x1b[0m\r\n');
        tab.reconnectNotified = true;
      }
      scheduleReconnect(tab);
    };
    ws.onerror = () => { /* onclose が続く */ };
  }

  // 回線が戻ったら即再接続(バックオフ待ちを飛ばして素早く復帰)
  window.addEventListener('online', () => tabs.forEach(kickReconnect));
  window.addEventListener('visibilitychange', () => { if (!document.hidden) tabs.forEach(kickReconnect); });

  function sendResize(tab) {
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
      tab.ws.send(JSON.stringify({ t: 'r', c: tab.term.cols, r: tab.term.rows }));
    }
  }

  function fitActive() {
    if (!active) return;
    try { active.fit.fit(); } catch { /* サイズ未確定 */ }
    sendResize(active);
  }
  window.EZ.fitActive = fitActive; // EZbrowser がモード復帰時に端末を再フィットするため公開
  // EZbrowser から新規端末(sid)へ移動: 同期でタブを生成してアクティブ化する
  window.EZ.gotoTerminal = async (sid) => {
    if (!sid) return;
    localStorage.setItem(ACTIVE_KEY, sid);
    for (let i = 0; i < 6; i += 1) {
      await poll(); // サーバのタブ一覧を取り込み、新規タブを生成
      const tab = tabs.find((t) => t.sid === sid);
      if (tab) { setActive(tab, { focus: false }); return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  // クリップボードへコピー (Clipboard API優先、失敗時は execCommand フォールバック)
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { /* noop */ }
  }

  /* ---- 音声入力(Web Speech API)。マイクボタンで開始/停止し、認識結果を入力欄へ ---- */
  function setupMic(tab, btn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.disabled = true; btn.title = 'このブラウザは音声入力に非対応です'; btn.classList.add('unsupported'); return; }
    let rec = null, recording = false, baseValue = '', finalAcc = '', lastInterim = '', sentLen = 0;
    // OFF時: 確定した音声を差分だけターミナルのカーソルへ挿入する(Gitボタンと同じ
    // bracketed paste。Enterは送らないのでカーソル位置に文字が入るだけ)。
    const streamToTerminal = (text) => { if (text) tabSendRaw(tab, '\x1b[200~' + text + '\x1b[201~'); };
    const startRec = () => {
      rec = new SR();
      rec.lang = 'ja-JP';
      rec.interimResults = true;
      rec.continuous = true;
      baseValue = tab.inputEl.value;
      finalAcc = ''; lastInterim = ''; sentLen = 0;
      rec.onstart = () => { recording = true; btn.classList.add('rec'); btn.textContent = '⏹'; btn.title = '音声入力を停止'; };
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r.isFinal) finalAcc += r[0].transcript; else interim += r[0].transcript;
        }
        lastInterim = interim;
        if (tab.inputOn) {
          // ON: 入力欄へ反映(確定+未確定)。停止時に送信ボタン等で送出できる。
          const added = finalAcc + interim;
          const sep = baseValue && added && !/\s$/.test(baseValue) ? ' ' : '';
          tab.inputEl.value = baseValue + sep + added;
        } else {
          // OFF: 確定した分だけをその都度ターミナルへ流し込む(onendの発火に依存しない)。
          // 未確定(interim)はまだ送らない(後で変化して二重入力になるため)。
          if (finalAcc.length > sentLen) {
            const delta = finalAcc.slice(sentLen);
            sentLen = finalAcc.length;
            streamToTerminal(delta);
          }
        }
      };
      rec.onerror = (e) => {
        const msg = {
          'not-allowed': 'マイクの使用が許可されていません (not-allowed)。',
          'service-not-allowed': '音声認識サービスが使用できません (service-not-allowed)。HTTPSで開いているか、Windowsの「デスクトップアプリのマイクアクセス」がオンか確認してください。',
          'network': 'ネットワークエラー (network)。音声認識はオンライン接続が必要です。',
          'audio-capture': 'マイクが見つかりません (audio-capture)。既定の入力デバイスを確認してください。',
        }[e.error];
        if (e.error !== 'no-speech' && e.error !== 'aborted') alert(msg || ('音声入力エラー: ' + e.error));
      };
      rec.onend = () => {
        recording = false; btn.classList.remove('rec'); btn.textContent = '🎤'; btn.title = '音声入力';
        if (!tab.inputOn) {
          // OFF: 確定分は onresult で逐次ターミナルへ送出済み。停止時に確定化されずに
          // 残った末尾(interim)だけを一度フラッシュして取りこぼしを防ぐ(保険)。
          const tail = (finalAcc + lastInterim).slice(sentLen);
          if (tail) { sentLen += tail.length; streamToTerminal(tail); }
          return;
        }
        baseValue = tab.inputEl.value; // 認識確定分を次回の基準に取り込む
        if (!isMobile) tab.inputEl.focus(); // スマホ: 入力モード(ソフトキーボード)を呼ばない
      };
      try { rec.start(); } catch { /* すでに開始済み */ }
    };
    btn.addEventListener('click', async () => {
      if (recording) { rec.stop(); return; }
      // 先に標準のマイク許可(getUserMedia)を要求し、権限プロンプト表示とエラー切り分けを行う
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop()); // 許可確認のみなので即停止
        } catch (err) {
          alert('マイクにアクセスできません (' + err.name + ')。\n'
            + 'Windowsの [設定→プライバシーとセキュリティ→マイク] で\n'
            + '「マイクへのアクセス」と「デスクトップアプリがマイクにアクセスできるようにする」がオンか確認してください。');
          return;
        }
      }
      startRec();
    });
  }

  /* ---- ターミナル上のファイルパス検出 → クリックでEZeditorに開く ----
     URLは WebLinksAddon が担当。ここはファイルパス専用のリンクプロバイダ(自前実装)。
     行のセル情報から桁を計算するので、全角(CJK)混在行でも下線位置がずれない。
     対象は provideLinks が渡す1バッファ行(折返しの跨ぎは非対応=許容範囲)。 */
  const HOME = '/home/debian';
  // スラッシュを含むパス、または既知の拡張子を持つ素のファイル名にマッチ
  const FILE_LINK_RE = /[\w.@~+-]*(?:\/[\w.@+~-]+)+\/?|[\w@+-][\w.@+-]*\.(?:js|mjs|cjs|jsx|ts|tsx|json|css|scss|less|html?|xml|svg|vue|md|markdown|te?xt|sh|bash|zsh|py|rb|go|rs|c|h|hpp|cc|cpp|java|kt|swift|ya?ml|toml|ini|cfg|conf|env|php|sql|log|lock)\b/g;
  const PATH_BOUNDARY = /[:\w@~+.\-/]/; // 直前がこの文字ならパス片ではない(URL断片や語中)

  // 1バッファ行を、文字列と「各文字が始まる0基点の桁」の対応表に変換(全角=2桁を考慮)
  function rowStringAndCols(line) {
    const cols = line.length;
    const cell = line.getCell(0);
    let str = ''; const colAt = [];
    for (let c = 0; c < cols; c++) {
      if (!line.getCell(c, cell)) continue;
      if (cell.getWidth() === 0) continue;   // 全角の2セル目(幅0)はスキップ
      const chars = cell.getChars() || ' ';  // 空セルは空白1つ扱い
      for (let k = 0; k < chars.length; k++) colAt.push(c);
      str += chars;
    }
    colAt.push(cols); // 番兵: 文字列末尾の次の位置 = 行末桁
    return { str, colAt };
  }
  function provideFileLinks(term, tab, bufferLineNumber, callback) {
    const line = term.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) { callback(undefined); return; }
    const { str, colAt } = rowStringAndCols(line);
    const re = new RegExp(FILE_LINK_RE.source, 'g');
    const links = []; let m;
    while ((m = re.exec(str))) {
      if (m.index > 0 && PATH_BOUNDARY.test(str[m.index - 1])) continue; // 前境界チェック
      const text = m[0].replace(/[.,:;)\]}'"]+$/, ''); // 末尾の句読点を除去
      if (!text || text.endsWith('/') || !/[/.]/.test(text)) continue; // 空・dir・目印なしは除外
      const i = m.index, end = i + text.length;
      const startX = colAt[i] + 1;                                   // 1基点の開始桁
      const endX = colAt[end] !== undefined ? colAt[end] : line.length; // 末尾の次の桁
      links.push({
        range: { start: { x: startX, y: bufferLineNumber }, end: { x: endX, y: bufferLineNumber } },
        text, activate: () => openFileFromTerminal(tab, text), hover() {}, leave() {},
      });
    }
    callback(links.length ? links : undefined);
  }
  // 検出したパスを絶対パスに解決して EZeditor に開く(相対は端末のcwd基準)
  async function openFileFromTerminal(tab, raw) {
    let s = String(raw).trim().replace(/:\d+(?::\d+)?$/, ''); // 末尾の :行:桁 は落とす
    if (!s) return;
    let abs;
    if (s[0] === '/') abs = s;
    else if (s === '~') abs = HOME;
    else if (s.startsWith('~/')) abs = HOME + s.slice(1);
    else {
      let cwd = null;
      try { const j = await api('/api/term/cwd?sid=' + encodeURIComponent(tab.sid)); cwd = j && j.cwd; } catch { /* noop */ }
      if (!cwd) { alert('相対パスの基準ディレクトリを取得できませんでした: ' + s); return; }
      abs = cwd.replace(/\/+$/, '') + '/' + s;
    }
    if (window.EZ && typeof window.EZ.openFileInEditor === 'function') window.EZ.openFileInEditor(abs);
    else alert('EZeditor が利用できません');
  }

  /* ---- タブ(ローカル実体)の生成/破棄。各タブ = 表示 + 制御キー行 + 独立入力欄 ---- */
  function createTab(meta) {
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    wrap.hidden = true;

    // xterm 表示領域
    const view = document.createElement('div');
    view.className = 'tw-view';
    wrap.appendChild(view);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: isMobile ? 13 : 15,
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace',
      // 各タブ分のスクロールバックをブラウザが保持するため、スマホ等の非力な端末の
      // メモリを圧迫しない範囲に抑える(2000行あれば直近の見返しには十分)。
      scrollback: 2000,
      theme: TERM_THEME,
      disableStdin: true, // 直接文字入力はロック。入力は各ターミナル一体の入力欄/キー行から(IME安定化)
      // tmux mouse on でもドラッグ選択・リンククリックを xterm 側でローカル処理させる。
      // これで「入力切替 ON/OFF に関係なく」選択コピーとファイルクリックが動く
      // (アプリ側へマウス報告したい時だけ Alt を押しながら操作する)。
      mouseEventsRequireAlt: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    // OSC 52 対応: Claude等が端末経由で行うコピー/ペーストをシステムクリップボードへ反映
    try { term.loadAddon(new ClipboardAddon.ClipboardAddon()); } catch { /* 未ロード時は無視 */ }
    // URLを検出してクリック可能に(ターミナル/Claudeモード共通)。クリックで新規タブに開く
    try {
      term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }));
    } catch { /* 未ロード時は無視 */ }
    term.open(view);

    const tabBtn = document.createElement('div');
    tabBtn.className = 'term-tab';
    const dotEl = document.createElement('span');
    dotEl.className = 'dot st-unknown';
    const nameEl = document.createElement('span');
    nameEl.className = 't-name';
    nameEl.textContent = meta.title;
    const closeEl = document.createElement('button');
    closeEl.className = 't-close';
    closeEl.title = 'このターミナルを閉じる';
    closeEl.textContent = '×';
    tabBtn.append(dotEl, nameEl, closeEl);
    tabsEl.insertBefore(tabBtn, btnAddTab); // ＋ボタンは常に最後尾に保つ

    const tab = {
      sid: meta.sid, title: meta.title, term, fit, wrap, view, tabBtn, nameEl, dotEl,
      inputEl: null, histIndex: history.length, histDraft: '',
      ws: null, connected: false, closedByUser: false,
      // 回線耐性用の状態(自動再接続・ハートビート・送信キュー)
      gotExit: false,          // {t:'exit'} 受信(セッション終了/別デバイスに切替) → 自動再接続しない
      sendQueue: [],           // 未接続中の入力を退避。復帰時に flushQueue でまとめて送出
      reconnectTimer: null, reconnectAttempts: 0, reconnectNotified: false,
      hbTimer: null, lastRecv: 0,
    };

    // ファイルパスをクリックでEZeditorに開く(URLは上のWebLinksが担当)。
    // mouseEventsRequireAlt=true により入力ON/OFFのどちらでもクリックが届く。
    try { term.registerLinkProvider({ provideLinks: (n, cb) => provideFileLinks(term, tab, n, cb) }); } catch { /* 未対応環境では無視 */ }

    // このターミナル専用の制御キー行(右端に入力欄ON/OFFスイッチを同居させ省スペース化)
    const keyrow = document.createElement('div');
    keyrow.className = 'tw-keyrow';
    // これらのキーは常にプロンプトへ直接送信する(tabSendRaw)。スマホでは送信後に
    // フォーカスを移さず、入力モード(ソフトキーボード)へ勝手に切り替わらないようにする。
    // PCでは従来どおり入力先へフォーカスを戻す(制御信号系 ^C/^D/^End は除く=カーソルが飛ぶため)。
    const NO_FOCUS = new Set(['^C', '^D', '^End']);
    for (const [label, seq] of KEYROW) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        tabSendRaw(tab, seq);
        if (!isMobile && !NO_FOCUS.has(label)) (tab.inputOn ? tab.inputEl : tab.term).focus();
      });
      keyrow.appendChild(b);
    }

    // Git操作ボタン(ESCの右)。シェルでもClaudeプロンプトでも同じコマンド行を流し込み、
    // 相手(シェル=直接実行 / Claude=そのコマンドを実行)に処理させることでどちらでも動く。
    // 送信先はアクティブ端末なので、そのターミナルのカレントディレクトリで実行される。
    const GIT_PULL = 'git pull';
    const GIT_PUSH = 'git add -A && git commit -m "update $(date +%F_%T)" && git push';
    const mkGit = (label, title, cmd) => {
      const b = document.createElement('button');
      b.className = 'gitkey'; b.textContent = label; b.title = title;
      b.addEventListener('click', () => {
        // 入力欄「送信」と同じ方式: ブラケットペーストでコマンドを確定入力し、
        // 独立したEnter(\r)で送信する。これでシェルでもClaudeプロンプトでも実行される
        // (素の \r だとClaudeでは改行扱いになり送信されないことがあるため)。
        // キュー経由なので未接続でも取りこぼさず、再接続後にまとめて送られる。
        tabSendRaw(tab, '\x1b[200~' + cmd + '\x1b[201~');
        tabSendRaw(tab, '\r');
      });
      return b;
    };
    keyrow.append(
      mkGit('G↓', 'GitHubからpull (git pull)', GIT_PULL),
      mkGit('G↑', 'コミットしてGitHubへpush (add・commit・push)', GIT_PUSH),
    );

    // 入力欄下の丸ボタン生成ヘルパ(マイクもこれで作り、スマホではキー行へ置く)
    const mkIb = (label, title, cls) => {
      const b = document.createElement('button');
      b.className = 'ib-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.title = title;
      return b;
    };
    // マイク(音声入力): 認識結果は入力欄に限らず直接プロンプトへ入力することもある。
    // スマホでは入力切替スイッチのすぐ右に置き、入力欄OFF(直接入力)でも使えるようにする。
    const mic = mkIb('🎤', '音声入力', 'mic'); setupMic(tab, mic);

    const swLabel = document.createElement('label');
    swLabel.className = 'tw-switch';
    swLabel.title = 'ON: 入力欄で編集(ターミナル直接入力ロック・IME安定) / OFF: ターミナルに直接入力';
    const swText = document.createElement('span'); swText.className = 'tw-switch-label'; swText.textContent = '入力';
    const switchInput = document.createElement('input'); switchInput.type = 'checkbox';
    const swSlider = document.createElement('span'); swSlider.className = 'tw-slider';
    swLabel.append(swText, switchInput, swSlider);
    keyrow.append(swLabel);
    if (isMobile) keyrow.append(mic); // スマホ: 入力切替スイッチのすぐ右にマイクを配置
    tab.switchEl = switchInput;
    switchInput.addEventListener('change', () => setInputMode(tab, switchInput.checked));
    wrap.appendChild(keyrow);

    // キー行が幅で多段に折り返すと高さが変わり端末領域が伸縮する(タブバーと同様)。
    // window resize が伴わない折り返し変化にも追従できるよう、行の高さを監視して
    // 表示中タブを再フィットする(最下行が切れないようにするため)。
    if (window.ResizeObserver) {
      let keyrowH = 0;
      new ResizeObserver(() => {
        const h = keyrow.offsetHeight;
        if (h !== keyrowH) { keyrowH = h; if (tab === active) fitActive(); }
      }).observe(keyrow);
    }

    // 高さ変更ハンドル(全タブ共通の高さ)
    const resize = document.createElement('div');
    resize.className = 'tw-resize';
    resize.title = 'ドラッグで高さ変更';
    setupResize(resize);
    wrap.appendChild(resize);

    // このターミナル専用の入力欄(OFF時は非表示。スイッチは上のキー行右端)
    const bar = document.createElement('div');
    bar.className = 'tw-input';

    const ta = document.createElement('textarea');
    ta.className = 'tw-text'; ta.rows = 2; ta.spellcheck = false;
    ta.placeholder = '入力（Enter＝改行 / Ctrl+Enter＝送信）';
    tab.inputEl = ta;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing) {
        e.preventDefault(); submitTab(tab);
      }
    });
    const ctrls = document.createElement('div');
    ctrls.className = 'tw-ctrls';
    // 添付(📎): 画像などのファイルを端末のカレントディレクトリへアップロードし、パスを入力欄に挿入
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true;
    const attach = mkIb('📎', '添付 (ファイルを端末に転送)', 'attach');
    attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { uploadFiles(tab, attach, fileInput.files); fileInput.value = ''; });
    const up = mkIb('⇧', '前の入力'); up.addEventListener('click', () => histUp(tab));
    const down = mkIb('⇩', '次の入力'); down.addEventListener('click', () => histDown(tab));
    const spacer = document.createElement('span'); spacer.className = 'spacer';
    const send = mkIb('送信 ⏎', '送信 (Ctrl+Enter)', 'send'); send.addEventListener('click', () => submitTab(tab));
    // スマホではマイクをキー行(スイッチの右)へ移したので、入力バーには含めない
    if (isMobile) ctrls.append(attach, up, down, send, spacer);
    else ctrls.append(mic, attach, up, down, send, spacer);
    bar.append(ta, ctrls, fileInput);
    wrap.appendChild(bar);

    // 貼り付け(paste): クリップボードに画像等のファイルがあればアップロード(テキスト貼り付けは通常どおり)
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])]
        .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); uploadFiles(tab, attach, files); }
    });
    // ドラッグ&ドロップ: 入力欄にファイルを落とすとアップロード
    ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('dragover'); });
    ta.addEventListener('dragleave', () => ta.classList.remove('dragover'));
    ta.addEventListener('drop', (e) => {
      e.preventDefault(); ta.classList.remove('dragover');
      if (e.dataTransfer?.files?.length) uploadFiles(tab, attach, e.dataTransfer.files);
    });

    termsEl.appendChild(wrap);

    // OFF(入力欄オフ)時のみ xtermへの直接入力を ws へ送る。ON時は disableStdin で発火しない。
    term.onData((d) => { if (!tab.inputOn) tabSendRaw(tab, d); });
    // 選択した瞬間(マウスを離した時)に自動コピー(Claudeの再描画で選択が消える前に取り込む)
    view.addEventListener('mouseup', () => { if (term.hasSelection()) copyText(term.getSelection()); });
    // マウスホイールで tmux の履歴をスクロール(tmux mouse on 前提)。入力欄ON時は xterm の
    // stdin が無効で転送されないため、capture で先取りして SGR ホイール列を直接 tmux へ送る
    // (xterm 側にも渡さないことで二重送出を防ぐ)。
    view.addEventListener('wheel', (ev) => {
      const btn = ev.deltaY < 0 ? 64 : 65; // 64=上へ / 65=下へ (SGRマウス wheel)
      const steps = Math.min(5, Math.max(1, Math.round(Math.abs(ev.deltaY) / 40)));
      let seq = '';
      for (let i = 0; i < steps; i += 1) seq += `\x1b[<${btn};1;1M`;
      tabSendRaw(tab, seq);
      ev.preventDefault();
      ev.stopPropagation();
    }, { capture: true, passive: false });
    // スマホ: タッチの縦ドラッグを tmux スクロールへ変換(タッチは wheel を発火しないため)。
    // 指を下げる=過去(上)へ、上げる=最新(下)へ。閾値未満のタップは素通り(フォーカス等)。
    let touchY = null; let touchAcc = 0;
    const TOUCH_STEP = 24; // この画素数ドラッグごとに1行スクロール
    view.addEventListener('touchstart', (ev) => {
      if (ev.touches.length === 1) { touchY = ev.touches[0].clientY; touchAcc = 0; } else { touchY = null; }
    }, { passive: true });
    view.addEventListener('touchmove', (ev) => {
      if (touchY === null || ev.touches.length !== 1) return;
      const y = ev.touches[0].clientY;
      touchAcc += y - touchY; touchY = y;
      let seq = '';
      while (Math.abs(touchAcc) >= TOUCH_STEP) {
        const up = touchAcc > 0; // 指を下げる → 履歴(上)へ
        seq += `\x1b[<${up ? 64 : 65};1;1M`;
        touchAcc -= up ? TOUCH_STEP : -TOUCH_STEP;
      }
      if (seq) tabSendRaw(tab, seq);
      // 単指ドラッグ(スクロール操作)中は毎回抑止する。しきい値未満でも必ず preventDefault する
      // ことで、タッチ由来の「合成マウスイベント」の発生を止める(最初の touchmove で防げば
      // 以降のmousedown/up/clickも出ない)。これを怠るとxtermがマウスレポート列に変換して
      // シェルへ送り、コマンド行に文字列が入り込む。stopPropagationでxtermのタッチ処理にも渡さない。
      ev.preventDefault();
      ev.stopPropagation();
    }, { capture: true, passive: false });
    view.addEventListener('touchend', () => { touchY = null; }, { passive: true });

    tab.inputOn = inputOnDefault;
    applyInputMode(tab); // 初期状態(表示/ロック/チェック)を反映

    tabBtn.addEventListener('click', (ev) => {
      if (ev.target === closeEl) return;
      if (window.EZ.setMode) window.EZ.setMode('terminal'); // EZbrowser: タブ操作で端末モードへ戻す
      const openMenu = !!tab.confirmItem; // 確認待ち(赤)なら選択肢プルダウンを開く
      // スマホではタブ切替のたびに入力欄へフォーカスが移ってキーボードが出るのを防ぐ
      // (メニューを開くときも同様にフォーカスは移さない)
      setActive(tab, { focus: !openMenu && !isMobile });
      if (!tab.connected) connect(tab); // 切断中(別デバイス接続等)ならタップで復帰
      if (openMenu) openTabMenu(tab); else closeTabMenu();
    });
    closeEl.addEventListener('click', () => closeTab(tab));

    tabs.push(tab);
    connect(tab);
    return tab;
  }

  function destroyTab(tab) {
    tab.closedByUser = true;
    stopHeartbeat(tab);
    if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    tab.sendQueue.length = 0;
    try { tab.ws?.close(); } catch { /* noop */ }
    tab.term.dispose();
    tab.wrap.remove();
    tab.tabBtn.remove();
    const idx = tabs.indexOf(tab);
    if (idx >= 0) tabs.splice(idx, 1);
    if (active === tab) active = null;
  }

  function setActive(tab, opts = {}) {
    active = tab;
    tabs.forEach((t) => {
      const on = t === tab;
      t.wrap.hidden = !on;
      t.tabBtn.classList.toggle('active', on);
    });
    localStorage.setItem(ACTIVE_KEY, tab.sid);
    fitActive();
    // 確認メニューを開くとき等は入力欄へフォーカスを移さない(スマホでキーボードが出て
    // 上部プルダウンの選択肢を押せなくなるのを防ぐ)。
    if (opts.focus !== false) (tab.inputOn ? tab.inputEl : tab.term)?.focus();
    updateConn();
    renderConfirm(lastView);
  }

  /* ---- タブ操作 (サーバーへ反映 → 再同期) ---- */
  async function closeTab(tab) {
    if (!confirm(`「${tab.title}」を閉じますか?\n(このターミナルのtmuxセッションは破棄され、全ブラウザから消えます)`)) return;
    tab.tabBtn.style.opacity = '.4';
    await api('/api/term/remove', { sid: tab.sid });
    poll();
  }

  document.getElementById('btn-add-tab').addEventListener('click', async () => {
    const t = await api('/api/term/add', {});
    if (t.terminal) localStorage.setItem(ACTIVE_KEY, t.terminal.sid); // 追加した端末を表示
    poll();
  });

  reconnectBtn.addEventListener('click', () => { location.reload(); }); // ページを再読み込み

  // iOS: ソフトキーボードを出すとSafariはビジュアルビューポートを上へずらす(スクロールさせる)。
  // CSSの height:100dvh はレイアウトビューポート基準で追随できず、上部バーがノッチ/時計に潜り込む。
  // そこで visualViewport に合わせてアプリ本体の高さを縮め、ずれた分を transform で打ち消して
  // 常に可視領域の最上部へロックする(キーボード分だけ下端が縮むので入力欄は隠れない)。
  const termApp = document.getElementById('term-app');
  function pinViewport() {
    const vv = window.visualViewport;
    if (!vv || !isMobile || !termApp) return;
    termApp.style.height = vv.height + 'px';
    termApp.style.transform = `translate(${vv.offsetLeft}px, ${vv.offsetTop}px)`;
  }
  window.addEventListener('resize', () => { pinViewport(); setTimeout(fitActive, 100); });
  window.visualViewport?.addEventListener('resize', () => { pinViewport(); setTimeout(fitActive, 100); });
  // タブが多段に折り返す/戻ると term-bar の高さが変わり端末領域が伸縮する。
  // window resize は発火しないため、バーの高さ変化を監視して端末を再フィットする。
  const termBar = document.getElementById('term-bar');
  // タブが多段に折り返しているかを判定し、その時だけ右端の操作ボタンを縦積みにする
  // (tabs-wrapped)。1段のときは横並びのままなのでバー高さは1ボタン分に収まる。
  const tabsMultiRow = () => {
    const kids = Array.from(tabsEl.children);
    if (kids.length < 2) return false;
    const top0 = kids[0].offsetTop;
    return kids.some((k) => k.offsetTop > top0 + 2); // 2段目以降があるか
  };
  function updateTabWrap() {
    if (!termBar) return;
    if (tabsMultiRow()) { termBar.classList.add('tabs-wrapped'); return; }
    // 1段に見えても、縦積み(操作ボタンが1ボタン幅)で幅が空いているだけかもしれない。
    // 横並びに戻して再測定し、それでも1段なら解除する(振動防止のヒステリシス)。
    if (termBar.classList.contains('tabs-wrapped')) {
      termBar.classList.remove('tabs-wrapped');
      if (tabsMultiRow()) termBar.classList.add('tabs-wrapped'); // 横並びだと溢れる→縦積み維持
    }
  }
  if (termBar && window.ResizeObserver) {
    let barH = 0;
    new ResizeObserver(() => {
      updateTabWrap();
      const h = termBar.offsetHeight;
      if (h !== barH) { barH = h; fitActive(); }
    }).observe(termBar);
  }
  // キーボード表示中の可視ビューポート移動(スクロール)にも追従して最上部固定を保つ
  window.visualViewport?.addEventListener('scroll', pinViewport);
  pinViewport(); // 初期反映

  /* ---- サーバーのタブ一覧とローカル実体を突き合わせる ---- */
  function syncTerminals(list) {
    // 追加 / タイトル更新
    for (const item of list) {
      let tab = tabs.find((t) => t.sid === item.sid);
      if (!tab) {
        tab = createTab({ sid: item.sid, title: item.title });
      } else if (tab.title !== item.title) {
        tab.title = item.title;
        tab.nameEl.textContent = item.title;
      }
    }
    // 削除 (サーバーに無いローカルタブ)
    for (const tab of [...tabs]) {
      if (!list.find((item) => item.sid === tab.sid)) destroyTab(tab);
    }
    // 並び順をサーバーに合わせる (タブボタンのみ。端末本体は絶対配置なので順序は無関係)。
    // 順序が変わったときだけDOMを触る — 毎回appendChildすると入力中のtextareaがblurして
    // 入力を受け付けなくなるため。
    const desired = list.map((item) => item.sid);
    const current = Array.from(tabsEl.children)
      .filter((el) => el !== btnAddTab)
      .map((el) => (tabs.find((t) => t.tabBtn === el) || {}).sid);
    if (desired.join(',') !== current.join(',')) {
      for (const sid of desired) {
        const tab = tabs.find((t) => t.sid === sid);
        if (tab) tabsEl.appendChild(tab.tabBtn);
      }
      tabsEl.appendChild(btnAddTab); // ＋ボタンを最後尾へ
    }
    // アクティブタブの確定
    if (!active || !tabs.includes(active)) {
      const savedSid = localStorage.getItem(ACTIVE_KEY);
      const target = tabs.find((t) => t.sid === savedSid) || tabs[0];
      if (target) setActive(target);
    }
  }

  /* ---- タブのステータス反映(●の色分け + 確認情報の保持) ---- */
  const OPT_LABEL = { accept: '実行', accept_all: 'すべて実行', reject: '中止' };

  function renderConfirm(list) {
    list.forEach((item) => {
      // タブの●をClaude状態で色分け(待機=緑/作業中=青/確認待ち=赤)、確認情報を保持
      const tab = tabs.find((t) => t.sid === item.sid);
      if (tab) {
        const st = (item.state === 'idle' || item.state === 'running' || item.state === 'confirm') ? item.state : 'unknown';
        tab.dotEl.className = 'dot st-' + st;
        tab.tabBtn.classList.toggle('confirm', item.state === 'confirm');
        tab.confirmItem = item.state === 'confirm' ? item : null;
        // 「確認待ちに変わった瞬間」だけ鳴らす。初回観測時(prevState未定義)や
        // すでに確認中の間は鳴らさない(ページ読込直後の連続鳴動を防ぐ)。
        if (st === 'confirm' && tab.prevState !== undefined && tab.prevState !== 'confirm') playPon();
        tab.prevState = st;
      }
    });

    // 確認が解消/対象タブが消えたら、開いているプルダウンを閉じる
    if (tabMenuSid) {
      const t = tabs.find((x) => x.sid === tabMenuSid);
      if (!t || !t.confirmItem) closeTabMenu();
    }
  }

  /* ---- タブのプルダウン(確認待ちタブの選択肢) ---- */
  const tabMenu = document.createElement('div');
  tabMenu.id = 'tab-menu';
  tabMenu.hidden = true;
  document.body.appendChild(tabMenu);
  let tabMenuSid = null;

  function closeTabMenu() { tabMenu.hidden = true; tabMenu.innerHTML = ''; tabMenuSid = null; }
  function openTabMenu(tab) {
    const item = tab.confirmItem;
    if (!item || !(item.options || []).length) { closeTabMenu(); return; }
    // 入力欄にフォーカスが残っていると(スマホ)キーボードがメニューを隠すので外す
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    tabMenuSid = tab.sid;
    const q = item.question ? `<div class="tm-q">${escHtml(item.question)}</div>` : '';
    const opts = item.options.map((o) => {
      const label = OPT_LABEL[o.kind] || escHtml(o.text);
      return `<button class="tm-opt ${o.kind}" data-sid="${escHtml(tab.sid)}" data-key="${o.n}"><b>${o.n}.</b> ${label}</button>`;
    }).join('');
    tabMenu.innerHTML = q + opts;
    tabMenu.hidden = false;
    const r = tab.tabBtn.getBoundingClientRect();
    tabMenu.style.left = Math.round(Math.min(r.left, window.innerWidth - tabMenu.offsetWidth - 8)) + 'px';
    tabMenu.style.top = Math.round(r.bottom + 2) + 'px';
    tabMenu.querySelectorAll('.tm-opt').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        await api('/api/term/send', { sid: b.dataset.sid, key: Number(b.dataset.key) });
        closeTabMenu();
        poll();
      });
    });
  }
  document.addEventListener('mousedown', (e) => {
    if (!tabMenu.hidden && !tabMenu.contains(e.target) && !e.target.closest('.term-tab')) closeTabMenu();
  });
  window.addEventListener('resize', closeTabMenu);

  /* ---- ポーリング: サーバーの唯一の真実を取得して同期 ---- */
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const json = await api('/api/term/view');
      lastView = json.terminals || [];
      syncTerminals(lastView);
      renderConfirm(lastView);
    } catch { /* 次回リトライ */ } finally {
      polling = false;
    }
  }
  setInterval(() => { if (!document.hidden) poll(); }, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  poll(); // 初回同期
})();
