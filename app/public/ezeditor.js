/* EZeditor: 複数ファイルをタブで開けるテキストエディタ。EZbrowser から分離した独立モジュール。
   1つの textarea + ハイライト層を共有し、各タブが content/dirty/lang/scroll/選択位置を保持する。
   ツールバーは上から「ファイルタブ一覧」「ファイルメニュー(ファイル/編集)」の2段。
   タブの✕(またはタブ段右端の✕=現在タブ)で閉じ、未保存時のみ確認を出す。
   ホスト(EZbrowser)とは EZEditor.create(ctx) の ctx 経由でのみやり取りする:
     ctx.mountEl        描画先の要素(#ez-editor)
     ctx.menuButton     ドロップダウン付きメニューボタン生成(ホストの共通UI)
     ctx.flash(msg)     トースト表示
     ctx.fjson(path,d)  JSON fetch ヘルパー
     ctx.join(dir,name) パス連結
     ctx.getCwd()       現在のフォルダ(別名保存/読込の基準)
     ctx.reloadBrowser()一覧の再読込(新規/別名保存後)
     ctx.onShow()       エディタ表示を要求(1つ目のタブを開いた時)
     ctx.onHide()       エディタ非表示を要求(最後のタブを閉じた時)
     ctx.confirmClose(name) -> Promise<'save'|'discard'|'cancel'> 未保存タブを閉じる際の確認
   返り値: { open(entry), hasOpen() }
   ハイライトは window.EZHL(ezhl.js)を利用する。 */
'use strict';
(() => {
  const HL_MAX = 400 * 1024; // これを超えるファイルはハイライトせず素のまま表示(重さ回避)

  function create(ctx) {
    // 各タブ: { id, path, name, content, dirty, lang, scrollTop, selStart, selEnd }
    const tabs = [];
    let activeId = null;
    let seq = 0;
    let edText, edWrap, edHL, tabsEl;

    const active = () => tabs.find((t) => t.id === activeId) || null;
    const langFor = (name) => (window.EZHL ? window.EZHL.langFor(name) : null);

    /* ---------- 描画 ---------- */
    // ハイライト層をアクティブタブの内容で再描画。対応拡張子かつ小さいファイルのみ色分け。
    function render() {
      if (!edWrap) return;
      const t = active();
      const lang = t && t.lang;
      const on = lang && window.EZHL && edText.value.length <= HL_MAX;
      edWrap.classList.toggle('hl-on', !!on);
      if (on) {
        edHL.innerHTML = window.EZHL.highlight(edText.value, lang) + '\n'; // 末尾改行で高さを合わせる
        edHL.scrollTop = edText.scrollTop; edHL.scrollLeft = edText.scrollLeft;
      }
    }
    // タブバーを tabs[] から再構築
    function renderTabs() {
      tabsEl.innerHTML = '';
      for (const t of tabs) {
        const el = document.createElement('div');
        el.className = 'eze-tab' + (t.id === activeId ? ' active' : '') + (t.dirty ? ' dirty' : '');
        const nm = document.createElement('span'); nm.className = 'eze-tab-nm'; nm.textContent = t.name; nm.title = t.path;
        nm.addEventListener('click', () => activate(t.id));
        const x = document.createElement('button'); x.className = 'eze-tab-x'; x.textContent = '✕'; x.title = '閉じる';
        x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
        el.append(nm, x);
        tabsEl.appendChild(el);
      }
    }

    /* ---------- タブ切替 ---------- */
    // textarea の現在状態をアクティブタブへ退避
    function syncActive() {
      const t = active(); if (!t) return;
      t.content = edText.value;
      t.scrollTop = edText.scrollTop;
      t.selStart = edText.selectionStart; t.selEnd = edText.selectionEnd;
    }
    // アクティブタブの内容を textarea へ読み込み(スクロール/選択も復元)
    function loadActive() {
      const t = active();
      edText.value = t ? t.content : '';
      render();
      if (t) {
        edText.scrollTop = t.scrollTop || 0;
        try { edText.setSelectionRange(t.selStart || 0, t.selEnd || 0); } catch { /* noop */ }
        edHL.scrollTop = edText.scrollTop; edHL.scrollLeft = edText.scrollLeft;
      }
    }
    function activate(id) {
      if (id === activeId) { setTimeout(() => edText.focus(), 0); return; }
      syncActive();
      activeId = id;
      loadActive();
      renderTabs();
      setTimeout(() => edText.focus(), 0);
    }

    /* ---------- 開く ---------- */
    // EZbrowser の一覧から: 現在フォルダ + ファイル名で開く
    function open(entry) { return openPath(ctx.join(ctx.getCwd(), entry.name)); }
    // 絶対パス指定で開く(ターミナルのファイルクリック等)
    async function openPath(full) {
      const exist = tabs.find((t) => t.path === full); // 既に開いていれば読み直さずそのタブへ
      if (exist) { ctx.onShow(); activate(exist.id); return; }
      try {
        const j = await ctx.fjson('/api/fs/read?path=' + encodeURIComponent(full));
        const dup = tabs.find((t) => t.path === j.path); // 正規化後のパスでも重複チェック
        if (dup) { ctx.onShow(); activate(dup.id); return; }
        syncActive();
        const tab = { id: ++seq, path: j.path, name: j.name, content: j.content, dirty: false, lang: langFor(j.name), scrollTop: 0, selStart: 0, selEnd: 0 };
        tabs.push(tab);
        activeId = tab.id;
        loadActive();
        renderTabs();
        ctx.onShow();
        setTimeout(() => edText.focus(), 0);
      } catch (err) {
        if (err.message === 'binary') alert('バイナリファイルは開けません');
        else alert('開けません: ' + err.message);
      }
    }

    /* ---------- 保存 ---------- */
    async function saveTab(t) {
      try { await ctx.fjson('/api/fs/write', { path: t.path, content: t.content }); t.dirty = false; return true; }
      catch (e) { alert('保存失敗: ' + e.message); return false; }
    }
    async function saveFile() {
      const t = active(); if (!t) return;
      syncActive();
      if (await saveTab(t)) { ctx.flash('保存しました'); renderTabs(); }
    }
    async function saveAs() {
      const t = active(); if (!t) return;
      const name = prompt('別名で保存 (現在のフォルダに作成):', t.name || 'new.txt');
      if (!name) return;
      syncActive();
      try {
        const j = await ctx.fjson('/api/fs/create', { dir: ctx.getCwd(), name, content: t.content });
        t.path = j.path; t.name = j.name; t.lang = langFor(j.name); t.dirty = false;
        render(); renderTabs();
        ctx.reloadBrowser();
        ctx.flash('保存しました: ' + j.name);
      } catch (e) { alert('保存失敗: ' + e.message); }
    }

    /* ---------- 閉じる ---------- */
    // タブ配列から取り除き、必要なら隣のタブへ移る。空になったらエディタを隠す。
    function removeTab(id) {
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      const wasActive = tabs[i].id === activeId;
      tabs.splice(i, 1);
      if (!tabs.length) { activeId = null; edText.value = ''; render(); renderTabs(); ctx.onHide(); return; }
      if (wasActive) { activeId = tabs[Math.max(0, i - 1)].id; loadActive(); }
      renderTabs();
    }
    async function closeTab(id) {
      const t = tabs.find((x) => x.id === id); if (!t) return;
      if (t.id === activeId) syncActive(); // 最新の編集内容/dirtyを反映
      if (t.dirty) {
        const choice = await ctx.confirmClose(t.name);
        if (choice === 'cancel') return;
        if (choice === 'save' && !(await saveTab(t))) return; // 保存失敗なら閉じない
      }
      removeTab(id);
    }

    /* ---------- 編集メニュー操作 ---------- */
    function selText() { return edText.value.substring(edText.selectionStart, edText.selectionEnd); }
    async function edCopy() { const s = selText(); try { await navigator.clipboard.writeText(s); } catch { edText.focus(); document.execCommand('copy'); } }
    async function edCut() { await edCopy(); const a = edText.selectionStart, b = edText.selectionEnd; edText.setRangeText('', a, b, 'end'); markDirty(); edText.focus(); }
    async function edPaste() {
      try { const t = await navigator.clipboard.readText(); const a = edText.selectionStart, b = edText.selectionEnd; edText.setRangeText(t, a, b, 'end'); markDirty(); edText.focus(); }
      catch { alert('貼り付けは Ctrl+V を使用してください'); }
    }
    // 編集が入った時: アクティブタブを dirty にし(初回のみタブバー更新)、ハイライト再描画
    function markDirty() {
      const t = active(); if (!t) return;
      if (!t.dirty) { t.dirty = true; renderTabs(); }
      render();
    }

    /* ---------- 構築 ---------- */
    function build() {
      const el = ctx.mountEl;
      el.innerHTML = '';
      // 1段目: 開いているファイルのタブ一覧(+現在タブを閉じる✕)
      const tabbar = document.createElement('div'); tabbar.className = 'eze-tabbar';
      tabsEl = document.createElement('div'); tabsEl.className = 'eze-tabs';
      const closeb = document.createElement('button'); closeb.className = 'eze-close'; closeb.textContent = '✕'; closeb.title = '現在のタブを閉じる';
      closeb.addEventListener('click', () => { if (activeId != null) closeTab(activeId); });
      tabbar.append(tabsEl, closeb);
      // 2段目: ファイルメニュー(ファイル / 編集)
      const bar = document.createElement('div'); bar.className = 'eze-bar';
      const menus = document.createElement('div'); menus.className = 'eze-menus';
      menus.appendChild(ctx.menuButton('ファイル', () => ([['保存', saveFile], ['別名で保存', saveAs]])));
      menus.appendChild(ctx.menuButton('編集', () => ([['カット', edCut], ['コピー', edCopy], ['ペースト', edPaste]])));
      bar.appendChild(menus);
      // オーバーレイ: 透明テキストの textarea の背後に色付き pre を重ねる
      edWrap = document.createElement('div'); edWrap.className = 'eze-wrap';
      edHL = document.createElement('pre'); edHL.className = 'eze-hl'; edHL.setAttribute('aria-hidden', 'true');
      edText = document.createElement('textarea'); edText.className = 'eze-text'; edText.spellcheck = false;
      edText.addEventListener('input', markDirty);
      edText.addEventListener('scroll', () => { edHL.scrollTop = edText.scrollTop; edHL.scrollLeft = edText.scrollLeft; });
      edText.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFile(); }
      });
      edWrap.append(edHL, edText);
      el.append(tabbar, bar, edWrap); // 上から: ファイルタブ / ファイルメニュー / 本文
    }

    build();
    return { open, openPath, hasOpen: () => tabs.length > 0 };
  }

  console.info('[EZOS] ezeditor.js build: standalone editor, multi-tab(2段: tabs/menu), syntax-highlight(2026-07-05g)');
  window.EZEditor = { create };
})();
