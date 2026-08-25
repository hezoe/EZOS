/* EZOS Webターミナル (xterm.js) — 複数タブ + サーバー共有
   タブ構成(ターミナルの数・タイトル・順序)はサーバー(/api/term/*)が正本で、
   全ブラウザ・全デバイスで同一。各タブは tmux セッション ez_<sid> に attach するため、
   複数ブラウザから同じ画面が見える。状態(確認待ち/処理中/完了)も共有。
   localStorageに持つのは「このブラウザでどのタブを見ているか」だけ。 */
'use strict';

(() => {
  console.info('[EZOS] term.js build: tabs(dynamic+, state-dot, pulldown, touch-scroll-fix, vv-pin, keyrow-reorder+wrap, switch-next-to-esc, ctrl-end, actions-stack-when-wrapped, ctrl-keys-no-focus, mobile-no-brand, wrap-hysteresis, git-buttons-submit, send-after-down, shift-tab, sanitize, file-upload, web-links, goto-terminal, file-links-to-editor, local-selection, mic-next-to-switch, prompt-btns-no-kbd, keyrow-no-kbd, mic-to-terminal-when-off, resilient-net, mic-stream-to-terminal, confirm-alarm-pon, idle-alarm+blue-dot, freeform-letter-choices, dynamic-favicon, idle-pop-sound, robust-running+idle-debounce, dot-spinner-fix)(2026-07-11c)'); // 版確認用
  const isMobile = window.EZ.view === 'mobile';
  const t = (k, v) => (window.EZ && window.EZ.t ? window.EZ.t(k, v) : k); // i18n(i18n.jsが提供)
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

  /* ---- 確認待ちアラーム音「にゃーん」。タブが選択確認(confirm)状態になった瞬間に鳴らす ----
     音声ファイルは使わず Web Audio でその場生成(CSP安全)。ブラウザは最初のユーザー操作まで
     音を出せないため、初回操作で AudioContext を有効化しておく。 */
  // 確認待ち/作業終了の通知音。音声ファイルは /assets/sounds/ から取得し Web Audio で再生する。
  // 確認音は設定(localStorage: ez_confirm_sound)で切替可能。ブラウザは最初のユーザー操作まで
  // 音を出せないため、初回操作で AudioContext を有効化しておく。
  const SOUND_URL = {
    limitbreak: '/assets/sounds/limitbreak.wav',
    meow: '/assets/sounds/meow.mp3',
  };
  let audioCtx = null;
  const soundBufs = {};        // name -> デコード済みAudioBuffer
  const soundLoading = {};     // name -> 読込中フラグ
  function confirmSound() { return localStorage.getItem('ez_confirm_sound') || 'limitbreak'; }
  function idleSoundOn() { return localStorage.getItem('ez_idle_sound') !== '0'; }
  function loadSound(ac, name) {
    if (!ac || !SOUND_URL[name] || soundBufs[name] || soundLoading[name]) return;
    soundLoading[name] = true;
    fetch(SOUND_URL[name])
      .then((r) => r.arrayBuffer())
      .then((buf) => ac.decodeAudioData(buf, (b) => { soundBufs[name] = b; }, () => { soundLoading[name] = false; }))
      .catch(() => { soundLoading[name] = false; });
  }
  function playBuffer(ac, buf) {
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = 0.45; // 音量控えめ
    src.connect(g).connect(ac.destination);
    src.start();
  }
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { /* noop */ });
    const cs = confirmSound();
    if (SOUND_URL[cs]) loadSound(audioCtx, cs); // 現在の確認音を先読み(confirm時に即鳴らせる)
    return audioCtx;
  }
  // 最初のユーザー操作で音声を解禁(自動再生ブロック対策)
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, ensureAudio, { once: true, passive: true, capture: true }));
  // 設定ビュー(menu.js)から確認音を試聴するためのフック
  window.EZ.previewSound = (name) => {
    const ac = ensureAudio();
    if (!ac || !SOUND_URL[name]) return;
    if (soundBufs[name]) { playBuffer(ac, soundBufs[name]); return; }
    loadSound(ac, name);
    setTimeout(() => { if (soundBufs[name]) playBuffer(ac, soundBufs[name]); }, 400);
  };
  // 確認待ち(confirm)の通知音: 設定で選ばれた音声を再生(off なら鳴らさない)
  function playPon() {
    const ac = ensureAudio();
    if (!ac || ac.state !== 'running') return; // 未解禁なら鳴らさない
    const name = confirmSound();
    if (name === 'off' || !SOUND_URL[name]) return;
    if (!soundBufs[name]) { loadSound(ac, name); return; } // 未デコードなら今回は見送り(次回に備え先読み)
    playBuffer(ac, soundBufs[name]);
  }
  // 作業終了(idle=次のプロンプト入力可)の通知音: 「ポンッ!」という短い電子音を
  // その場で合成(WAV不要・CSP安全)。confirm音と明確に区別するため別の音色にする。
  function playPop() {
    const ac = ensureAudio();
    if (!ac || ac.state !== 'running' || !idleSoundOn()) return; // 未解禁/設定OFFなら鳴らさない
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);                 // 立ち上がりは高め
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.09); // 「ポンッ」と下がる
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.008);  // 速いアタック
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55); // 余韻を長めに(ポーンッ)
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  // 各ターミナルに一体化した入力欄・制御キー行の共通定義
  const KEYROW = [
    ['⏎', '\r'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
    ['^C', '\x03'], ['^D', '\x04'], ['^End', '\x1b[1;5F'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Esc', '\x1b'],
  ];
  const HIST_KEY = 'ez_input_history';
  const INPUT_H_KEY = 'ez_input_h';
  // tmuxのマウスホイール1ノッチあたりのスクロール行数(既定)。右端スクロールバーの
  // ドラッグ量→送出ノッチ数の換算に使う(実測5行/ノッチ)。ズレは直後の再問い合わせで補正。
  const LINES_PER_NOTCH = 5;
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
        else { alert(t('term.uploadFail', { msg: j.error || res.status })); }
      }
    } catch (e) {
      alert(t('term.uploadFail', { msg: e.message }));
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
      tab.requestScr?.(); // 右端スクロールバーの初期状態を取得
    };
    ws.onmessage = (ev) => {
      tab.lastRecv = Date.now(); // 受信があった=生存。ハートビート判定の基準
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.t === 'pong') return; // ハートビート応答(lastRecv更新のみ)
          if (m.t === 'scr') { // 右端スクロールバー: tmuxの現在スクロール位置を反映
            tab.scr = { pos: +m.pos || 0, hist: +m.hist || 0, h: +m.h || tab.term.rows || 0, mouse: +m.mouse || 0 };
            tab.applyScroll?.();
            return;
          }
          if (m.t === 'exit') {
            tab.gotExit = true; // セッション終了/別デバイスへ切替 → 自動再接続しない
            tab.term.write(`\r\n\x1b[90m[${t('term.sessionEnded', { code: m.code })}]\x1b[0m\r\n`);
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
        tab.term.write(`\x1b[90m[${t('term.detached')}]\x1b[0m\r\n`);
        return;
      }
      // 通信断(機内Wi-Fi等): 自動再接続。案内は一度だけ出す(再試行のたびに汚さない)。
      if (!tab.reconnectNotified) {
        tab.term.write(`\r\n\x1b[90m[${t('term.disconnected')}]\x1b[0m\r\n`);
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

  /* ---- コンソール内容の選択コピー ----
     iPhone等では xterm(canvas/DOM描画)を直接タッチしても iOS標準の選択ポップアップが
     出ない(タッチはスクロールに割り当て済み)。そこで現在の画面テキストを、ネイティブ選択が
     効く <pre>(user-select:text)に写して長押し選択→コピーできるようにする。ワンタップで
     全文コピーするボタンも用意する。 */
  function buildTermText(term) {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    // 先頭・末尾の空行を落とす(見やすさのため)
    let start = 0; let end = lines.length;
    while (start < end && lines[start].trim() === '') start += 1;
    while (end > start && lines[end - 1].trim() === '') end -= 1;
    return lines.slice(start, end).join('\n');
  }
  function openTermSelect(tab) {
    const text = buildTermText(tab.term);
    const wrap = document.createElement('div');
    wrap.className = 'ez-overlay';
    const modal = document.createElement('div');
    modal.className = 'ez-modal wide tw-sel-modal';
    const head = document.createElement('div');
    head.className = 'ez-modal-head';
    const h = document.createElement('h2'); h.textContent = t('term.selectTitle');
    const copyAll = document.createElement('button');
    copyAll.className = 'btn'; copyAll.textContent = t('term.copyAll');
    const x = document.createElement('button');
    x.className = 'ez-modal-x'; x.textContent = '✕'; x.setAttribute('aria-label', t('common.close'));
    head.append(h, copyAll, x);
    const body = document.createElement('div');
    body.className = 'ez-modal-body';
    const hint = document.createElement('div');
    hint.className = 'tw-sel-hint'; hint.textContent = t('term.selectHint');
    // iOS で長押し選択→コピーが最も確実に効くのは読み取り専用 textarea。value に画面テキストを入れる。
    const pre = document.createElement('textarea');
    pre.className = 'tw-selpre'; pre.readOnly = true; pre.value = text;
    pre.setAttribute('autocapitalize', 'off'); pre.setAttribute('autocorrect', 'off');
    pre.setAttribute('spellcheck', 'false'); pre.setAttribute('wrap', 'soft');
    body.append(hint, pre);
    modal.append(head, body);
    wrap.appendChild(modal);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(ev) { if (ev.key === 'Escape') close(); }
    x.addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onEsc);
    copyAll.addEventListener('click', () => {
      copyText(text);
      copyAll.textContent = t('term.copied');
      setTimeout(() => { copyAll.textContent = t('term.copyAll'); }, 1500);
    });
    document.body.appendChild(wrap);
    pre.scrollTop = pre.scrollHeight; // 最新(末尾)を表示
  }

  /* ---- 音声入力(Web Speech API)。マイクボタンで開始/停止し、認識結果を入力欄へ ---- */
  function setupMic(tab, btn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.disabled = true; btn.title = t('term.micUnsupported'); btn.classList.add('unsupported'); return; }
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
      rec.onstart = () => { recording = true; btn.classList.add('rec'); btn.textContent = '⏹'; btn.title = t('term.micStop'); };
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
          'not-allowed': t('term.micNotAllowed'),
          'service-not-allowed': t('term.micServiceNotAllowed'),
          'network': t('term.micNetwork'),
          'audio-capture': t('term.micNoCapture'),
        }[e.error];
        if (e.error !== 'no-speech' && e.error !== 'aborted') alert(msg || t('term.micError', { error: e.error }));
      };
      rec.onend = () => {
        recording = false; btn.classList.remove('rec'); btn.textContent = '🎤'; btn.title = t('term.mic');
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
          alert(t('term.micAccessFail', { name: err.name }));
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
      if (!cwd) { alert(t('term.noBaseDir', { path: s })); return; }
      abs = cwd.replace(/\/+$/, '') + '/' + s;
    }
    if (window.EZ && typeof window.EZ.openFileInEditor === 'function') window.EZ.openFileInEditor(abs);
    else alert(t('term.editorUnavailable'));
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

    // 右端スクロールバー。履歴はtmuxが管理するため、xterm自身のスクロールバーではなく
    // tmuxのスクロール位置(サーバから { t:'scr' } で取得)に連動する専用バーを重ねる。
    // つまみをドラッグ/クリックすると、ホイールスクロールと同じSGR列をtmuxへ送って遡る。
    const sb = document.createElement('div');
    sb.className = 'tw-scroll';
    const thumb = document.createElement('div');
    thumb.className = 'tw-scroll-thumb';
    sb.appendChild(thumb);
    view.appendChild(sb);

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
    nameEl.title = meta.title; // 省略表示の全文をホバー/長押しで確認できるように
    const closeEl = document.createElement('button');
    closeEl.className = 't-close';
    closeEl.title = t('term.closeTerminal');
    closeEl.textContent = '×';
    tabBtn.append(dotEl, nameEl, closeEl);
    tabsEl.insertBefore(tabBtn, btnAddTab); // ＋ボタンは常に最後尾に保つ

    const tab = {
      sid: meta.sid, title: meta.title, term, fit, wrap, view, tabBtn, nameEl, dotEl,
      sb, thumb, scr: { pos: 0, hist: 0, h: 0 }, // 右端スクロールバーの表示要素と現在のtmuxスクロール状態
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
    // Shift+↑/↓ で履歴を1行ずつスクロール。コンソール(xterm)にフォーカスがあっても
    // 入力欄にあっても効くよう、この端末ブロック(wrap)全体の capture フェーズで先取りする
    // (xterm/入力欄/シェルが処理する前に奪う)。素の↑/↓はシェル履歴やClaudeの選択移動に
    // 使うため、Shift付きだけをスクロール専用にする。
    wrap.addEventListener('keydown', (e) => {
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing
          && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Up' || e.key === 'Down')) {
        e.preventDefault(); e.stopPropagation();
        tab.scrollLine?.(/Up$|^Up$/.test(e.key) ? 'up' : 'down');
      }
    }, { capture: true });

    // このターミナル専用の制御キー行(右端に入力欄ON/OFFスイッチを同居させ省スペース化)
    const keyrow = document.createElement('div');
    keyrow.className = 'tw-keyrow';
    // これらのキーは常にプロンプトへ直接送信する(tabSendRaw)。スマホでは送信後に
    // フォーカスを移さず、入力モード(ソフトキーボード)へ勝手に切り替わらないようにする。
    // PCでは従来どおり入力先へフォーカスを戻す(制御信号系 ^C/^D/^End は除く=カーソルが飛ぶため)。
    const NO_FOCUS = new Set(['^C', '^D', '^End']);
    // Claude起動ボタン(⏎とTabの間)。Claudeロゴ風スターバースト(ブランドカラー#D97757)を
    // 表示し、クリックで "claude"+Enter をアクティブ端末へ送出してClaudeを起動する。
    // 送信方式はGitボタンと同じ「ブラケットペースト+独立Enter」で、シェル/Claudeプロンプト
    // どちらでも確実に実行され、未接続でもキュー経由で取りこぼさない。
    const CLAUDE_CMD = 'claude';
    const claudeBlades = Array.from({ length: 11 }, (_, i) =>
      `<path transform="rotate(${(i * 360 / 11).toFixed(2)} 12 12)" d="M12 2.4C12.5 6 12.7 9.3 12 10.7C11.3 9.3 11.5 6 12 2.4Z"/>`).join('');
    const CLAUDE_ICON = '<svg class="claude-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + `<g fill="#D97757">${claudeBlades}<circle cx="12" cy="12" r="1.4"/></g></svg>`;
    const mkClaude = () => {
      const b = document.createElement('button');
      b.className = 'claudekey';
      b.title = t('term.launchClaude');
      b.setAttribute('aria-label', t('term.launchClaude'));
      b.innerHTML = CLAUDE_ICON;
      b.addEventListener('click', () => {
        tabSendRaw(tab, '\x1b[200~' + CLAUDE_CMD + '\x1b[201~');
        tabSendRaw(tab, '\r');
        if (!isMobile) (tab.inputOn ? tab.inputEl : tab.term).focus();
      });
      return b;
    };
    for (const [label, seq] of KEYROW) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        tabSendRaw(tab, seq);
        if (!isMobile && !NO_FOCUS.has(label)) (tab.inputOn ? tab.inputEl : tab.term).focus();
      });
      keyrow.appendChild(b);
      if (label === '⏎') keyrow.appendChild(mkClaude()); // ⏎とTabの間にClaude起動ボタン
    }

    // Git操作ボタン(ESCの右)。シェルでもClaudeプロンプトでも同じコマンド行を流し込み、
    // 相手(シェル=直接実行 / Claude=そのコマンドを実行)に処理させることでどちらでも動く。
    // 送信先はアクティブ端末なので、そのターミナルのカレントディレクトリで実行される。
    const GIT_PULL = 'git pull';
    const GIT_PUSH = 'git add -A && git commit -m "update $(date +%F_%T)" && git push';
    // GitHub の Octocat マーク(公式ロゴ形状)。currentColor でボタンの文字色に追従。
    const GH_ICON = '<svg class="gh-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38'
      + ' 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53'
      + '.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95'
      + ' 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09'
      + ' 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95'
      + '.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
    const mkGit = (arrow, title, cmd) => {
      const b = document.createElement('button');
      b.className = 'gitkey'; b.title = title;
      b.innerHTML = GH_ICON + '<span class="gh-arrow">' + arrow + '</span>'; // Octocat + 矢印(↓/↑)
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
      mkGit('↓', t('term.gitPull'), GIT_PULL),
      mkGit('↑', t('term.gitPush'), GIT_PUSH),
    );

    // 選択コピー(📋): コンソール内容を選択可能なオーバーレイで開く。iPhone等で xterm を
    // 直接タッチしても選択ポップアップが出ないため、この経路で長押し選択/全文コピーする。
    const selBtn = document.createElement('button');
    selBtn.className = 'selkey'; selBtn.textContent = '📋'; selBtn.title = t('term.selectCopy');
    selBtn.addEventListener('click', () => openTermSelect(tab));
    keyrow.appendChild(selBtn);

    // 入力欄下の丸ボタン生成ヘルパ(マイクもこれで作り、スマホではキー行へ置く)
    const mkIb = (label, title, cls) => {
      const b = document.createElement('button');
      b.className = 'ib-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.title = title;
      return b;
    };
    // マイク(音声入力): 認識結果は入力欄に限らず直接プロンプトへ入力することもある。
    // スマホでは入力切替スイッチのすぐ右に置き、入力欄OFF(直接入力)でも使えるようにする。
    const mic = mkIb('🎤', t('term.mic'), 'mic'); setupMic(tab, mic);

    const swLabel = document.createElement('label');
    swLabel.className = 'tw-switch';
    swLabel.title = t('term.inputSwitchTitle');
    const swText = document.createElement('span'); swText.className = 'tw-switch-label'; swText.textContent = t('term.inputLabel');
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
    resize.title = t('term.dragResize');
    setupResize(resize);
    wrap.appendChild(resize);

    // このターミナル専用の入力欄(OFF時は非表示。スイッチは上のキー行右端)
    const bar = document.createElement('div');
    bar.className = 'tw-input';

    const ta = document.createElement('textarea');
    ta.className = 'tw-text'; ta.rows = 2; ta.spellcheck = false;
    ta.placeholder = t('term.inputPlaceholder');
    tab.inputEl = ta;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing) {
        e.preventDefault(); submitTab(tab);
      }
      // Shift+↑/↓(履歴スクロール)は wrap の capture ハンドラで先取りされるためここでは扱わない
    });
    const ctrls = document.createElement('div');
    ctrls.className = 'tw-ctrls';
    // 添付(📎): 画像などのファイルを端末のカレントディレクトリへアップロードし、パスを入力欄に挿入
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true;
    const attach = mkIb('📎', t('term.attach'), 'attach');
    attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { uploadFiles(tab, attach, fileInput.files); fileInput.value = ''; });
    const up = mkIb('⇧', t('term.histPrev')); up.addEventListener('click', () => histUp(tab));
    const down = mkIb('⇩', t('term.histNext')); down.addEventListener('click', () => histDown(tab));
    const spacer = document.createElement('span'); spacer.className = 'spacer';
    const send = mkIb(t('term.sendLabel'), t('term.sendTitle'), 'send'); send.addEventListener('click', () => submitTab(tab));
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
    // OFF(直接入力)時の Ctrl+V / Ctrl+C を調整する。ON(入力欄)時は textarea が担当。
    // ・Ctrl+V: xterm が送る \x16(^V=readlineのquoted-insert)を抑止するだけにする。false を
    //   返すと xterm はキー送出をやめ、preventDefault はしないのでブラウザ標準の貼り付けが
    //   1回だけ効く(=貼り付けが壊れず、二重貼り付けにもならない)。自前 readText はしない。
    // ・Ctrl+C: 選択があれば標準のcopyを止めて選択をコピー(SIGINTは送らない)。選択が無ければ
    //   従来どおり ^C(中断)を通す。Mac の Cmd 系はネイティブに任せるため ctrlKey のみ対象。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || tab.inputOn) return true;
      if (!e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = (e.key || '').toLowerCase();
      if (k === 'v') return false;
      if (k === 'c' && term.hasSelection()) {
        e.preventDefault();
        copyText(term.getSelection());
        return false;
      }
      return true;
    });
    // 選択した瞬間(マウスを離した時)に自動コピー(Claudeの再描画で選択が消える前に取り込む)
    view.addEventListener('mouseup', () => { if (term.hasSelection()) copyText(term.getSelection()); });
    // マウスホイールで tmux の履歴をスクロール(tmux mouse on 前提)。入力欄ON時は xterm の
    // stdin が無効で転送されないため、capture で先取りして SGR ホイール列を直接 tmux へ送る
    // (xterm 側にも渡さないことで二重送出を防ぐ)。
    // タッチパッドの慣性スクロールが強すぎて位置を見失う問題への対策。
    // deltaを画素に正規化して貯め、一定量(WHEEL_PX_PER_NOTCH)たまるごとに1ノッチだけ送る。
    // 従来は微小イベントごとに最低1ノッチ(=数行)を強制していたため、タッチパッドが吐く
    // 多数の微小イベントで一気に飛んでいた。端数は持ち越し、1イベントの上限も設ける。
    let wheelAcc = 0;
    const WHEEL_PX_PER_NOTCH = 50; // 大きいほど鈍く(控えめ)になる
    const WHEEL_MAX_NOTCHES = 3;   // 1イベントで送る最大ノッチ数(強いフリックの暴走を抑える)
    view.addEventListener('wheel', (ev) => {
      let dy = ev.deltaY;
      if (ev.deltaMode === 1) dy *= 16;                    // 行単位 → 概算px
      else if (ev.deltaMode === 2) dy *= view.clientHeight; // ページ単位 → px
      wheelAcc += dy;
      const notches = Math.trunc(wheelAcc / WHEEL_PX_PER_NOTCH);
      if (notches !== 0) {
        wheelAcc -= notches * WHEEL_PX_PER_NOTCH; // 消費(超過分は捨てて暴走を抑える)、端数は持ち越し
        const capped = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, notches));
        const btn = capped < 0 ? 64 : 65; // 上(負=deltaY<0)=64 / 下(正)=65
        const count = Math.abs(capped);
        let seq = '';
        for (let i = 0; i < count; i += 1) seq += `\x1b[<${btn};1;1M`;
        tabSendRaw(tab, seq);
        tab.scr.pos = Math.max(0, (tab.scr.pos || 0) + (btn === 64 ? 1 : -1) * count * LINES_PER_NOTCH); // 楽観更新
        tab.applyScroll?.();
        clearTimeout(tab._scrTimer); tab._scrTimer = setTimeout(() => tab.requestScr?.(), 90);
      }
      ev.preventDefault();
      ev.stopPropagation();
    }, { capture: true, passive: false });
    // スマホ: タッチの縦ドラッグを tmux スクロールへ変換(タッチは wheel を発火しないため)。
    // 指を下げる=過去(上)へ、上げる=最新(下)へ。閾値未満のタップは素通り(フォーカス等)。
    let touchY = null; let touchAcc = 0;
    const TOUCH_STEP = 24; // この画素数ドラッグごとに1行スクロール
    // 長押し検出: iPhone等では xterm を直接タッチしても選択できないため、コンソールを
    // 長押ししたら選択コピー用オーバーレイ(openTermSelect)を開く。指が動いたら(=スクロール)
    // 取り消す。
    let lpTimer = null; let lpX = 0; let lpY = 0;
    const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    view.addEventListener('touchstart', (ev) => {
      // 右端スクロールバー上のタッチは専用ドラッグ(pointer)に任せ、view側の履歴スクロールは無効化
      // (両方が反応して二重スクロールするのを防ぐ)。
      if (ev.target.closest && ev.target.closest('.tw-scroll')) { touchY = null; clearLP(); return; }
      if (ev.touches.length === 1) {
        touchY = ev.touches[0].clientY; touchAcc = 0;
        lpX = ev.touches[0].clientX; lpY = ev.touches[0].clientY;
        clearLP();
        lpTimer = setTimeout(() => { lpTimer = null; touchY = null; openTermSelect(tab); }, 480);
      } else { touchY = null; clearLP(); }
    }, { passive: true });
    view.addEventListener('touchmove', (ev) => {
      // 指が一定以上動いたら長押し(選択)ではなくスクロール操作 → 長押しを取り消す
      if (lpTimer && ev.touches.length === 1) {
        const p0 = ev.touches[0];
        if (Math.abs(p0.clientX - lpX) > 10 || Math.abs(p0.clientY - lpY) > 10) clearLP();
      }
      if (touchY === null || ev.touches.length !== 1) return;
      const y = ev.touches[0].clientY;
      touchAcc += y - touchY; touchY = y;
      let seq = '';
      while (Math.abs(touchAcc) >= TOUCH_STEP) {
        const up = touchAcc > 0; // 指を下げる → 履歴(上)へ
        seq += `\x1b[<${up ? 64 : 65};1;1M`;
        touchAcc -= up ? TOUCH_STEP : -TOUCH_STEP;
      }
      if (seq) {
        tabSendRaw(tab, seq);
        clearTimeout(tab._scrTimer); tab._scrTimer = setTimeout(() => tab.requestScr?.(), 90);
      }
      // 単指ドラッグ(スクロール操作)中は毎回抑止する。しきい値未満でも必ず preventDefault する
      // ことで、タッチ由来の「合成マウスイベント」の発生を止める(最初の touchmove で防げば
      // 以降のmousedown/up/clickも出ない)。これを怠るとxtermがマウスレポート列に変換して
      // シェルへ送り、コマンド行に文字列が入り込む。stopPropagationでxtermのタッチ処理にも渡さない。
      ev.preventDefault();
      ev.stopPropagation();
    }, { capture: true, passive: false });
    view.addEventListener('touchend', () => { touchY = null; clearLP(); }, { passive: true });
    view.addEventListener('touchcancel', () => { touchY = null; clearLP(); }, { passive: true });

    // ---- 右端スクロールバー(tmuxのスクロール位置に連動) ----
    // つまみの高さ=表示行数/総行数、位置=最下部からの遡り量(pos)で決まる。
    // pos=0(最新)でつまみは最下、pos=hist(履歴の先頭)でつまみは最上。
    function applyScroll() {
      const { pos = 0, hist = 0, h = 0 } = tab.scr || {};
      const total = hist + h;
      if (total <= 0) { thumb.style.top = '0'; thumb.style.height = '100%'; sb.classList.add('inert'); return; }
      const heightPct = Math.max(8, (h / total) * 100); // 最小サイズを確保してつまみを掴みやすく
      const maxTop = 100 - heightPct;
      const topPct = ((hist - pos) / total) * 100;
      thumb.style.height = `${heightPct}%`;
      thumb.style.top = `${Math.max(0, Math.min(maxTop, topPct))}%`;
      sb.classList.toggle('inert', hist <= 0); // 履歴が無ければ遡れない=淡色表示
    }
    tab.applyScroll = applyScroll;
    function requestScr() {
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
        try { tab.ws.send(JSON.stringify({ t: 'scr' })); } catch { /* noop */ }
      }
    }
    tab.requestScr = requestScr;
    // Shift+↑/↓ で1段スクロール。相手が代替画面のマウス対応アプリ(Claude等)か素のシェルかで
    // 手段を切り替える(前者はtmux履歴が無く copy-mode に入っても [0/0] になるだけのため)。
    function scrollLine(dir) {
      if (!(tab.ws && tab.ws.readyState === WebSocket.OPEN)) return;
      const up = dir === 'up';
      if (tab.scr && tab.scr.mouse) {
        // Claude等: ホイール1ノッチをアプリへ転送し、アプリ自身にスクロールさせる。
        // (copy-modeには入らない。tmux履歴は動かないのでスクロールバーは変えない)
        tabSendRaw(tab, `\x1b[<${up ? 64 : 65};1;1M`);
        return;
      }
      // 素のシェル: サーバがtmux履歴を精密に1行スクロールし、{t:'scr'}で実位置を返す。
      try { tab.ws.send(JSON.stringify({ t: 'scrline', dir, n: 1 })); } catch { /* noop */ }
      tab.scr.pos = Math.max(0, (tab.scr.pos || 0) + (up ? 1 : -1)); // 楽観更新
      applyScroll();
    }
    tab.scrollLine = scrollLine;
    // 目標posへスクロール。tmuxへは相対的なホイール列しか送れないため、現在posとの
    // 差分行数をノッチ数(1ノッチ=LINES_PER_NOTCH行)に換算して送る。端数や設定差は
    // 直後の requestScr で実値に補正されるため、掴んだ位置へ十分正確に飛ぶ。
    function scrollToPos(target) {
      const cur = (tab.scr && tab.scr.pos) || 0;
      const deltaLines = Math.round(target) - cur; // >0: 履歴(上)へ / <0: 最新(下)へ
      if (!deltaLines) return;
      const up = deltaLines > 0;
      let notches = Math.ceil(Math.abs(deltaLines) / LINES_PER_NOTCH);
      if (up && cur === 0) notches += 1; // liveからの初回ノッチはcopy-mode移行のみで動かない分
      const btn = up ? 64 : 65;
      const n = Math.min(700, notches);
      let seq = '';
      for (let i = 0; i < n; i += 1) seq += `\x1b[<${btn};1;1M`;
      tabSendRaw(tab, seq);
      tab.scr.pos = Math.max(0, Math.round(target)); // 楽観更新(直後のrequestScrで実値に補正)
      applyScroll();
      clearTimeout(tab._scrTimer); tab._scrTimer = setTimeout(requestScr, 90);
    }
    // ポインタ位置(トラック内の縦割合)から目標posを算出。つまみ中心がポインタに来るようにする。
    function posFromPointer(clientY) {
      const r = sb.getBoundingClientRect();
      const { hist = 0, h = 0 } = tab.scr || {};
      const total = hist + h;
      if (total <= 0 || hist <= 0) return 0;
      const f = h / total;            // つまみの高さ割合
      const travel = 1 - f;           // つまみが動ける範囲(上端割合)
      let frac = (clientY - r.top) / r.height;
      frac = Math.max(0, Math.min(1, frac));
      let topFrac = frac - f / 2;
      topFrac = Math.max(0, Math.min(travel, topFrac));
      return travel > 0 ? hist * (1 - topFrac / travel) : 0;
    }
    let sbDragging = false;
    sb.addEventListener('pointerdown', (ev) => {
      sbDragging = true;
      try { sb.setPointerCapture(ev.pointerId); } catch { /* noop */ }
      scrollToPos(posFromPointer(ev.clientY));
      ev.preventDefault(); ev.stopPropagation();
    });
    sb.addEventListener('pointermove', (ev) => {
      if (!sbDragging) return;
      scrollToPos(posFromPointer(ev.clientY));
      ev.preventDefault(); ev.stopPropagation();
    });
    const endSbDrag = (ev) => {
      if (!sbDragging) return;
      sbDragging = false;
      try { sb.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      requestScr();
    };
    sb.addEventListener('pointerup', endSbDrag);
    sb.addEventListener('pointercancel', endSbDrag);

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
    tab.requestScr?.(); // 右端スクロールバーを表示中タブの状態に更新
  }

  // 表示中タブのtmuxスクロール位置を定期取得し、右端スクロールバーのつまみを追従させる
  // (ホイール/タッチ/他デバイス操作による移動も反映)。非表示タブや切断中は問い合わせない。
  setInterval(() => {
    if (active && active.connected && document.visibilityState === 'visible') active.requestScr?.();
  }, 700);

  /* ---- タブ操作 (サーバーへ反映 → 再同期) ---- */
  async function closeTab(tab) {
    if (!confirm(t('term.closeConfirm', { title: tab.title }))) return;
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

  // ログオフ/設定/マニュアル/言語はヘッダーのハンバーガーメニュー(menu.js)が担当する。

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
        tab.nameEl.title = item.title;
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
  const OPT_LABEL = { accept: t('term.optAccept'), accept_all: t('term.optAcceptAll'), reject: t('term.optReject') };

  /* ---- ブラウザのタブアイコン(favicon)をClaude状態で色分け ----
     裏タブでも気づけるよう、全ターミナルの状態を集約してアスタリスク章を色付けする。
     確認待ち(confirm)=赤 > 入力待ち(idle=プロンプト待ち)=青 > それ以外(作業中/不明)=既定(オレンジ)。 */
  const FAV_DEFAULT = '#D97757'; // 既定(作業中/不明/端末なし)
  const FAV_IDLE = '#4c8dff';    // プロンプト待ち=青 (--accent)
  const FAV_CONFIRM = '#e5534b'; // 確認待ち=赤 (--red)
  function faviconSvg(color) {
    return 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">`
      + `<rect width="100" height="100" rx="22" fill="#F0EEE6"/>`
      + `<g stroke="${color}" stroke-width="7" stroke-linecap="round">`
      + `<line x1="18" y1="50" x2="82" y2="50"/><line x1="22.3" y1="34" x2="77.7" y2="66"/>`
      + `<line x1="34" y1="22.3" x2="66" y2="77.7"/><line x1="50" y1="18" x2="50" y2="82"/>`
      + `<line x1="66" y1="22.3" x2="34" y2="77.7"/><line x1="77.7" y1="34" x2="22.3" y2="66"/></g>`
      + `<circle cx="50" cy="50" r="6" fill="${color}"/></svg>`);
  }
  let curFavColor = null;
  function updateFavicon(list) {
    let color = FAV_DEFAULT;
    if (list.some((it) => it.state === 'confirm')) color = FAV_CONFIRM;
    else if (list.some((it) => it.state === 'idle')) color = FAV_IDLE;
    if (color === curFavColor) return; // 変化時のみ差し替え(点滅防止)
    curFavColor = color;
    document.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = faviconSvg(color);
    document.head.appendChild(link);
  }

  function renderConfirm(list) {
    list.forEach((item) => {
      // タブの●をClaude状態で色分け(入力待ち=青/作業中=グレー/確認待ち=赤/不明=グレー)、確認情報を保持
      const tab = tabs.find((t) => t.sid === item.sid);
      if (tab) {
        const st = (item.state === 'idle' || item.state === 'running' || item.state === 'confirm') ? item.state : 'unknown';
        tab.dotEl.className = 'dot st-' + st;
        tab.tabBtn.classList.toggle('confirm', item.state === 'confirm');
        tab.confirmItem = item.state === 'confirm' ? item : null;
        // 確認待ち(confirm)に変わった瞬間: WAV音(即時)。確認メニューは安定しているのでデバウンス不要。
        if (tab.prevState !== undefined && st === 'confirm' && tab.prevState !== 'confirm') playPon();

        // 作業終了(idle)の「ポンッ!」音は誤爆を防ぐためデバウンスする:
        //  - idle が3ポーリング連続(約4.5秒)安定してから鳴らす。作業の「息継ぎ」の一瞬の
        //    idle誤判定では鳴らさない(本当に完了すればidleが続くので少し遅れて鳴るだけ)。
        //  - 直前に非idle(作業中/確認等)を観測している場合のみ(ページ読込直後の即鳴りを防ぐ)
        //  - 一度鳴らしたら、次に作業を始める(非idleを観測する)まで再鳴動しない
        if (st === 'idle') {
          tab.idleStreak = (tab.idleStreak || 0) + 1;
          if (tab.idleStreak >= 3 && tab.armPop) { playPop(); tab.armPop = false; }
        } else {
          tab.idleStreak = 0;
          if (tab.prevState !== undefined) tab.armPop = true; // 作業中→次のidle安定でポンを許可
        }
        tab.prevState = st;
      }
    });

    // 確認が解消/対象タブが消えたら、開いているプルダウンを閉じる
    if (tabMenuSid) {
      const t = tabs.find((x) => x.sid === tabMenuSid);
      if (!t || !t.confirmItem) closeTabMenu();
    }

    updateFavicon(list); // ブラウザのタブアイコンを状態で色分け
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
      // freeform(本文のA/B選択): 見出しは英字、ラベルは本文そのまま、送信は ans<英字>。
      // TUI連番メニュー: 見出しは番号、ラベルは種別の定型語(はい/中止など)、送信は番号。
      const head = o.letter ? o.letter : o.n;
      const dkey = o.letter ? ('ans' + o.letter) : o.n;
      const label = o.letter ? escHtml(o.text) : (OPT_LABEL[o.kind] || escHtml(o.text));
      return `<button class="tm-opt ${o.kind}" data-sid="${escHtml(tab.sid)}" data-key="${dkey}"><b>${head}.</b> ${label}</button>`;
    }).join('');
    tabMenu.innerHTML = q + opts;
    tabMenu.hidden = false;
    const r = tab.tabBtn.getBoundingClientRect();
    tabMenu.style.left = Math.round(Math.min(r.left, window.innerWidth - tabMenu.offsetWidth - 8)) + 'px';
    tabMenu.style.top = Math.round(r.bottom + 2) + 'px';
    tabMenu.querySelectorAll('.tm-opt').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const raw = b.dataset.key;
        const key = /^ans/.test(raw) ? raw : Number(raw); // freeformは文字列キー、連番は数値
        await api('/api/term/send', { sid: b.dataset.sid, key });
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

  /* ---- Claude 使用量ウィジェット (60秒ポーリング) ---- */
  const usageEl = document.getElementById('usage-widget');
  function fmtReset(epoch) {
    if (!epoch) return '?';
    const d = new Date(epoch * 1000), now = new Date();
    const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    return d.toDateString() === now.toDateString() ? hm
      : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  function usageRow(label, w, now) {
    if (!w) return '';
    const reset = (w.resets_at && w.resets_at < now); // 更新時刻を過ぎている
    const pct = reset ? 0 : Math.min(100, Math.round(w.used_percentage ?? 0));
    const lv = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
    return `<span class="uw-item" title="${t('term.usageTitle', { label, reset: fmtReset(w.resets_at) })}">
      <span class="uw-label">${label}</span>
      <span class="uw-bar"><i class="${lv}" style="width:${pct}%"></i></span>
      <span class="uw-pct">${pct}%</span>
      <span class="uw-reset">→${fmtReset(w.resets_at)}</span></span>`;
  }
  async function pollUsage() {
    try {
      const { usage, now } = await api('/api/usage');
      if (!usage || !usage.rate_limits) { usageEl.hidden = true; return; }
      const rl = usage.rate_limits;
      usageEl.innerHTML = usageRow('5h', rl.five_hour, now) + usageRow(t('term.usageWeek'), rl.seven_day, now);
      usageEl.hidden = !usageEl.innerHTML;
      const ageMin = Math.floor((now - (usage.collected_at || 0)) / 60);
      usageEl.classList.toggle('stale', ageMin > 30); // 30分以上更新なし=グレー表示
      const ago = ageMin < 1 ? t('term.justNow') : t('term.minAgo', { n: ageMin });
      usageEl.title = t('term.usageUpdated', { ago });
    } catch { /* 次回リトライ */ }
  }
  setInterval(() => { if (!document.hidden) pollUsage(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollUsage(); });
  pollUsage();

  poll(); // 初回同期
})();
