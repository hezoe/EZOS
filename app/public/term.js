/* EZeditor Webターミナル (xterm.js) — 複数タブ + サーバー共有
   タブ構成(ターミナルの数・タイトル・順序)はサーバー(/api/term/*)が正本で、
   全ブラウザ・全デバイスで同一。各タブは tmux セッション ez_<sid> に attach するため、
   複数ブラウザから同じ画面が見える。状態(確認待ち/処理中/完了)も共有。
   localStorageに持つのは「このブラウザでどのタブを見ているか」だけ。 */
'use strict';

(() => {
  console.info('[EZeditor] term.js build: tabs(dynamic+, state-dot, pulldown, touch-scroll-fix, vv-pin, keyrow-reorder+wrap, switch-next-to-esc, ctrl-end, actions-stack-when-wrapped, ctrl-keys-no-focus, mobile-no-brand, wrap-hysteresis, git-buttons-submit, send-after-down, shift-tab, sanitize, file-upload, web-links)(2026-07-05b)'); // 版確認用
  const isMobile = window.EZ.view === 'mobile';
  const ACTIVE_KEY = 'ez_active_sid'; // 閲覧中タブ(このブラウザ限定の表示都合)

  const tabsEl = document.getElementById('term-tabs');
  const btnAddTab = document.getElementById('btn-add-tab');
  const termsEl = document.getElementById('terminals');
  const dot = document.getElementById('conn-state');
  const reconnectBtn = document.getElementById('btn-reconnect');

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
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) { tab.ws.send(JSON.stringify({ t: 'i', d: data })); return; }
    connect(tab); // 未接続なら再接続
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
    if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) { connect(tab); return; }
    const text = tab.inputEl.value;
    // bracketed pasteで内容を挿入(複数行・IME確定済みを安全に)し、Enter(\r)で送出
    if (text.length) tab.ws.send(JSON.stringify({ t: 'i', d: '\x1b[200~' + text + '\x1b[201~' }));
    tab.ws.send(JSON.stringify({ t: 'i', d: '\r' }));
    if (text.trim() && history[history.length - 1] !== text) {
      history.push(text); if (history.length > 300) history.shift();
      try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch { /* noop */ }
    }
    tab.histIndex = history.length; tab.histDraft = '';
    tab.inputEl.value = ''; tab.inputEl.focus();
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
          headers: { 'X-Requested-With': 'ezeditor', 'Content-Type': file.type || 'application/octet-stream' },
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
    tab.inputEl.value = history[tab.histIndex] ?? ''; tab.inputEl.focus();
  }
  function histDown(tab) {
    if (tab.histIndex >= history.length) return;
    tab.histIndex += 1;
    tab.inputEl.value = tab.histIndex === history.length ? tab.histDraft : (history[tab.histIndex] ?? '');
    tab.inputEl.focus();
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
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezeditor' }, body: JSON.stringify(data) }
      : { headers: { 'X-Requested-With': 'ezeditor' } };
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

  /* ---- WebSocket接続 (tmuxセッションへattach) ---- */
  function connect(tab) {
    // 既存接続は必ず閉じてから張り直す (Enter連打などによる多重接続を防ぐ)
    if (tab.ws) {
      try {
        tab.ws.onopen = tab.ws.onmessage = tab.ws.onclose = tab.ws.onerror = null;
        tab.ws.close();
      } catch { /* noop */ }
      tab.ws = null;
    }
    if (tab === active) fitActive();
    const cols = tab.term.cols || 80;
    const rows = tab.term.rows || 24;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    tab.closedByUser = false;
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/term?s=${encodeURIComponent(tab.sid)}&cols=${cols}&rows=${rows}`);
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;

    ws.onopen = () => {
      tab.connected = true;
      updateConn();
      if (tab === active) { fitActive(); (tab.inputOn ? tab.inputEl : tab.term)?.focus(); }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.t === 'exit') tab.term.write(`\r\n\x1b[90m[セッション終了 (code ${m.code})]\x1b[0m\r\n`);
          if (m.t === 'err') tab.term.write(`\r\n\x1b[31m${m.m}\x1b[0m\r\n`);
        } catch { /* noop */ }
      } else {
        tab.term.write(new Uint8Array(ev.data));
      }
    };
    ws.onclose = () => {
      tab.connected = false;
      updateConn();
      if (!tab.closedByUser) {
        // 別デバイスが接続すると(-D)ここがデタッチされ、tmuxが縮小サイズで再描画した
        // 埋め草フレームが残る。resetで消してから復帰案内を出す(古い画面の残骸を見せない)。
        tab.term.reset();
        tab.term.write('\x1b[90m[切断されました — 別のデバイスで開いたか通信が切れました。'
          + '再接続ボタン／Enter／このタブをタップで復帰します]\x1b[0m\r\n');
      }
    };
    ws.onerror = () => { /* onclose が続く */ };
  }

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
    let rec = null, recording = false, baseValue = '', finalAcc = '';
    const startRec = () => {
      rec = new SR();
      rec.lang = 'ja-JP';
      rec.interimResults = true;
      rec.continuous = true;
      baseValue = tab.inputEl.value;
      finalAcc = '';
      rec.onstart = () => { recording = true; btn.classList.add('rec'); btn.textContent = '⏹'; btn.title = '音声入力を停止'; };
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r.isFinal) finalAcc += r[0].transcript; else interim += r[0].transcript;
        }
        const added = finalAcc + interim;
        const sep = baseValue && added && !/\s$/.test(baseValue) ? ' ' : '';
        tab.inputEl.value = baseValue + sep + added;
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
        baseValue = tab.inputEl.value; // 認識確定分を次回の基準に取り込む
        tab.inputEl.focus();
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
      scrollback: 5000,
      theme: TERM_THEME,
      disableStdin: true, // 直接文字入力はロック。入力は各ターミナル一体の入力欄/キー行から(IME安定化)
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
    };

    // このターミナル専用の制御キー行(右端に入力欄ON/OFFスイッチを同居させ省スペース化)
    const keyrow = document.createElement('div');
    keyrow.className = 'tw-keyrow';
    // 制御信号系(^C/^D/^End)は入力欄へフォーカスを移さない(カーソルが飛んで
    // モバイルのキーボードが出るのを防ぐ)。それ以外は従来どおり入力先へフォーカス。
    const NO_FOCUS = new Set(['^C', '^D', '^End']);
    for (const [label, seq] of KEYROW) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        tabSendRaw(tab, seq);
        if (!NO_FOCUS.has(label)) (tab.inputOn ? tab.inputEl : tab.term).focus();
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
        if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) { connect(tab); return; }
        // 入力欄「送信」と同じ方式: ブラケットペーストでコマンドを確定入力し、
        // 独立したEnter(\r)で送信する。これでシェルでもClaudeプロンプトでも実行される
        // (素の \r だとClaudeでは改行扱いになり送信されないことがあるため)。
        tab.ws.send(JSON.stringify({ t: 'i', d: '\x1b[200~' + cmd + '\x1b[201~' }));
        tab.ws.send(JSON.stringify({ t: 'i', d: '\r' }));
      });
      return b;
    };
    keyrow.append(
      mkGit('G↓', 'GitHubからpull (git pull)', GIT_PULL),
      mkGit('G↑', 'コミットしてGitHubへpush (add・commit・push)', GIT_PUSH),
    );

    const swLabel = document.createElement('label');
    swLabel.className = 'tw-switch';
    swLabel.title = 'ON: 入力欄で編集(ターミナル直接入力ロック・IME安定) / OFF: ターミナルに直接入力';
    const swText = document.createElement('span'); swText.className = 'tw-switch-label'; swText.textContent = '入力';
    const switchInput = document.createElement('input'); switchInput.type = 'checkbox';
    const swSlider = document.createElement('span'); swSlider.className = 'tw-slider';
    swLabel.append(swText, switchInput, swSlider);
    keyrow.append(swLabel);
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
    const mkIb = (label, title, cls) => {
      const b = document.createElement('button');
      b.className = 'ib-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.title = title;
      return b;
    };
    const mic = mkIb('🎤', '音声入力', 'mic'); setupMic(tab, mic);
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
    ctrls.append(mic, attach, up, down, send, spacer);
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
