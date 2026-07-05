/* EZHL — EZeditor 用の軽量シンタックスハイライタ(外部依存なし)
 * window.EZHL.highlight(code, lang) が HTMLエスケープ済み+<span class="tok-*">付きの
 * 文字列を返す。lang は langFor(filename) で拡張子から判定する。
 * トークナイザは各言語のルール配列を先頭から sticky(y) で試すだけの単純な実装。
 * 完璧な言語解析は狙わず「読みやすい色分け」を目的とする。 */
(function () {
  'use strict';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // トークン種別 → CSSクラス(nullはそのまま出力)
  const CLS = {
    kw: 'tok-kw', bool: 'tok-num', num: 'tok-num', str: 'tok-str', com: 'tok-com',
    fn: 'tok-fn', prop: 'tok-prop', punct: 'tok-punct', tag: 'tok-tag',
    attr: 'tok-attr', doctype: 'tok-kw', ident: null, text: null, ws: null,
  };

  // ルール: [type, 正規表現ソース]。順序が優先度。sticky で現在位置のみ照合。
  const JS_RULES = [
    ['com', '\\/\\/[^\\n]*'],
    ['com', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['str', '`(?:\\\\.|[^`\\\\])*`'],
    ['str', '"(?:\\\\.|[^"\\\\])*"'],
    ['str', "'(?:\\\\.|[^'\\\\])*'"],
    ['num', '\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'],
    ['kw', '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|from|export|as|default|delete|void|static|get|set)\\b'],
    ['bool', '\\b(?:true|false|null|undefined|NaN|Infinity)\\b'],
    ['fn', '[A-Za-z_$][\\w$]*(?=\\s*\\()'],
    ['prop', '[A-Za-z_$][\\w$]*(?=\\s*:)'],
    ['ident', '[A-Za-z_$][\\w$]*'],
    // '/' は punct集合から外して単独扱いにする(貪欲マッチが `//`コメントを飲み込むのを防ぐ)
    ['punct', '[{}()\\[\\];,.<>+\\-*%=&|!?:~^@]+'],
    ['punct', '\\/'],
    ['ws', '\\s+'],
  ];

  const JSON_RULES = [
    ['prop', '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'],
    ['str', '"(?:\\\\.|[^"\\\\])*"'],
    ['num', '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'],
    ['bool', '\\b(?:true|false|null)\\b'],
    ['punct', '[{}\\[\\]:,]+'],
    ['ws', '\\s+'],
  ];

  const CSS_RULES = [
    ['com', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['str', '"[^"]*"'],
    ['str', "'[^']*'"],
    ['num', '#[0-9a-fA-F]{3,8}\\b|-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|ex|ch|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt|cm|mm)?\\b'],
    ['prop', '[A-Za-z-]+(?=\\s*:)'],
    ['kw', '@[A-Za-z-]+'],
    ['punct', '[{}();:,>~+*]+'],
    ['ident', '[.#]?[A-Za-z_][\\w-]*'],
    ['ws', '\\s+'],
  ];

  const HTML_RULES = [
    ['com', '<!--[\\s\\S]*?-->'],
    ['doctype', '<!DOCTYPE[^>]*>'],
    ['tag', '<\\/?[A-Za-z][\\w:-]*'],
    ['punct', '\\/?>'],
    ['attr', '[A-Za-z_:][\\w:.-]*(?=\\s*=)'],
    ['str', '"[^"]*"'],
    ['str', "'[^']*'"],
    ['text', '[^<]+'],
  ];

  // ルールを一度だけコンパイル
  function compile(rules) { return rules.map(r => ({ type: r[0], re: new RegExp(r[1], 'y') })); }
  const COMPILED = { js: compile(JS_RULES), json: compile(JSON_RULES), css: compile(CSS_RULES), html: compile(HTML_RULES) };

  function tokenize(code, compiled) {
    const out = [];
    let pos = 0;
    const n = code.length;
    while (pos < n) {
      let matched = false;
      for (let i = 0; i < compiled.length; i++) {
        const c = compiled[i];
        c.re.lastIndex = pos;
        const m = c.re.exec(code);
        if (m && m[0].length) { out.push({ type: c.type, text: m[0] }); pos += m[0].length; matched = true; break; }
      }
      if (!matched) { out.push({ type: 'text', text: code[pos] }); pos++; }
    }
    return out;
  }

  function render(toks) {
    let s = '';
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const cls = CLS[t.type];
      const e = esc(t.text);
      s += cls ? '<span class="' + cls + '">' + e + '</span>' : e;
    }
    return s;
  }

  // HTML: <script>/<style> の中身は JS/CSS として色分けする
  function highlightHTML(code) {
    const re = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      if (m.index > last) out += render(tokenize(code.slice(last, m.index), COMPILED.html));
      if (m[1] !== undefined) {
        out += render(tokenize(m[1], COMPILED.html)) + render(tokenize(m[2], COMPILED.js)) + render(tokenize(m[3], COMPILED.html));
      } else {
        out += render(tokenize(m[4], COMPILED.html)) + render(tokenize(m[5], COMPILED.css)) + render(tokenize(m[6], COMPILED.html));
      }
      last = re.lastIndex;
    }
    if (last < code.length) out += render(tokenize(code.slice(last), COMPILED.html));
    return out;
  }

  const EXT = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
    json: 'json', css: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  };

  function langFor(name) {
    const dot = String(name || '').lastIndexOf('.');
    if (dot < 0) return null;
    return EXT[name.slice(dot + 1).toLowerCase()] || null;
  }

  function highlight(code, lang) {
    if (lang === 'html') return highlightHTML(code);
    const c = COMPILED[lang];
    if (!c) return esc(code);
    return render(tokenize(code, c));
  }

  window.EZHL = { highlight, langFor };
})();
