/* EZeditor: テキストエディタのモード。EZbrowser から切り離した独立モジュール。
   DOM(#ez-editor)への描画・編集・保存・シンタックスハイライトを自己完結で持つ。
   ホスト(EZbrowser)とは EZEditor.create(ctx) の ctx 経由でのみやり取りする:
     ctx.mountEl        描画先の要素(#ez-editor)
     ctx.menuButton     ドロップダウン付きメニューボタン生成(ホストの共通UI)
     ctx.flash(msg)     トースト表示
     ctx.fjson(path,d)  JSON fetch ヘルパー
     ctx.join(dir,name) パス連結
     ctx.getCwd()       現在のフォルダ(別名保存/読込の基準)
     ctx.reloadBrowser()一覧の再読込(新規/別名保存後)
     ctx.onShow()       エディタ表示を要求(モード切替はホストが担当)
     ctx.onHide()       エディタ非表示を要求
   返り値: { open(entry), close(), isDirty() }
   ハイライトは window.EZHL(ezhl.js)を利用する。 */
'use strict';
(() => {
  const HL_MAX = 400 * 1024; // これを超えるファイルはハイライトせず素のまま表示(重さ回避)

  function create(ctx) {
    let edPath = null, edName = null, edDirty = false, edLang = null;
    let edText, edNameEl, edWrap, edHL;

    // ハイライト層を再描画。対応拡張子かつ小さいファイルのみ色分けする。
    function render() {
      if (!edWrap) return;
      const on = edLang && window.EZHL && edText.value.length <= HL_MAX;
      edWrap.classList.toggle('hl-on', !!on);
      if (on) {
        // textareaの末尾改行と高さを合わせるため末尾に改行を足す
        edHL.innerHTML = window.EZHL.highlight(edText.value, edLang) + '\n';
        edHL.scrollTop = edText.scrollTop; edHL.scrollLeft = edText.scrollLeft;
      }
    }

    function build() {
      const el = ctx.mountEl;
      el.innerHTML = '';
      const bar = document.createElement('div'); bar.className = 'eze-bar';
      const menus = document.createElement('div'); menus.className = 'eze-menus';
      menus.appendChild(ctx.menuButton('ファイル', () => ([['保存', saveFile], ['別名で保存', saveAs]])));
      menus.appendChild(ctx.menuButton('編集', () => ([['カット', edCut], ['コピー', edCopy], ['ペースト', edPaste]])));
      edNameEl = document.createElement('span'); edNameEl.className = 'eze-name';
      const closeb = document.createElement('button'); closeb.className = 'eze-close'; closeb.textContent = '✕'; closeb.title = '閉じる';
      closeb.addEventListener('click', close);
      bar.append(menus, edNameEl, closeb);
      // オーバーレイ: 透明テキストの textarea の背後に色付き pre を重ねる
      edWrap = document.createElement('div'); edWrap.className = 'eze-wrap';
      edHL = document.createElement('pre'); edHL.className = 'eze-hl'; edHL.setAttribute('aria-hidden', 'true');
      edText = document.createElement('textarea'); edText.className = 'eze-text'; edText.spellcheck = false;
      edText.addEventListener('input', () => { edDirty = true; render(); });
      edText.addEventListener('scroll', () => { edHL.scrollTop = edText.scrollTop; edHL.scrollLeft = edText.scrollLeft; });
      edText.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
      });
      edWrap.append(edHL, edText);
      el.append(bar, edWrap);
    }

    async function open(entry) {
      try {
        const j = await ctx.fjson('/api/fs/read?path=' + encodeURIComponent(ctx.join(ctx.getCwd(), entry.name)));
        if (edDirty && edPath && !confirm('未保存の変更があります。破棄して開きますか?')) return;
        edPath = j.path; edName = j.name; edText.value = j.content; edDirty = false; edNameEl.textContent = j.name;
        edLang = window.EZHL ? window.EZHL.langFor(j.name) : null; edText.scrollTop = 0; render();
        ctx.onShow(); setTimeout(() => edText.focus(), 0);
      } catch (err) {
        if (err.message === 'binary') alert('バイナリファイルは開けません');
        else alert('開けません: ' + err.message);
      }
    }
    async function saveFile() {
      if (!edPath) return;
      try { await ctx.fjson('/api/fs/write', { path: edPath, content: edText.value }); edDirty = false; ctx.flash('保存しました'); }
      catch (e) { alert('保存失敗: ' + e.message); }
    }
    async function saveAs() {
      const name = prompt('別名で保存 (現在のフォルダに作成):', edName || 'new.txt');
      if (!name) return;
      try {
        const j = await ctx.fjson('/api/fs/create', { dir: ctx.getCwd(), name, content: edText.value });
        edPath = j.path; edName = j.name; edNameEl.textContent = j.name; edDirty = false;
        edLang = window.EZHL ? window.EZHL.langFor(j.name) : null; render();
        ctx.reloadBrowser();
        ctx.flash('保存しました: ' + j.name);
      } catch (e) { alert('保存失敗: ' + e.message); }
    }
    function selText() { return edText.value.substring(edText.selectionStart, edText.selectionEnd); }
    async function edCopy() { const s = selText(); try { await navigator.clipboard.writeText(s); } catch { edText.focus(); document.execCommand('copy'); } }
    async function edCut() { await edCopy(); const a = edText.selectionStart, b = edText.selectionEnd; edText.setRangeText('', a, b, 'end'); edDirty = true; render(); edText.focus(); }
    async function edPaste() {
      try { const t = await navigator.clipboard.readText(); const a = edText.selectionStart, b = edText.selectionEnd; edText.setRangeText(t, a, b, 'end'); edDirty = true; render(); edText.focus(); }
      catch { alert('貼り付けは Ctrl+V を使用してください'); }
    }
    function close() {
      if (edDirty && !confirm('未保存の変更があります。閉じますか?')) return;
      edDirty = false; ctx.onHide();
    }

    build();
    return { open, close, isDirty: () => edDirty };
  }

  console.info('[EZOS] ezeditor.js build: standalone editor module, syntax-highlight(2026-07-05e)');
  window.EZEditor = { create };
})();
