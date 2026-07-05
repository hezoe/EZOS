/* EZOS 監査ログ・リアルタイムビュー (tail -f 相当) */
'use strict';

(() => {
  const logEl = document.getElementById('audit-log');
  if (!logEl) return;
  const statusEl = document.getElementById('audit-status');
  const filterEl = document.getElementById('audit-filter');
  const followEl = document.getElementById('audit-follow');
  const clearBtn = document.getElementById('audit-clear');

  const MAX_LINES = 3000; // DOMに残す最大行数 (古い順に間引く)
  let filter = '';
  let connected = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const EVENT_CLASS = {
    PROMPT: 'ev-prompt', TOOL: 'ev-tool', RESULT: 'ev-result',
    NOTIFY: 'ev-notify', STOP: 'ev-stop', SESSION: 'ev-session',
  };

  // "TS | SHORT | LABEL | detail(|を含みうる)" を分解する
  function parseLine(raw) {
    const parts = raw.split(' | ');
    if (parts.length < 4) return { ts: '', sid: '', label: '', detail: raw };
    return {
      ts: parts[0], sid: parts[1], label: parts[2].trim(),
      detail: parts.slice(3).join(' | '),
    };
  }

  function applyFilter(node) {
    node.hidden = filter !== '' && !node.dataset.text.includes(filter);
  }

  function lineNode(raw) {
    const p = parseLine(raw);
    const div = document.createElement('div');
    div.className = 'audit-line ' + (EVENT_CLASS[p.label] || '');
    div.dataset.text = raw.toLowerCase();
    const hhmmss = p.ts.length >= 19 ? p.ts.slice(11, 19) : p.ts;
    div.innerHTML =
      `<span class="a-ts">${esc(hhmmss)}</span>` +
      `<span class="a-sid">${esc(p.sid)}</span>` +
      `<span class="a-label">${esc(p.label)}</span>` +
      `<span class="a-detail">${esc(p.detail)}</span>`;
    applyFilter(div);
    return div;
  }

  const atBottom = () =>
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  const toBottom = () => { logEl.scrollTop = logEl.scrollHeight; };

  function appendLines(lines, isSeed) {
    // 追加前の追従判定 (自動追従ONかつ最下部にいる、またはシード時)
    const follow = followEl.checked && (isSeed || atBottom());
    const frag = document.createDocumentFragment();
    for (const raw of lines) if (raw) frag.appendChild(lineNode(raw));
    logEl.appendChild(frag);
    let over = logEl.childElementCount - MAX_LINES;
    while (over-- > 0 && logEl.firstChild) logEl.removeChild(logEl.firstChild);
    if (follow) toBottom();
  }

  function systemLine(text) {
    const d = document.createElement('div');
    d.className = 'audit-line ev-system';
    d.dataset.text = '';
    d.innerHTML = `<span class="a-detail">— ${esc(text)} —</span>`;
    logEl.appendChild(d);
    if (followEl.checked) toBottom();
  }

  function connect() {
    if (connected) return;
    connected = true;
    statusEl.textContent = '接続中…';
    const es = new EventSource('/api/audit/stream');
    es.addEventListener('seed', (e) => {
      logEl.innerHTML = '';
      const lines = JSON.parse(e.data).lines;
      appendLines(lines, true);
      if (!lines.length) systemLine('まだ記録がありません。Claudeが作業を始めると流れます');
      statusEl.textContent = '● 追従中';
    });
    es.addEventListener('line', (e) => appendLines(JSON.parse(e.data).lines, false));
    es.addEventListener('reset', () => systemLine('ログがローテーションされました'));
    es.onopen = () => { statusEl.textContent = '● 追従中'; };
    es.onerror = () => { statusEl.textContent = '⚠ 再接続中…'; };
  }

  filterEl.addEventListener('input', () => {
    filter = filterEl.value.trim().toLowerCase();
    logEl.querySelectorAll('.audit-line').forEach(applyFilter);
    if (followEl.checked) toBottom();
  });
  followEl.addEventListener('change', () => { if (followEl.checked) toBottom(); });
  clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; });

  // 監査タブを初めて開いたときに接続する (遅延接続で常時ポーリングを避ける)
  const tabBtn = document.querySelector('#hub-tabs button[data-hubpanel="audit"]');
  if (tabBtn) tabBtn.addEventListener('click', connect);
})();
