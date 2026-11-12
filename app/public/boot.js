// R-123 (2026-11-12): CSP を script-src 'self' にするため、サーバーが画面に埋め込む設定は
// 実行されるインラインスクリプトではなく JSON ブロック(<script type="application/json" id="ez-config">)で渡し、
// この外部スクリプトが window.EZ に展開する。他のスクリプトより先に読み込むこと。
(function () {
  var el = document.getElementById('ez-config');
  var cfg = { authed: false, view: '', lang: 'ja', home: '' };
  try { if (el) cfg = JSON.parse(el.textContent); } catch (e) { /* 壊れていれば既定値 */ }
  window.EZ = cfg;
})();
