/* EZOS ハンバーガーメニュー + 設定ビュー + マニュアル表示。
   ヘッダー右端の ☰(#btn-menu)から開く。項目: ヘルプ/言語/設定/ログオフ。
   term.js/ezbrowser.js とは独立(window.EZ 経由でのみ連携)。 */
'use strict';
(function () {
  const t = (k, v) => (window.EZ && window.EZ.t ? window.EZ.t(k, v) : k);
  const lang = () => (window.EZ && window.EZ.lang) || 'ja';
  const btn = document.getElementById('btn-menu');
  if (!btn) return;

  /* ---- WebAuthn ヘルパ(パスキー追加用。app.js と同等) ---- */
  const b64u2buf = (s) => {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)).buffer;
  };
  const buf2b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function api(path, data) {
    const opt = data !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezos' }, body: JSON.stringify(data) }
      : { headers: { 'X-Requested-With': 'ezos' } };
    const res = await fetch(path, opt);
    const json = await res.json().catch(() => ({ error: t('common.serverError') }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- ドロップダウンメニュー ---------- */
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('mousedown', onDocDown, true); } }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target) && e.target !== btn) closeMenu(); }

  function buildRoot() {
    const items = [
      ['❓', t('menu.help'), openManual],
      ['🌐', t('menu.language'), showLangSubmenu],
      ['⚙️', t('menu.settings'), openSettings],
      ['⏻', t('menu.logout'), doLogout],
    ];
    return items;
  }
  function renderMenu(items) {
    if (!menuEl) return;
    menuEl.innerHTML = '';
    for (const [icon, label, fn] of items) {
      const b = document.createElement('button');
      b.className = 'ez-menu-item';
      b.innerHTML = `<span class="ez-mi-ic">${icon}</span><span class="ez-mi-tx"></span>`;
      b.querySelector('.ez-mi-tx').textContent = label;
      b.addEventListener('click', () => fn());
      menuEl.appendChild(b);
    }
  }
  function showLangSubmenu() {
    renderMenu([
      ['↩︎', t('common.cancel'), () => renderMenu(buildRoot())],
      [lang() === 'ja' ? '●' : '○', t('settings.langJa'), () => window.EZ.setLang('ja')],
      [lang() === 'en' ? '●' : '○', t('settings.langEn'), () => window.EZ.setLang('en')],
    ]);
  }
  function openMenu() {
    if (menuEl) { closeMenu(); return; }
    menuEl = document.createElement('div');
    menuEl.className = 'ez-menu';
    document.body.appendChild(menuEl);
    renderMenu(buildRoot());
    const r = btn.getBoundingClientRect();
    const w = 220;
    menuEl.style.top = (r.bottom + 4) + 'px';
    menuEl.style.left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6)) + 'px';
    menuEl.style.width = w + 'px';
    document.addEventListener('mousedown', onDocDown, true);
  }
  btn.addEventListener('click', openMenu);

  async function doLogout() {
    closeMenu();
    if (!confirm(t('menu.logout') + ' ?')) return;
    await api('/api/logout', {}).catch(() => {});
    location.reload();
  }

  /* ---------- 汎用オーバーレイ ---------- */
  function overlay(title, contentEl, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'ez-overlay';
    const modal = document.createElement('div');
    modal.className = 'ez-modal' + (opts && opts.wide ? ' wide' : '');
    const head = document.createElement('div');
    head.className = 'ez-modal-head';
    const h = document.createElement('h2'); h.textContent = title;
    const x = document.createElement('button'); x.className = 'ez-modal-x'; x.setAttribute('aria-label', t('common.close')); x.textContent = '✕';
    head.appendChild(h);
    if (opts && opts.headExtra) head.appendChild(opts.headExtra);
    head.appendChild(x);
    const body = document.createElement('div');
    body.className = 'ez-modal-body';
    body.appendChild(contentEl);
    modal.appendChild(head); modal.appendChild(body);
    wrap.appendChild(modal);
    const close = () => { wrap.remove(); if (opts && typeof opts.onClose === 'function') opts.onClose(); };
    x.addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function onEsc(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
    document.body.appendChild(wrap);
    return { wrap, body, close };
  }

  /* ---------- ヘルプ(マニュアル) ---------- */
  function openManual() {
    closeMenu();
    const cont = document.createElement('div');
    cont.className = 'ez-manual-wrap';
    const frame = document.createElement('iframe');
    frame.className = 'ez-manual-frame';
    frame.setAttribute('title', t('menu.help'));
    cont.appendChild(frame);
    const openTab = document.createElement('a');
    openTab.className = 'btn small';
    openTab.href = `/manual?lang=${encodeURIComponent(lang())}`;
    openTab.target = '_blank'; openTab.rel = 'noopener';
    openTab.textContent = '⤢';
    openTab.title = lang() === 'ja' ? '新しいタブで開く' : 'Open in new tab';

    // マニュアルHTMLを取得して srcdoc で表示する。リバースプロキシ(Caddy)が付与する
    // X-Frame-Options: DENY は URL 読み込みの iframe をブロックするが、srcdoc には適用
    // されないため確実に画面内表示できる。言語切替はマニュアル内リンクからの iframe
    // ナビゲーション(=実URL読込で XFO に弾かれる)ではなく、postMessage で親に伝えて
    // ここで srcdoc を差し替える(新しいタブでの表示は ⤢ から)。
    let curLang = lang();
    function load(lg) {
      curLang = (lg === 'en') ? 'en' : 'ja';
      openTab.href = `/manual?lang=${curLang}`;
      fetch(`/manual?lang=${curLang}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('http ' + r.status))))
        .then((html) => { frame.srcdoc = html; })
        .catch(() => {
          frame.srcdoc = '<p style="font-family:sans-serif;padding:24px;color:#333">'
            + (curLang === 'ja' ? 'マニュアルを読み込めませんでした。' : 'Failed to load the manual.')
            + '</p>';
        });
    }
    const onMsg = (e) => { if (e.data && e.data.ezManualLang) load(e.data.ezManualLang); };
    window.addEventListener('message', onMsg);
    overlay(t('menu.help'), cont, { wide: true, headExtra: openTab, onClose: () => window.removeEventListener('message', onMsg) });
    load(curLang);
  }

  /* ---------- 設定ビュー ---------- */
  function section(titleKey) {
    const s = document.createElement('section');
    s.className = 'ez-set-sec';
    const h = document.createElement('h3'); h.textContent = t(titleKey);
    s.appendChild(h);
    return s;
  }
  function radioRow(name, value, current, label, onChange) {
    const id = `ezr-${name}-${value}`;
    const row = document.createElement('label');
    row.className = 'ez-radio';
    row.setAttribute('for', id);
    const input = document.createElement('input');
    input.type = 'radio'; input.name = name; input.id = id; input.value = value;
    if (value === current) input.checked = true;
    input.addEventListener('change', () => { if (input.checked) onChange(value); });
    const span = document.createElement('span'); span.textContent = label;
    row.appendChild(input); row.appendChild(span);
    return row;
  }

  function openSettings() {
    closeMenu();
    const cont = document.createElement('div');
    cont.className = 'ez-settings';

    /* 言語 */
    const secLang = section('settings.language');
    secLang.appendChild(radioRow('lang', 'ja', lang(), t('settings.langJa'), (v) => window.EZ.setLang(v)));
    secLang.appendChild(radioRow('lang', 'en', lang(), t('settings.langEn'), (v) => window.EZ.setLang(v)));
    cont.appendChild(secLang);

    /* 表示モード */
    const secView = section('settings.viewMode');
    const curView = (document.cookie.match(/(?:^|;\s*)ezview=(mobile|desktop)/) || [])[1] || 'auto';
    const goView = (v) => { location.href = `?view=${v}`; };
    secView.appendChild(radioRow('view', 'auto', curView, t('settings.viewAuto'), goView));
    secView.appendChild(radioRow('view', 'desktop', curView, t('settings.viewDesktop'), goView));
    secView.appendChild(radioRow('view', 'mobile', curView, t('settings.viewMobile'), goView));
    const vn = document.createElement('p'); vn.className = 'ez-set-note'; vn.textContent = t('settings.viewModeNote');
    secView.appendChild(vn);
    cont.appendChild(secView);

    /* 通知音 */
    const secSound = section('settings.sound');
    const cs = localStorage.getItem('ez_confirm_sound') || 'limitbreak';
    const csLabel = document.createElement('div'); csLabel.className = 'ez-set-sub'; csLabel.textContent = t('settings.confirmSound');
    secSound.appendChild(csLabel);
    const setConfirm = (v) => {
      localStorage.setItem('ez_confirm_sound', v);
      if (v !== 'off' && window.EZ.previewSound) window.EZ.previewSound(v);
    };
    [['limitbreak', 'settings.soundLimitbreak'], ['meow', 'settings.soundMeow'], ['off', 'settings.soundOff']]
      .forEach(([v, k]) => secSound.appendChild(radioRow('csound', v, cs, t(k), setConfirm)));
    const isLabel = document.createElement('div'); isLabel.className = 'ez-set-sub'; isLabel.textContent = t('settings.idleSound');
    secSound.appendChild(isLabel);
    const idleOn = localStorage.getItem('ez_idle_sound') !== '0';
    const idleRow = document.createElement('label'); idleRow.className = 'ez-switch';
    const idleInput = document.createElement('input'); idleInput.type = 'checkbox'; idleInput.checked = idleOn;
    idleInput.addEventListener('change', () => localStorage.setItem('ez_idle_sound', idleInput.checked ? '1' : '0'));
    const idleSpan = document.createElement('span'); idleSpan.textContent = t('settings.soundOn');
    idleRow.appendChild(idleInput); idleRow.appendChild(idleSpan);
    secSound.appendChild(idleRow);
    cont.appendChild(secSound);

    /* パスキー端末管理 */
    const secPk = section('settings.passkeys');
    const pkNote = document.createElement('p'); pkNote.className = 'ez-set-note'; pkNote.textContent = t('settings.passkeysNote');
    secPk.appendChild(pkNote);
    const pkList = document.createElement('div'); pkList.className = 'ez-pk-list';
    secPk.appendChild(pkList);
    const addBtn = document.createElement('button'); addBtn.className = 'btn'; addBtn.textContent = t('settings.addPasskey');
    addBtn.addEventListener('click', () => addPasskey(pkList, addBtn));
    secPk.appendChild(addBtn);
    cont.appendChild(secPk);

    overlay(t('settings.title'), cont);
    loadPasskeys(pkList);
  }

  async function loadPasskeys(listEl) {
    listEl.innerHTML = '';
    let data;
    try { data = await api('/api/passkeys'); } catch (e) { listEl.textContent = e.message; return; }
    const items = data.passkeys || [];
    if (!items.length) { listEl.innerHTML = `<p class="ez-set-note">${esc(t('settings.noPasskeys'))}</p>`; return; }
    for (const pk of items) {
      const row = document.createElement('div'); row.className = 'ez-pk-row';
      const info = document.createElement('div'); info.className = 'ez-pk-info';
      const label = document.createElement('div'); label.className = 'ez-pk-label';
      label.textContent = pk.label + (pk.current ? ` (${t('common.thisDevice')})` : '');
      const meta = document.createElement('div'); meta.className = 'ez-pk-meta';
      meta.textContent = `${t('settings.registered')}: ${pk.createdAt ? new Date(pk.createdAt).toLocaleString() : '-'}`;
      info.appendChild(label); info.appendChild(meta);
      const del = document.createElement('button'); del.className = 'btn small danger'; del.textContent = t('common.delete');
      del.addEventListener('click', async () => {
        if (items.length <= 1) { alert(t('settings.passkeyLast')); return; }
        if (!confirm(t('settings.passkeyDeleteConfirm'))) return;
        try { await api('/api/passkeys/delete', { id: pk.id }); loadPasskeys(listEl); }
        catch (e) { alert(e.message); }
      });
      row.appendChild(info); row.appendChild(del);
      listEl.appendChild(row);
    }
  }

  async function addPasskey(listEl, addBtn) {
    addBtn.disabled = true;
    try {
      const label = prompt(t('login.deviceNamePh')) || '';
      const { options, challengeId } = await api('/api/reg-options', {});
      options.challenge = b64u2buf(options.challenge);
      options.user.id = b64u2buf(options.user.id);
      (options.excludeCredentials || []).forEach((c) => { c.id = b64u2buf(c.id); });
      const cred = await navigator.credentials.create({ publicKey: options });
      const attResp = {
        id: cred.id, rawId: buf2b64u(cred.rawId), type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: buf2b64u(cred.response.clientDataJSON),
          attestationObject: buf2b64u(cred.response.attestationObject),
          transports: cred.response.getTransports?.() ?? [],
        },
      };
      await api('/api/reg-verify', { attResp, challengeId, label });
      alert(t('settings.added'));
      loadPasskeys(listEl);
    } catch (e) { alert(e.message); }
    finally { addBtn.disabled = false; }
  }
})();
