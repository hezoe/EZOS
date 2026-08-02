/* EZOS ツールチップ(バルーン) — GUI要素にマウスを置くと、その要素の説明を
   現在の言語で表示する。説明文は次の優先順で決める:
     1) data-tip 属性(値は i18n キー or そのままの文言。window.EZ.t で解決)
     2) title 属性(既存の多くは翻訳済み)
   native の title バルーンと二重に出ないよう、表示中は title を退避して外す。
   マウス(hover)可能な環境のみ。キーボードフォーカスでも出す(アクセシビリティ)。 */
'use strict';
(function () {
  var t = function (k) { return (window.EZ && window.EZ.t) ? window.EZ.t(k) : k; };

  // タッチ主体の端末では native の挙動に任せ、独自バルーンは出さない
  var hoverable = true;
  try { hoverable = window.matchMedia('(hover: hover)').matches; } catch (e) { hoverable = true; }

  var tipEl = null;
  var curTarget = null;
  var showTimer = null;

  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'ez-tip';
      tipEl.setAttribute('role', 'tooltip');
      tipEl.hidden = true;
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  // 要素の説明文を得る。data-tip 優先(i18nキーはtで解決)、無ければ title。
  function textFor(el) {
    var dt = el.getAttribute('data-tip');
    if (dt) return t(dt);
    var ti = el.getAttribute('title');
    if (ti) return ti;
    // 退避済み(表示中に外した)title があればそれを使う
    if (el.__ezTitle) return el.__ezTitle;
    return '';
  }

  function place(el) {
    var tip = ensureTip();
    var r = el.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = '0px'; tip.style.top = '0px'; // 一旦置いて実寸を測る
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var margin = 8, gap = 8;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
    var top = r.top - th - gap;           // 既定は上に出す
    tip.classList.remove('below');
    if (top < margin) { top = r.bottom + gap; tip.classList.add('below'); } // 上に入らなければ下へ
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function show(el) {
    var txt = textFor(el);
    if (!txt) return;
    var tip = ensureTip();
    tip.textContent = txt;
    // native title を一時的に外して二重表示を防ぐ
    if (el.hasAttribute('title')) { el.__ezTitle = el.getAttribute('title'); el.removeAttribute('title'); }
    curTarget = el;
    place(el);
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (curTarget && curTarget.__ezTitle != null) {
      // 退避していた title を戻す(表示中に他コードが title を更新していれば触らない)
      if (!curTarget.hasAttribute('title')) curTarget.setAttribute('title', curTarget.__ezTitle);
      curTarget.__ezTitle = null;
    }
    curTarget = null;
    if (tipEl) tipEl.hidden = true;
  }

  function candidate(node) {
    if (!node || !node.closest) return null;
    return node.closest('[data-tip], [title]');
  }

  if (hoverable) {
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType === 'touch') return;
      var el = candidate(e.target);
      if (!el || el === curTarget) return;
      hide();
      showTimer = setTimeout(function () { showTimer = null; show(el); }, 320);
    }, true);
    document.addEventListener('pointerout', function (e) {
      var el = candidate(e.target);
      if (el && el === curTarget) {
        // 子要素間の移動では消さない(関連要素が同じ curTarget 内なら維持)
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        hide();
      } else if (showTimer && candidate(e.target)) {
        clearTimeout(showTimer); showTimer = null;
      }
    }, true);
  }

  // キーボードフォーカスでも説明を出す
  document.addEventListener('focusin', function (e) {
    var el = candidate(e.target);
    if (el) { hide(); show(el); }
  }, true);
  document.addEventListener('focusout', function () { hide(); }, true);

  // スクロール/クリック/ホイールで隠す
  ['scroll', 'wheel', 'click', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (curTarget || showTimer) hide(); }, true);
  });
  window.addEventListener('blur', hide);
})();
