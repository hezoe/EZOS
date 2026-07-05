/* EZ開発ハブ front-end */
'use strict';

const API = 'api.php';

/* ---------- 共通ユーティリティ ---------- */

async function api(action, data) {
  const opt = data !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ezhub' },
        body: JSON.stringify(data) }
    : { headers: { 'X-Requested-With': 'ezhub' } };
  const res = await fetch(`${API}?action=${action}`, opt);
  const json = await res.json().catch(() => ({ ok: false, error: 'サーバーエラー' }));
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const b64u2buf = s => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(pad), c => c.charCodeAt(0)).buffer;
};
const buf2b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtElapsed(sec) {
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間${Math.floor(sec % 3600 / 60)}分`;
  return `${Math.floor(sec / 86400)}日`;
}

/* ---------- ログイン画面 ---------- */

if (!window.EZ.authed) {
  const msg = document.getElementById('login-msg');
  const showErr = e => { if (msg) { msg.textContent = e.message || String(e); msg.hidden = false; } };

  document.getElementById('btn-login')?.addEventListener('click', async () => {
    try {
      const { args } = await api('login_challenge');
      const pk = args.publicKey;
      pk.challenge = b64u2buf(pk.challenge);
      (pk.allowCredentials || []).forEach(c => { c.id = b64u2buf(c.id); });
      const cred = await navigator.credentials.get(args);
      await api('login_finish', {
        id: cred.id,
        clientDataJSON: buf2b64(cred.response.clientDataJSON),
        authenticatorData: buf2b64(cred.response.authenticatorData),
        signature: buf2b64(cred.response.signature),
      });
      location.reload();
    } catch (e) { showErr(e); }
  });

  document.getElementById('btn-register')?.addEventListener('click', async () => {
    try {
      const setupKey = document.getElementById('setup-key')?.value || '';
      const label = document.getElementById('reg-label')?.value || '';
      const { args } = await api('reg_challenge', { setup_key: setupKey });
      const pk = args.publicKey;
      pk.challenge = b64u2buf(pk.challenge);
      pk.user.id = b64u2buf(pk.user.id);
      (pk.excludeCredentials || []).forEach(c => { c.id = b64u2buf(c.id); });
      const cred = await navigator.credentials.create(args);
      await api('reg_finish', {
        label,
        clientDataJSON: buf2b64(cred.response.clientDataJSON),
        attestationObject: buf2b64(cred.response.attestationObject),
      });
      location.reload();
    } catch (e) { showErr(e); }
  });
}

/* ---------- アプリ本体 ---------- */

if (window.EZ.authed) {

  const state = { tasks: [], sessions: [], now: 0, project: '' };
  const isMobile = window.EZ.view === 'mobile';

  // NEWバッジ: 前回受信箱を見た時刻(この読み込みでの基準値は固定)
  const lastSeenReview = Number(localStorage.getItem('ez_seen_review') || 0);
  const markSeen = () => localStorage.setItem('ez_seen_review', String(Math.floor(Date.now() / 1000)));

  const STATUS_LABEL = { todo: '未着手', doing: '作業中', review: '確認待ち', done: '完了' };
  const SESS_GROUPS = [
    ['stopped',      '🛑 止まった'],
    ['waiting_user', '🔔 あなた待ち'],
    ['working',      '⚙️ 作業中'],
    ['running',      '▶️ 処理中'],
    ['idle',         '⏳ 待機中'],
  ];
  const PALETTE = ['#e5534b', '#e8a33d', '#d4c14f', '#57ab5a', '#3fb8af',
                   '#539bf5', '#986ee2', '#e275ad', '#768390'];
  const autoColor = id => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  /* ---- toast ---- */
  let toastTimer = null;
  function toast(text, undoFn) {
    const el = document.getElementById('toast');
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (undoFn) {
      const b = document.createElement('button');
      b.textContent = '取り消し';
      b.onclick = () => { el.hidden = true; undoFn(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  /* ---- データ取得 ---- */
  async function refresh() {
    try {
      const r = await api('state');
      state.tasks = r.tasks;
      state.sessions = r.sessions;
      state.now = r.now;
      render();
    } catch (e) {
      if (/401|ログイン/.test(e.message)) location.reload();
    }
  }

  /* ---- 描画 ---- */
  function projectList() {
    const set = new Set();
    state.tasks.forEach(t => t.project && set.add(t.project));
    state.sessions.forEach(s => s.project && set.add(s.project));
    return [...set].sort();
  }

  function render() {
    renderProjects();
    renderSessions();
    renderKanban();
    renderInbox();
  }

  function renderProjects() {
    const sel = document.getElementById('project-filter');
    const cur = state.project;
    sel.innerHTML = '<option value="">全プロジェクト</option>' +
      projectList().map(p => `<option value="${esc(p)}"${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('');
    document.getElementById('project-list').innerHTML =
      projectList().map(p => `<option value="${esc(p)}">`).join('');
  }

  function taskLink(taskText, url) {
    if (url) return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(taskText || url)}</a>`;
    return esc(taskText || '');
  }

  function renderSessions() {
    const body = document.getElementById('sessions-body');
    const list = state.sessions.filter(s => !state.project || s.project === state.project);
    document.getElementById('sess-count').textContent = list.length ? `(${list.length})` : '';

    const waiting = list.filter(s => s.effectiveState === 'waiting_user').length;
    const stopped = list.filter(s => s.effectiveState === 'stopped').length;
    const badge = document.getElementById('tab-badge-sessions');
    if (badge) {
      const n = waiting + stopped;
      badge.hidden = n === 0;
      badge.textContent = n;
    }

    if (!list.length) {
      body.innerHTML = `<div class="empty">セッションなし<br><small>📡 ボタンから連携方法を確認できます</small></div>`;
      return;
    }
    let html = '';
    for (const [key, label] of SESS_GROUPS) {
      let items = list.filter(s => s.effectiveState === key);
      if (!items.length) continue;
      if (key === 'waiting_user') {
        items.sort((a, b) => (a.waitingSince || 0) - (b.waitingSince || 0)); // 長く待たせている順
      } else {
        items.sort((a, b) => (b.lastBeat || 0) - (a.lastBeat || 0));
      }
      html += `<div class="sess-group st-${key}"><h3>${label} (${items.length})</h3>`;
      for (const s of items) {
        const color = s.color || autoColor(s.id);
        const elapsed = key === 'waiting_user' && s.waitingSince
          ? `待ち ${fmtElapsed(state.now - s.waitingSince)}`
          : fmtElapsed(state.now - (s.lastBeat || state.now)) + '前';
        const sub = [s.project, s.detail].filter(Boolean).map(esc).join(' · ');
        const task = s.task ? `<div class="s-sub">🎯 ${taskLink(s.task, s.task_url)}</div>` : '';
        html += `<div class="sess-card st-${key}" data-sid="${esc(s.id)}" style="border-left-color:${color}">
          <div class="s-top"><span class="s-label">${esc(s.label || s.id)}</span>
            <span class="s-elapsed">${elapsed}</span></div>
          ${sub ? `<div class="s-sub">${sub}</div>` : ''}${task}</div>`;
      }
      html += '</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll('.sess-card').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev.target.closest('a')) return;
        const s = state.sessions.find(x => x.id === el.dataset.sid);
        if (!s) return;
        // 自動追従: セッションのプロジェクトにカンバンを合わせる
        if (s.project && state.project !== s.project) {
          state.project = s.project;
          render();
          toast(`プロジェクト「${s.project}」に切替`);
          return;
        }
        openSessionDialog(s);
      });
    });
  }

  function taskCardHtml(t, draggable) {
    const chips = [];
    if (t.project) chips.push(`<span class="chip proj">${esc(t.project)}</span>`);
    if (t.flag === 'discussion') chips.push(`<span class="chip flag-discussion">💬 議論中</span>`);
    if (t.flag === 'hold') chips.push(`<span class="chip flag-hold">✋ 保留</span>`);
    if (t.status === 'review' && t.updatedAt > lastSeenReview) chips.push(`<span class="chip new">NEW</span>`);
    if (t.url) chips.push(`<span class="chip">🔗</span>`);
    return `<div class="task-card" data-tid="${t.id}" ${draggable ? 'draggable="true"' : ''}>
      <div class="t-title">${esc(t.title)}</div>
      ${chips.length ? `<div class="t-meta">${chips.join('')}</div>` : ''}</div>`;
  }

  function renderKanban() {
    const body = document.getElementById('kanban-body');
    const list = state.tasks.filter(t => !state.project || t.project === state.project);
    let html = '';
    for (const st of ['todo', 'doing', 'review', 'done']) {
      let items = list.filter(t => t.status === st);
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      if (st === 'done') items = items.slice(0, 20); // 完了は直近だけ
      html += `<div class="kb-col" data-status="${st}"><h3>${STATUS_LABEL[st]} (${items.length})</h3>
        <div class="kb-cards">${items.map(t => taskCardHtml(t, !isMobile)).join('') ||
          '<div class="empty">なし</div>'}</div></div>`;
    }
    body.innerHTML = html;

    body.querySelectorAll('.task-card').forEach(el => {
      el.addEventListener('click', () => {
        const t = state.tasks.find(x => x.id === Number(el.dataset.tid));
        if (t) openTaskDialog(t);
      });
      el.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', el.dataset.tid);
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
    body.querySelectorAll('.kb-col').forEach(col => {
      col.addEventListener('dragover', ev => { ev.preventDefault(); col.classList.add('dragover'); });
      col.addEventListener('dragleave', () => col.classList.remove('dragover'));
      col.addEventListener('drop', async ev => {
        ev.preventDefault();
        col.classList.remove('dragover');
        const id = Number(ev.dataTransfer.getData('text/plain'));
        const status = col.dataset.status;
        const t = state.tasks.find(x => x.id === id);
        if (!t || t.status === status) return;
        await setStatus(t, status, true);
      });
    });
  }

  function renderInbox() {
    const body = document.getElementById('inbox-body');
    const items = state.tasks
      .filter(t => t.status === 'review' && (!state.project || t.project === state.project))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    document.getElementById('inbox-count').textContent = items.length ? `(${items.length})` : '';
    const newCount = items.filter(t => t.updatedAt > lastSeenReview).length;
    const badge = document.getElementById('tab-badge-inbox');
    if (badge) { badge.hidden = newCount === 0; badge.textContent = newCount; }

    if (!items.length) {
      body.innerHTML = '<div class="empty">確認待ちはありません 🎉</div>';
      return;
    }
    body.innerHTML = items.map(t => {
      const chips = [];
      if (t.project) chips.push(`<span class="chip proj">${esc(t.project)}</span>`);
      if (t.updatedAt > lastSeenReview) chips.push(`<span class="chip new">NEW</span>`);
      return `<div class="inbox-card" data-tid="${t.id}">
        <div class="t-title">${esc(t.title)}</div>
        ${chips.length ? `<div class="t-meta">${chips.join('')}</div>` : ''}
        <div class="i-btns">
          ${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">🔗 実物を開く</a>` : ''}
          <button class="btn primary" data-done="${t.id}">✓ 完了</button>
        </div></div>`;
    }).join('');

    body.querySelectorAll('[data-done]').forEach(b => {
      b.addEventListener('click', async () => {
        const t = state.tasks.find(x => x.id === Number(b.dataset.done));
        if (t) await setStatus(t, 'done', true);
      });
    });
    body.querySelectorAll('.inbox-card .t-title').forEach(el => {
      el.addEventListener('click', () => {
        const t = state.tasks.find(x => x.id === Number(el.parentElement.dataset.tid));
        if (t) openTaskDialog(t);
      });
    });
  }

  async function setStatus(t, status, withUndo) {
    const prev = t.status;
    t.status = status;
    render();
    try {
      await api('task_status', { id: t.id, status });
      if (withUndo) {
        toast(`「${t.title}」を${STATUS_LABEL[status]}に移動`, async () => {
          t.status = prev;
          render();
          await api('task_status', { id: t.id, status: prev }).catch(() => refresh());
        });
      }
    } catch (e) {
      t.status = prev;
      render();
      toast('更新に失敗: ' + e.message);
    }
  }

  /* ---- タスクダイアログ ---- */
  const taskDlg = document.getElementById('task-dialog');

  function openTaskDialog(t) {
    document.getElementById('task-dialog-title').textContent = t ? 'タスクを編集' : '新規タスク';
    document.getElementById('task-id').value = t ? t.id : '';
    document.getElementById('task-title').value = t ? t.title : '';
    document.getElementById('task-project').value = t ? t.project : state.project;
    document.getElementById('task-desc').value = t ? t.desc : '';
    document.getElementById('task-url').value = t ? t.url : '';
    document.getElementById('task-status').value = t ? t.status : 'todo';
    document.getElementById('task-flag').value = t ? t.flag : 'none';
    document.getElementById('task-delete').hidden = !t;
    taskDlg.showModal();
  }

  document.getElementById('task-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const payload = {
      id: Number(document.getElementById('task-id').value) || 0,
      title: document.getElementById('task-title').value,
      project: document.getElementById('task-project').value,
      desc: document.getElementById('task-desc').value,
      url: document.getElementById('task-url').value,
      status: document.getElementById('task-status').value,
      flag: document.getElementById('task-flag').value,
    };
    try {
      await api('task_save', payload);
      taskDlg.close();
      await refresh();
    } catch (e) { toast('保存に失敗: ' + e.message); }
  });

  document.getElementById('task-delete').addEventListener('click', async () => {
    const id = Number(document.getElementById('task-id').value);
    if (!id || !confirm('このタスクを削除しますか?')) return;
    await api('task_delete', { id }).catch(e => toast(e.message));
    taskDlg.close();
    await refresh();
  });

  document.getElementById('btn-new-task').addEventListener('click', () => openTaskDialog(null));

  /* ---- セッションダイアログ ---- */
  const sessDlg = document.getElementById('session-dialog');
  let sessColorSel = '';

  function openSessionDialog(s) {
    document.getElementById('sess-id').value = s.id;
    document.getElementById('sess-label').value = s.label || '';
    sessColorSel = s.color || '';
    const wrap = document.getElementById('sess-colors');
    wrap.innerHTML = PALETTE.map(c =>
      `<button type="button" data-c="${c}" style="background:${c}" class="${c === sessColorSel ? 'sel' : ''}"></button>`).join('');
    wrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      sessColorSel = b.dataset.c;
      wrap.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    }));
    sessDlg.showModal();
  }

  document.getElementById('session-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('session_update', {
        id: document.getElementById('sess-id').value,
        label: document.getElementById('sess-label').value,
        color: sessColorSel,
      });
      sessDlg.close();
      await refresh();
    } catch (e) { toast(e.message); }
  });

  document.getElementById('sess-delete').addEventListener('click', async () => {
    await api('session_delete', { id: document.getElementById('sess-id').value }).catch(e => toast(e.message));
    sessDlg.close();
    await refresh();
  });

  /* ---- 連携情報ダイアログ ---- */
  document.getElementById('btn-conninfo').addEventListener('click', async () => {
    const dlg = document.getElementById('conn-dialog');
    dlg.showModal();
    try {
      const r = await api('conninfo');
      document.getElementById('conn-example').textContent =
`curl -s -X POST '${r.endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Api-Token: ${r.token}' \\
  -d '{"id":"PC名-プロジェクト名","state":"working","label":"名札","project":"EZEditor","task":"いま取り組んでいる事","task_url":"https://..."}'`;
    } catch (e) {
      document.getElementById('conn-example').textContent = e.message;
    }
  });
  document.getElementById('conn-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('conn-example').textContent);
    toast('コピーしました');
  });

  /* ---- 共通UI ---- */
  document.querySelectorAll('dialog [data-close]').forEach(b =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  document.getElementById('project-filter').addEventListener('change', ev => {
    state.project = ev.target.value;
    render();
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('logout', {}).catch(() => {});
    location.reload();
  });

  // モバイル: タブ切替
  document.querySelectorAll('#tabbar button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#tabbar button').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('active', p.dataset.tab === b.dataset.tab));
      if (b.dataset.tab === 'inbox') markSeen();
    });
  });
  if (isMobile) document.getElementById('panel-sessions').classList.add('active');

  // デスクトップでは受信箱が常に見えているので、閲覧したら既読化
  if (!isMobile) {
    setTimeout(markSeen, 5000);
  }

  /* ---- ポーリング ---- */
  refresh();
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}
