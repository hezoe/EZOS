/* EZeditor front-end */
'use strict';

const b64u2buf = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)).buffer;
};
const buf2b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function api(path, data) {
  const opt = data !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezeditor' },
        body: JSON.stringify(data) }
    : { headers: { 'X-Requested-With': 'ezeditor' } };
  const res = await fetch(path, opt);
  const json = await res.json().catch(() => ({ error: 'サーバーエラー' }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---- 簡易Markdownレンダラ ---- */
function renderMd(src) {
  const lines = String(src ?? '').split('\n');
  let html = '', inCode = false, codeLang = '', codeBuf = [], listStack = [];

  const closeLists = () => {
    while (listStack.length) html += `</${listStack.pop()}>`;
  };
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\s][^*]*)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');

  for (const line of lines) {
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (inCode) {
        html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
        inCode = false; codeBuf = [];
      } else {
        closeLists();
        inCode = true; codeLang = fence[1];
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeLists(); html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (listStack[listStack.length - 1] !== tag) { closeLists(); html += `<${tag}>`; listStack.push(tag); }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      continue;
    }
    closeLists();
    if (line.trim() === '') { html += ''; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // 表は行単位で素朴に (ヘッダー区切り行はスキップ)
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      html += `<table><tr><td>${cells.join('</td><td>')}</td></tr></table>`;
      continue;
    }
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
  closeLists();
  // 連続tableをまとめる
  return html.replace(/<\/table><table>/g, '');
}

/* ================= ログイン画面 ================= */

if (!window.EZ.authed) {
  const msg = document.getElementById('login-msg');
  const showErr = (e) => { msg.textContent = e.message || String(e); msg.hidden = false; };

  document.getElementById('btn-login')?.addEventListener('click', async () => {
    try {
      const { options, challengeId } = await api('/api/login-options', {});
      options.challenge = b64u2buf(options.challenge);
      (options.allowCredentials || []).forEach((c) => { c.id = b64u2buf(c.id); });
      const cred = await navigator.credentials.get({ publicKey: options });
      const authResp = {
        id: cred.id,
        rawId: buf2b64u(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: buf2b64u(cred.response.clientDataJSON),
          authenticatorData: buf2b64u(cred.response.authenticatorData),
          signature: buf2b64u(cred.response.signature),
          userHandle: cred.response.userHandle ? buf2b64u(cred.response.userHandle) : null,
        },
      };
      await api('/api/login-verify', { authResp, challengeId });
      location.reload();
    } catch (e) { showErr(e); }
  });

  document.getElementById('btn-register')?.addEventListener('click', async () => {
    try {
      const setupKey = document.getElementById('setup-key')?.value || '';
      const label = document.getElementById('reg-label')?.value || '';
      const { options, challengeId } = await api('/api/reg-options', { setupKey });
      options.challenge = b64u2buf(options.challenge);
      options.user.id = b64u2buf(options.user.id);
      (options.excludeCredentials || []).forEach((c) => { c.id = b64u2buf(c.id); });
      const cred = await navigator.credentials.create({ publicKey: options });
      const attResp = {
        id: cred.id,
        rawId: buf2b64u(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: buf2b64u(cred.response.clientDataJSON),
          attestationObject: buf2b64u(cred.response.attestationObject),
          transports: cred.response.getTransports?.() ?? [],
        },
      };
      await api('/api/reg-verify', { attResp, challengeId, label });
      location.reload();
    } catch (e) { showErr(e); }
  });
}

/* ================= アプリ本体 ================= */

if (window.EZ.authed) {
  const isMobile = window.EZ.view === 'mobile';
  const messagesEl = document.getElementById('messages');
  const promptEl = document.getElementById('prompt');
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('btn-stop');
  const statusEl = document.getElementById('chat-status');
  const titleEl = document.getElementById('chat-title');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');

  let currentConv = null;   // 会話ID
  let streaming = false;

  /* ---- サイドバー(モバイル) ---- */
  const openSide = (open) => {
    sidebar.classList.toggle('open', open);
    backdrop.hidden = !open;
  };
  document.getElementById('btn-menu').addEventListener('click', () => openSide(true));
  document.getElementById('btn-close-side').addEventListener('click', () => openSide(false));
  backdrop.addEventListener('click', () => openSide(false));

  /* ---- 会話一覧 ---- */
  async function refreshList() {
    const { conversations } = await api('/api/conversations');
    const nav = document.getElementById('conv-list');
    nav.innerHTML = conversations.map((c) => `
      <div class="conv-item ${c.id === currentConv ? 'active' : ''}" data-id="${c.id}">
        <span class="t">${esc(c.title)}</span>
        <button class="del" data-del="${c.id}" title="削除">🗑</button>
      </div>`).join('') || '<div style="color:var(--dim);padding:12px">会話はまだありません</div>';

    nav.querySelectorAll('.conv-item').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.del')) return;
        openConversation(el.dataset.id);
        openSide(false);
      });
    });
    nav.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('この会話を削除しますか?')) return;
        await api('/api/conversation-delete', { id: b.dataset.del });
        if (currentConv === b.dataset.del) newConversation();
        refreshList();
      });
    });
  }

  function newConversation() {
    currentConv = null;
    titleEl.textContent = '新しい会話';
    messagesEl.innerHTML = '';
    promptEl.focus();
  }

  async function openConversation(id) {
    const { conversation } = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
    currentConv = id;
    titleEl.textContent = conversation.title;
    messagesEl.innerHTML = '';
    for (const m of conversation.messages) {
      addMessage(m.role, m.text);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    refreshList();
  }

  document.getElementById('btn-new').addEventListener('click', () => { newConversation(); openSide(false); });
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/logout', {}).catch(() => {});
    location.reload();
  });

  /* ---- メッセージ描画 ---- */
  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.innerHTML = `<div class="role">${role === 'user' ? 'あなた' : 'Claude'}</div>
      <div class="bubble"></div>`;
    const bubble = div.querySelector('.bubble');
    if (role === 'user') bubble.textContent = text;
    else bubble.innerHTML = renderMd(text);
    messagesEl.appendChild(div);
    return bubble;
  }

  const nearBottom = () =>
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const scrollBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

  /* ---- 送信 ---- */
  async function send() {
    const prompt = promptEl.value.trim();
    if (!prompt || streaming) return;
    streaming = true;
    sendBtn.hidden = true;
    stopBtn.hidden = false;
    promptEl.value = '';
    autosize();
    document.querySelector('.welcome')?.remove();

    addMessage('user', prompt);
    const bubble = addMessage('assistant', '');
    bubble.innerHTML = '<span class="cursor"></span>';
    scrollBottom();

    let acc = '';
    let renderTimer = null;
    const rerender = () => {
      const stick = nearBottom();
      bubble.innerHTML = renderMd(acc) + '<span class="cursor"></span>';
      if (stick) scrollBottom();
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezeditor' },
        body: JSON.stringify({
          convId: currentConv,
          prompt,
          tools: document.getElementById('allow-tools').checked,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';

      const handle = (ev, data) => {
        switch (ev) {
          case 'meta':
            currentConv = data.convId;
            titleEl.textContent = data.title;
            break;
          case 'init':
            statusEl.textContent = data.model || '';
            break;
          case 'delta':
            acc += data.text;
            if (!renderTimer) {
              renderTimer = setTimeout(() => { renderTimer = null; rerender(); }, 120);
            }
            break;
          case 'tool': {
            const n = document.createElement('div');
            n.className = 'tool-note';
            n.textContent = `🛠 ${data.name} を実行中…`;
            bubble.parentElement.insertBefore(n, bubble);
            if (nearBottom()) scrollBottom();
            break;
          }
          case 'done':
            if (data.errorText) acc += `\n\n> ⚠ ${data.errorText}`;
            statusEl.textContent = data.isError ? 'エラー'
              : data.durationMs ? `完了 (${Math.round(data.durationMs / 1000)}秒)` : '完了';
            break;
          case 'error':
            acc += `\n\n> ⚠ ${data.message}`;
            break;
        }
      };

      let done = false;
      while (!done) {
        const r = await reader.read();
        done = r.done;
        if (r.value) sseBuf += decoder.decode(r.value, { stream: true });
        let sep;
        while ((sep = sseBuf.indexOf('\n\n')) >= 0) {
          const raw = sseBuf.slice(0, sep);
          sseBuf = sseBuf.slice(sep + 2);
          let ev = 'message', data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) {
            try { handle(ev, JSON.parse(data)); } catch { /* skip */ }
          }
        }
      }
    } catch (e) {
      acc += `\n\n> ⚠ ${e.message}`;
    } finally {
      clearTimeout(renderTimer);
      bubble.innerHTML = renderMd(acc || '(応答なし)');
      streaming = false;
      sendBtn.hidden = false;
      stopBtn.hidden = true;
      refreshList();
    }
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => {
    if (currentConv) api('/api/stop', { convId: currentConv }).catch(() => {});
  });
  promptEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !isMobile) {
      ev.preventDefault();
      send();
    }
  });

  /* ---- テキストエリア自動リサイズ ---- */
  function autosize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  promptEl.addEventListener('input', autosize);

  /* ---- 起動時 ---- */
  refreshList();
  api('/api/status').then((s) => {
    if (!s.claudeLoggedIn) {
      const warn = document.getElementById('claude-warn');
      if (warn) warn.hidden = false;
    }
  }).catch(() => {});
  promptEl.focus();
}
