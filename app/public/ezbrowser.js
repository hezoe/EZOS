/* EZbrowser: ファイルエクスプローラのモード。端末・エディタと3状態サイクルで切替。
   3ビュー(#terminals / #ez-browser / #ez-editor)は同時に存在し、表示だけを付け替える。
   エディタ本体は ezeditor.js(window.EZEditor)に分離。ここはホストとして接続するのみ。
   全FS操作は /home/debian 配下に限定(サーバの safePath が保証)。 */
'use strict';
(() => {
  if (!window.EZ || !window.EZ.authed) return;
  const isMobile = window.EZ.view === 'mobile';

  const browserEl = document.getElementById('ez-browser');
  const editorEl = document.getElementById('ez-editor');
  const termMain = document.getElementById('term-main');
  const cycleBtn = document.getElementById('mode-cycle');
  if (!browserEl || !editorEl || !cycleBtn) return;

  console.info('[EZOS] ezbrowser.js build: mode-cycle+explorer, rename, terminal-menu, editor-extracted(2026-07-05e)');

  /* ---------- fetch ヘルパー(term.js とは別IIFEなので自前) ---------- */
  async function fapi(path, opts = {}) {
    const o = Object.assign({}, opts);
    o.headers = Object.assign({ 'X-Requested-With': 'ezos' }, opts.headers || {});
    const res = await fetch(path, o);
    if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
    return res;
  }
  async function fjson(path, data) {
    const opts = data !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      : {};
    const res = await fapi(path, opts);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  }

  /* ---------- 小物 ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const join = (dir, name) => (dir.endsWith('/') ? dir + name : dir + '/' + name);
  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + 'M';
    return (n / 1073741824).toFixed(1) + 'G';
  }
  function fmtDate(ms) {
    const d = new Date(ms); const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function modeStr(m) {
    const r = (b, ch) => ((m & b) ? ch : '-');
    return r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(0o4, 'r') + r(0o2, 'w') + r(0o1, 'x');
  }
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  function isImage(e) {
    if (e.type !== 'file') return false;
    return IMG_EXT.includes((e.name.split('.').pop() || '').toLowerCase());
  }
  function iconFor(e) {
    if (e.type === 'updir') return '⬆️';
    if (e.type === 'dir') return '📁';
    if (e.isSymlink) return '🔗';
    if (isImage(e)) return '🖼️';
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    if (['zip', 'gz', 'tar', 'tgz', 'xz', '7z'].includes(ext)) return '🗜️';
    return '📄';
  }
  // 画像プレビュー用の <img> マークアップ(読み込み失敗時は JS で 🖼️ にフォールバック)。
  function thumbHtml(e) {
    const src = '/api/fs/raw?dir=' + encodeURIComponent(state.cwd) + '&name=' + encodeURIComponent(e.name);
    return `<img class="ezb-thumb" src="${esc(src)}" alt="" loading="lazy" decoding="async" draggable="false">`;
  }
  // クリップボードへコピー(Clipboard API優先、失敗時は textarea+execCommand フォールバック)
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); }
    else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    } catch { /* noop */ }
  }
  let toastEl = null;
  function flash(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'ezb-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  /* ---------- モード(3状態サイクル) ---------- */
  const ROOT = '/home/debian';
  let mode = 'terminal';        // 'terminal' | 'browser' | 'editor'
  let editorOpen = false;       // エディタ表示中か(EZEditorの onShow/onHide で更新)
  let editor = null;            // EZEditor インスタンス(ezeditor.js)
  let loaded = false;
  const ICONS = {
    terminal: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/><line x1="6.3" y1="6.3" x2="17.7" y2="17.7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="17.7" y1="6.3" x2="6.3" y2="17.7"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/></svg>',
    browser: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    editor: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><line x1="8.5" y1="13" x2="15" y2="13"/><line x1="8.5" y1="16" x2="15" y2="16"/></svg>',
  };
  // アプリ全体=EZOS。各モード名(アイコンのツールチップに表示)
  const MODE_NAME = { terminal: 'EZterminal', browser: 'EZbrowser', editor: 'EZeditor' };
  function modeOrder() { return editorOpen ? ['terminal', 'browser', 'editor'] : ['terminal', 'browser']; }
  function cycle() { const o = modeOrder(); setMode(o[(o.indexOf(mode) + 1) % o.length]); }
  function setMode(m) {
    if (m === 'editor' && !editorOpen) m = 'browser';
    mode = m;
    document.body.dataset.mode = m;
    cycleBtn.innerHTML = ICONS[m];
    const next = modeOrder(); const nm = next[(next.indexOf(m) + 1) % next.length];
    cycleBtn.title = `${MODE_NAME[m]}（クリックで${MODE_NAME[nm]}へ）`;
    closeDropdown(); closeContext();
    if (m === 'terminal' && window.EZ.fitActive) setTimeout(window.EZ.fitActive, 0);
    if (m === 'browser' && !loaded) load(state.cwd);
  }
  window.EZ.setMode = setMode;
  cycleBtn.addEventListener('click', cycle);

  /* ---------- 状態 ---------- */
  const state = {
    cwd: localStorage.getItem('ez_cwd') || '/home/debian/workspace',
    entries: [], parent: null,
    sel: new Set(), anchor: null,
    view: localStorage.getItem('ez_view') || (isMobile ? 'list' : 'detail'),
    hidden: false,
  };

  /* ---------- ドロップダウン / コンテキストメニュー ---------- */
  let curDropdown = null, curDropdownBtn = null, curContext = null;
  function closeDropdown() { if (curDropdown) { curDropdown.remove(); curDropdown = null; curDropdownBtn = null; } }
  function closeContext() { if (curContext) { curContext.remove(); curContext = null; } }
  function openDropdownFor(btn, items) {
    if (curDropdownBtn === btn) { closeDropdown(); return; }
    closeDropdown();
    const dd = document.createElement('div'); dd.className = 'ezb-dropdown';
    for (const it of items) {
      if (it[0] === '—') { const s = document.createElement('div'); s.className = 'ezb-sep'; dd.appendChild(s); continue; }
      const b = document.createElement('button'); b.textContent = it[0]; if (it[2]) b.disabled = true;
      b.addEventListener('click', () => { closeDropdown(); it[1](); });
      dd.appendChild(b);
    }
    const r = btn.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.top = (r.bottom + 2) + 'px';
    document.body.appendChild(dd); curDropdown = dd; curDropdownBtn = btn;
  }
  function menuButton(label, items) {
    const b = document.createElement('button'); b.className = 'ezb-menu-btn'; b.textContent = label;
    b.addEventListener('click', () => openDropdownFor(b, typeof items === 'function' ? items() : items));
    return b;
  }
  document.addEventListener('mousedown', (e) => {
    if (curDropdown && !curDropdown.contains(e.target) && !e.target.classList.contains('ezb-menu-btn')) closeDropdown();
    if (curContext && !curContext.contains(e.target)) closeContext();
  });
  function showContext(x, y) {
    closeContext();
    const names = [...state.sel];
    const menu = document.createElement('div'); menu.className = 'ezb-context';
    const add = (label, fn, disabled) => {
      const b = document.createElement('button'); b.textContent = label; if (disabled) b.disabled = true;
      b.addEventListener('click', () => { closeContext(); fn(); }); menu.appendChild(b);
    };
    add('名前の変更 / 権限', () => { const e = state.entries.find((x) => x.name === names[0]); if (e) renameDialog(e); }, names.length !== 1);
    add('パスをコピー', doCopyPath, !names.length);
    add('ダウンロード', doDownload, !names.length);
    add('削除', doDelete, !names.length);
    menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 140) + 'px';
    document.body.appendChild(menu); curContext = menu;
  }

  /* ---------- モーダル ---------- */
  function modal(title, bodyEl, onOk) {
    const ov = document.createElement('div'); ov.className = 'ezb-modal-ov';
    const box = document.createElement('div'); box.className = 'ezb-modal';
    const h = document.createElement('div'); h.className = 'ezb-modal-t'; h.textContent = title;
    const foot = document.createElement('div'); foot.className = 'ezb-modal-foot';
    const cancel = document.createElement('button'); cancel.textContent = 'キャンセル';
    const ok = document.createElement('button'); ok.textContent = 'OK'; ok.className = 'ezb-ok';
    const close = () => ov.remove();
    cancel.addEventListener('click', close);
    ok.addEventListener('click', async () => { try { await onOk(); close(); } catch (e) { alert(e.message); } });
    foot.append(cancel, ok);
    box.append(h, bodyEl, foot); ov.appendChild(box);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    return close;
  }
  // 3択の確認ダイアログ(EZeditor がタブを閉じる際に使用)。'save'|'discard'|'cancel' を返す。
  function confirmClose(name) {
    return new Promise((resolve) => {
      const ov = document.createElement('div'); ov.className = 'ezb-modal-ov';
      const box = document.createElement('div'); box.className = 'ezb-modal';
      const h = document.createElement('div'); h.className = 'ezb-modal-t'; h.textContent = '未保存の変更';
      const msg = document.createElement('div'); msg.className = 'ezb-modal-msg';
      msg.textContent = `「${name}」には未保存の変更があります。保存しますか?`;
      const foot = document.createElement('div'); foot.className = 'ezb-modal-foot';
      const mk = (label, val, cls) => {
        const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls;
        b.addEventListener('click', () => { ov.remove(); resolve(val); });
        return b;
      };
      foot.append(mk('キャンセル', 'cancel'), mk('保存せず閉じる', 'discard'), mk('保存して閉じる', 'save', 'ezb-ok'));
      box.append(h, msg, foot); ov.appendChild(box);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) { ov.remove(); resolve('cancel'); } });
      document.body.appendChild(ov);
    });
  }
  function buildPermGrid(mode0) {
    const bits = { ur: 0o400, uw: 0o200, ux: 0o100, gr: 0o40, gw: 0o20, gx: 0o10, or: 0o4, ow: 0o2, ox: 0o1 };
    const el = document.createElement('table'); el.className = 'ezb-perm';
    const head = document.createElement('tr'); head.innerHTML = '<th></th><th>読 r</th><th>書 w</th><th>実行 x</th>'; el.appendChild(head);
    const rows = [['所有者', 'u'], ['グループ', 'g'], ['その他', 'o']];
    const boxes = {};
    for (const [label, who] of rows) {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = label; tr.appendChild(td0);
      for (const perm of ['r', 'w', 'x']) {
        const td = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox';
        const key = who + perm; cb.checked = !!(mode0 & bits[key]); boxes[key] = cb; td.appendChild(cb); tr.appendChild(td);
      }
      el.appendChild(tr);
    }
    return { el, getMode() { let m = 0; for (const k in bits) if (boxes[k].checked) m |= bits[k]; return m; } };
  }
  function renameDialog(entry) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label'); lbl.className = 'ezb-lbl'; lbl.textContent = '名前';
    const input = document.createElement('input'); input.type = 'text'; input.className = 'ezb-input'; input.value = entry.name;
    const grid = buildPermGrid(entry.mode);
    wrap.append(lbl, input, grid.el);
    modal('名前の変更 / 権限', wrap, async () => {
      const newName = input.value.trim();
      if (!newName) throw new Error('名前を入力してください');
      await fjson('/api/fs/rename', { dir: state.cwd, name: entry.name, newName, mode: grid.getMode() });
      await load(state.cwd); flash('変更しました');
    });
    setTimeout(() => input.focus(), 0);
  }

  /* ---------- ブラウザUI構築 ---------- */
  let crumbsEl, menubarEl, listEl, uploadInput;
  function buildBrowser() {
    browserEl.innerHTML = '<div class="ezb-crumbs"></div><div class="ezb-menubar"></div><div class="ezb-list"></div>';
    crumbsEl = browserEl.querySelector('.ezb-crumbs');
    menubarEl = browserEl.querySelector('.ezb-menubar');
    listEl = browserEl.querySelector('.ezb-list');
    uploadInput = document.createElement('input'); uploadInput.type = 'file'; uploadInput.multiple = true; uploadInput.style.display = 'none';
    uploadInput.addEventListener('change', async () => {
      try { await uploadTo(state.cwd, uploadInput.files); await load(state.cwd); flash('アップロード完了'); }
      catch (e) { alert(e.message); }
      uploadInput.value = '';
    });
    browserEl.appendChild(uploadInput);
    buildMenubar();
    bindListEvents();
    bindDnD();
  }

  /* ---------- ドラッグ&ドロップ(デスクトップ / ファイルエクスプローラ風) ---------- */
  function bindDnD() {
    if (isMobile) return;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    let overDepth = 0, dropDir = null;
    const setDropDir = (el) => {
      if (dropDir === el) return;
      if (dropDir) dropDir.classList.remove('ezb-drop-into');
      dropDir = el; if (dropDir) dropDir.classList.add('ezb-drop-into');
    };
    const clearDrop = () => { overDepth = 0; browserEl.classList.remove('ezb-drop'); setDropDir(null); };

    // (A) OSからファイルをドロップ → 現在フォルダ(またはドロップ先フォルダ)へアップロード
    browserEl.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); overDepth += 1; browserEl.classList.add('ezb-drop');
    });
    browserEl.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      const item = e.target.closest && e.target.closest('.ezb-item');
      setDropDir(item && !item.classList.contains('ezb-up') && item.dataset.type === 'dir' ? item : null);
    });
    browserEl.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      overDepth -= 1; if (overDepth <= 0) clearDrop();
    });
    browserEl.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const target = dropDir ? join(state.cwd, dropDir.dataset.name) : state.cwd;
      const label = dropDir ? dropDir.dataset.name : null;
      clearDrop();
      const files = e.dataTransfer.files;
      if (!files || !files.length) return;
      try {
        await uploadTo(target, files);
        if (target === state.cwd) await load(state.cwd);
        flash(`${files.length}件をアップロード` + (label ? `（→ ${label}）` : ''));
      } catch (err) { alert(err.message); }
    });

    // (B) 一覧のファイルをOSへドラッグ → ダウンロード(Chromium系の DownloadURL)
    listEl.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.ezb-item');
      if (!item || item.classList.contains('ezb-up')) return;
      const name = item.dataset.name;
      const entry = state.entries.find((x) => x.name === name);
      if (!entry || entry.type !== 'file') { e.preventDefault(); return; } // フォルダはドラッグDL非対応
      if (!state.sel.has(name)) { state.sel = new Set([name]); state.anchor = selectableIndex(name); applySelection(); }
      const url = location.origin + '/api/fs/download?dir=' + encodeURIComponent(state.cwd) + '&name=' + encodeURIComponent(name);
      try { e.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:${url}`); } catch { /* 非対応ブラウザ */ }
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  function buildMenubar() {
    menubarEl.innerHTML = '';
    menubarEl.appendChild(menuButton('ファイル', () => ([
      ['新規フォルダ', doMkdir],
      ['新規テキスト', doCreateText],
      ['ダウンロード', doDownload, !state.sel.size],
      ['アップロード', doUpload],
    ])));
    menubarEl.appendChild(menuButton('編集', () => ([
      ['編集', doEditSelected, state.sel.size !== 1],
      ['削除', doDelete, !state.sel.size],
    ])));
    menubarEl.appendChild(menuButton('表示', () => ([
      ['アイコン表示', () => setView('icon')],
      ['リスト表示', () => setView('list')],
      ['詳細表示', () => setView('detail')],
      ['—'],
      ['隠しファイル: ' + (state.hidden ? 'ON' : 'OFF'), toggleHidden],
    ])));
    menubarEl.appendChild(menuButton('ターミナル', () => ([
      ['CLI', () => openTerminal('cli')],
      ['Claude', () => openTerminal('claude')],
    ])));
  }

  /* ---------- 一覧描画 ---------- */
  function renderCrumbs() {
    crumbsEl.innerHTML = '';
    const rel = state.cwd.startsWith(ROOT) ? state.cwd.slice(ROOT.length) : '';
    const parts = rel.split('/').filter(Boolean);
    const mk = (label, full) => { const b = document.createElement('button'); b.className = 'ezb-crumb'; b.textContent = label; b.addEventListener('click', () => load(full)); return b; };
    crumbsEl.appendChild(mk('🏠 debian', ROOT));
    let acc = ROOT;
    for (const part of parts) { acc += '/' + part; crumbsEl.appendChild(document.createTextNode('/')); crumbsEl.appendChild(mk(part, acc)); }
  }
  function itemInner(e) {
    const ic = isImage(e) ? thumbHtml(e) : iconFor(e); const nm = esc(e.name);
    if (e.type === 'updir') {
      return `<span class="ezb-ic">${ic}</span><span class="ezb-nm">.. (上へ)</span>` + (state.view === 'detail' ? '<span></span><span></span><span></span>' : '');
    }
    if (state.view === 'detail') {
      return `<span class="ezb-ic">${ic}</span><span class="ezb-nm">${nm}</span>`
        + `<span class="ezb-sz">${e.type === 'dir' ? '' : fmtSize(e.size)}</span>`
        + `<span class="ezb-dt">${fmtDate(e.mtime)}</span><span class="ezb-md">${modeStr(e.mode)}</span>`;
    }
    return `<span class="ezb-ic">${ic}</span><span class="ezb-nm">${nm}</span>`;
  }
  function renderList() {
    listEl.dataset.view = state.view;
    listEl.innerHTML = '';
    if (state.view === 'detail') {
      const head = document.createElement('div'); head.className = 'ezb-head';
      head.innerHTML = '<span></span><span>名前</span><span>サイズ</span><span>更新</span><span>権限</span>';
      listEl.appendChild(head);
    }
    if (state.parent) {
      const up = document.createElement('div'); up.className = 'ezb-item ezb-up'; up.innerHTML = itemInner({ name: '..', type: 'updir' });
      listEl.appendChild(up);
    }
    for (const e of state.entries) {
      const el = document.createElement('div'); el.className = 'ezb-item'; el.dataset.name = e.name; el.dataset.type = e.type;
      if (!isMobile && e.type === 'file') el.draggable = true; // OSへドラッグ→ダウンロード
      el.innerHTML = itemInner(e);
      if (isImage(e)) {
        const img = el.querySelector('.ezb-thumb');
        if (img) img.addEventListener('error', () => { img.parentElement.textContent = '🖼️'; }, { once: true });
      }
      listEl.appendChild(el);
    }
    applySelection();
  }
  function applySelection() {
    for (const el of listEl.querySelectorAll('.ezb-item')) {
      if (el.classList.contains('ezb-up')) continue;
      el.classList.toggle('selected', state.sel.has(el.dataset.name));
    }
  }

  /* ---------- ナビゲーション / 選択 / 起動 ---------- */
  async function load(dir) {
    try {
      const j = await fjson('/api/fs/list?path=' + encodeURIComponent(dir) + '&hidden=' + (state.hidden ? 1 : 0));
      state.cwd = j.path; state.parent = j.parent; state.entries = j.entries;
      state.sel.clear(); state.anchor = null; loaded = true;
      localStorage.setItem('ez_cwd', j.path);
      renderCrumbs(); renderList();
    } catch (e) {
      if (dir !== '/home/debian/workspace') { load('/home/debian/workspace'); }
      else alert('一覧の取得に失敗: ' + e.message);
    }
  }
  function navUp() { if (state.parent) load(state.parent); }
  function selectableIndex(name) { return state.entries.findIndex((x) => x.name === name); }
  function selectRange(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    state.sel = new Set();
    for (let i = lo; i <= hi; i++) if (state.entries[i]) state.sel.add(state.entries[i].name);
  }
  function activate(item) {
    if (item.classList.contains('ezb-up')) { navUp(); return; }
    const e = state.entries.find((x) => x.name === item.dataset.name);
    if (!e) return;
    if (e.type === 'dir') load(join(state.cwd, e.name));
    else openFile(e);
  }
  function openFile(e) {
    if (e.editable) openInEditor(e);
    else if (confirm(`「${e.name}」はテキストではありません。ダウンロードしますか?`)) downloadSingle(e.name);
  }

  function bindListEvents() {
    if (!isMobile) {
      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.ezb-item'); if (!item) return;
        if (item.classList.contains('ezb-up')) { navUp(); return; }
        const name = item.dataset.name; const idx = selectableIndex(name);
        if (e.ctrlKey || e.metaKey) { if (state.sel.has(name)) state.sel.delete(name); else state.sel.add(name); state.anchor = idx; }
        else if (e.shiftKey && state.anchor != null) { selectRange(state.anchor, idx); }
        else { state.sel = new Set([name]); state.anchor = idx; }
        applySelection();
      });
      listEl.addEventListener('dblclick', (e) => { const item = e.target.closest('.ezb-item'); if (item) activate(item); });
      listEl.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.ezb-item'); if (!item || item.classList.contains('ezb-up')) return;
        e.preventDefault();
        if (!state.sel.has(item.dataset.name)) { state.sel = new Set([item.dataset.name]); applySelection(); }
        showContext(e.clientX, e.clientY);
      });
      return;
    }
    // モバイル: タップ=選択 / ダブルタップ=起動 / 長タップ=コンテキスト
    let tStart = null, longTimer = null, longFired = false, lastName = null, lastTime = 0;
    listEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const item = e.target.closest('.ezb-item'); if (!item) return;
      tStart = { el: item, x: e.touches[0].clientX, y: e.touches[0].clientY }; longFired = false;
      longTimer = setTimeout(() => {
        longFired = true;
        if (item.classList.contains('ezb-up')) return;
        if (!state.sel.has(item.dataset.name)) { state.sel = new Set([item.dataset.name]); applySelection(); }
        const r = item.getBoundingClientRect(); showContext(r.left + 24, r.top + 24);
      }, 500);
    }, { passive: true });
    listEl.addEventListener('touchmove', (e) => {
      if (!tStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - tStart.x) > 10 || Math.abs(t.clientY - tStart.y) > 10) { clearTimeout(longTimer); tStart = null; }
    }, { passive: true });
    listEl.addEventListener('touchend', (e) => {
      clearTimeout(longTimer);
      if (!tStart) return;
      const item = tStart.el; const name = item.dataset.name; tStart = null;
      if (longFired) { e.preventDefault(); return; }
      const now = Date.now();
      if (lastName === name && now - lastTime < 300) { lastName = null; e.preventDefault(); activate(item); return; }
      lastName = name; lastTime = now;
      if (item.classList.contains('ezb-up')) { navUp(); return; }
      if (state.sel.has(name)) state.sel.delete(name); else state.sel.add(name);
      applySelection();
    }, { passive: false });
  }

  /* ---------- メニュー動作 ---------- */
  function setView(v) { state.view = v; localStorage.setItem('ez_view', v); buildMenubar(); renderList(); }
  function toggleHidden() { state.hidden = !state.hidden; buildMenubar(); load(state.cwd); }
  function doUpload() { uploadInput.click(); }
  // 現在フォルダで新規ターミナルをEZterminalに追加し、そこへ移動する(CLI or Claude)
  async function openTerminal(kind) {
    try {
      const base = state.cwd.split('/').pop() || 'term';
      const title = kind === 'claude' ? `Claude:${base}` : base;
      const j = await fjson('/api/term/add', { dir: state.cwd, kind, title });
      const sid = j.terminal && j.terminal.sid;
      if (sid && window.EZ.gotoTerminal) { setMode('terminal'); await window.EZ.gotoTerminal(sid); }
      else if (!window.EZ.gotoTerminal) alert('端末機能が読み込まれていません');
    } catch (e) { alert(e.message); }
  }
  async function doMkdir() { try { await fjson('/api/fs/mkdir', { dir: state.cwd }); await load(state.cwd); flash('フォルダを作成'); } catch (e) { alert(e.message); } }
  async function doCreateText() {
    try { const j = await fjson('/api/fs/create', { dir: state.cwd }); await load(state.cwd); openInEditor({ name: j.name, type: 'file', editable: true }); }
    catch (e) { alert(e.message); }
  }
  function doEditSelected() {
    const names = [...state.sel];
    if (names.length !== 1) { alert('編集するファイルを1つ選択してください'); return; }
    const e = state.entries.find((x) => x.name === names[0]);
    if (!e || e.type === 'dir') { alert('ファイルを選択してください'); return; }
    openFile(e);
  }
  function doDelete() {
    const names = [...state.sel];
    if (!names.length) { alert('削除対象を選択してください'); return; }
    if (!confirm(`${names.length}件を削除します(フォルダは中身ごと)。よろしいですか?\n\n` + names.join('\n'))) return;
    fjson('/api/fs/delete', { dir: state.cwd, names }).then(() => { load(state.cwd); flash('削除しました'); }).catch((e) => alert(e.message));
  }
  function doCopyPath() {
    const names = [...state.sel];
    if (!names.length) { alert('対象を選択してください'); return; }
    const paths = names.map((n) => join(state.cwd, n)).join('\n');
    copyText(paths);
    flash(names.length === 1 ? 'パスをコピーしました' : `${names.length}件のパスをコピーしました`);
  }
  function doDownload() {
    const names = [...state.sel];
    if (!names.length) { alert('ダウンロード対象を選択してください'); return; }
    if (names.length === 1) {
      const e = state.entries.find((x) => x.name === names[0]);
      if (e && e.type === 'file') { downloadSingle(names[0]); return; }
    }
    downloadArchive(names).catch((e) => alert(e.message));
  }
  function downloadSingle(name) {
    const a = document.createElement('a');
    a.href = '/api/fs/download?dir=' + encodeURIComponent(state.cwd) + '&name=' + encodeURIComponent(name);
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function downloadArchive(names) {
    const res = await fapi('/api/fs/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: state.cwd, names }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'アーカイブ失敗'); }
    const blob = await res.blob();
    let fn = 'download.tar.gz';
    const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '');
    if (m) { try { fn = decodeURIComponent(m[1]); } catch { /* noop */ } }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fn; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function uploadTo(dir, fileList) {
    for (const file of fileList) {
      const q = '/api/upload?dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(file.name || 'file');
      const res = await fapi(q, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + res.status)); }
    }
  }

  /* ---------- エディタ ---------- */
  // 実体は ezeditor.js(window.EZEditor)に分離。ここはホストとしての接続のみ。
  function buildEditor() {
    if (!window.EZEditor) { console.warn('[EZOS] EZEditor 未読込'); return; }
    editor = window.EZEditor.create({
      mountEl: editorEl,
      menuButton, flash, fjson, join, confirmClose,
      getCwd: () => state.cwd,
      reloadBrowser: () => { if (loaded) load(state.cwd); },
      onShow: () => { editorOpen = true; setMode('editor'); },
      onHide: () => { editorOpen = false; setMode('browser'); },
      // 復元時: モードは切り替えずにエディタを「選べる」状態にするだけ(現在の表示は保つ)。
      // これで別デバイスの開き状態を引き継いでも、いきなりエディタ画面に飛ばされない。
      setEditorAvailable: (avail) => {
        editorOpen = avail;
        const next = modeOrder(); const nm = next[(next.indexOf(mode) + 1) % next.length];
        cycleBtn.title = `${MODE_NAME[mode]}（クリックで${MODE_NAME[nm]}へ）`;
      },
    });
  }
  function openInEditor(e) { if (editor) editor.open(e); }
  // 絶対パスでEZeditorに開く(ターミナル上のファイルクリックから呼ばれる)
  window.EZ.openFileInEditor = (path) => { if (editor && path) editor.openPath(path); };

  /* ---------- 初期化 ---------- */
  browserEl.removeAttribute('hidden'); editorEl.removeAttribute('hidden');
  termMain.classList.add('ez-ready');
  buildBrowser(); buildEditor();
  setMode('terminal');
})();
