/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();

  const AGENTS = {
    rootcode_agent: { name: 'Rootcode', role: 'Orchestrator', icon: 'hubot', tone: 'root' },
    dev_workflow: { name: 'Dev workflow', role: 'Pipeline', icon: 'sparkle', tone: 'dev' },
    developer_agent: { name: 'Developer', role: 'Writes the change', icon: 'code', tone: 'dev' },
    qa_agent: { name: 'QA', role: 'Tests in a sandbox', icon: 'beaker', tone: 'qa' },
    version_control_agent: { name: 'Version control', role: 'Commits and pushes', icon: 'git-commit', tone: 'vcs' },
    pr_review_agent: { name: 'PR review', role: 'Reviews pull requests', icon: 'git-pull-request', tone: 'pr' },
  };
  const TOOLS = {
    list_files: ['folder', 'List files'], read_file: ['file', 'Read file'], write_file: ['edit', 'Write file'],
    search_code: ['search', 'Search code'], run_in_sandbox: ['terminal', 'Run in sandbox'],
    git_status: ['git-commit', 'Git status'], git_diff: ['git-commit', 'Git diff'],
    git_create_branch: ['git-branch', 'Create branch'], git_commit: ['git-commit', 'Commit'], git_push: ['git-branch', 'Push to remote'],
  };
  const ARG_PRIORITY = ['path', 'query', 'command', 'directory', 'branch', 'name', 'message', 'number', 'pullNumber', 'owner', 'repo'];
  const SUGGESTIONS = [
    ['search', 'Review the project structure and suggest improvements'],
    ['beaker', 'Plan and write tests for a feature'],
    ['git-pull-request', 'Review a pull request'],
    ['bug', 'Find and fix a bug'],
  ];
  const MAX_SESSIONS = 100;

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const saved = vscode.getState() || {};
  const state = {
    view: saved.view === 'chat' ? 'chat' : 'home',
    sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
    current: saved.current || '',
    draft: '',
  };
  const running = new Set();
  const runInfo = {};
  let config = { provider: '', model: '', workspace: '', hasKey: true, error: '' };

  const app = document.getElementById('app');
  const icon = name => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const persist = () => vscode.setState({ view: state.view, sessions: state.sessions, current: state.current });
  const session = id => state.sessions.find(s => s.id === id);
  const cur = () => session(state.current);
  const agentInfo = id => AGENTS[id] || { name: String(id || 'Agent'), role: '', icon: 'hubot', tone: 'root' };
  const toolInfo = name => TOOLS[name] || ['plug', String(name).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())];

  // Older saved conversations used a flatter message shape; upgrade them and settle anything left mid-run.
  for (const s of state.sessions) {
    s.messages = (s.messages || []).map(m => {
      if (m.role === 'tool') { return { role: 'assistant', kind: 'tool', author: m.author, id: '', name: m.name, args: {}, status: 'ok', preview: '' }; }
      if (m.role === 'assistant' && !m.kind) { return { ...m, kind: 'text' }; }
      return m;
    });
    for (const m of s.messages) {
      m.live = false; m.final = true;
      if (m.kind === 'tool' && m.status === 'running') { m.status = 'interrupted'; }
      if (m.kind === 'approval' && m.status === 'pending') { m.status = 'denied'; }
    }
  }
  if (!cur() && state.view === 'chat') { state.view = 'home'; }

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) { return 'just now'; }
    if (m < 60) { return `${m}m ago`; }
    if (m < 1440) { return `${Math.round(m / 60)}h ago`; }
    return `${Math.round(m / 1440)}d ago`;
  }
  function duration(ms) {
    if (ms < 1000) { return `${ms}ms`; }
    const s = Math.round(ms / 100) / 10;
    if (s < 60) { return `${s}s`; }
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  // Small, safe markdown subset: input is escaped first, then fenced/inline code, bold and lists.
  function markdown(text) {
    const blocks = [];
    let html = escape(text).replace(/```[\w-]*\n?([\s\S]*?)(```|$)/g, (_m, code) => { blocks.push(code.replace(/\n$/, '')); return `\u0000${blocks.length - 1}\u0000`; });
    html = html.split(/\n{2,}/).map(par => {
      const lines = par.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) { return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`; }
      if (lines.every(l => /^\s*\d+\. /.test(l))) { return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('')}</ol>`; }
      const h = /^(#{1,4}) (.*)$/.exec(par);
      if (h) { return `<h4>${inline(h[2])}</h4>`; }
      return `<p>${inline(par).replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return html.replace(/<p>\u0000(\d+)\u0000<\/p>/g, '\u0000$1\u0000').replace(/\u0000(\d+)\u0000/g, (_m, i) => `<pre><code>${blocks[Number(i)]}</code></pre>`);
  }
  function inline(t) {
    return t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }

  function argSummary(args) {
    if (!args || typeof args !== 'object') { return ''; }
    const keys = Object.keys(args);
    const key = ARG_PRIORITY.find(k => k in args && args[k] !== '' && typeof args[k] !== 'object') || keys.find(k => typeof args[k] !== 'object');
    if (!key) { return ''; }
    const value = String(args[key]).replace(/\s+/g, ' ');
    return value.length > 72 ? `${value.slice(0, 72)}…` : value;
  }

  // ---------- rendering ----------
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) { return; }
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    persist();
    const prevLog = document.getElementById('messages');
    const stick = !prevLog || prevLog.scrollHeight - prevLog.scrollTop - prevLog.clientHeight < 80;
    const prevTop = prevLog ? prevLog.scrollTop : 0;
    const active = document.activeElement;
    const hadFocus = active && active.id === 'prompt';
    const selStart = hadFocus ? active.selectionStart : 0;
    const selEnd = hadFocus ? active.selectionEnd : 0;

    app.innerHTML = state.view === 'chat' && cur() ? chatView() : homeView();
    app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', event => { event.stopPropagation(); action(el.dataset.action, el.dataset.id, el.dataset.text); }));
    app.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => open(el.dataset.open)));
    const input = document.getElementById('prompt');
    if (input) {
      input.value = state.draft;
      const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; };
      input.addEventListener('input', () => {
        state.draft = input.value; fit();
        const send = document.getElementById('send');
        if (send) { send.disabled = !input.value.trim(); }
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
      });
      fit();
      if (!input.disabled && (hadFocus || !prevLog)) { input.focus(); if (hadFocus) { input.setSelectionRange(selStart, selEnd); } }
    }
    const log = document.getElementById('messages');
    if (log) { log.scrollTop = stick ? log.scrollHeight : prevTop; }
  }

  function topbar(left) {
    const status = !config.hasKey
      ? `<span class="pill warn" title="${escape(config.error || 'Model configuration is incomplete')}">${icon('warning')} Model not configured</span>`
      : `<span class="pill" title="${escape(`${config.provider}: ${config.model}`)}">${icon('circle-filled')} ${escape(config.provider ? `${config.provider} · ` : '')}${escape(config.model)}</span>`;
    return `<header class="topbar">${left}<div class="topbar-right"><button class="pill graph-btn" data-action="atlas" title="Open the dependency graph">${icon('type-hierarchy')} Graph</button>${config.workspace ? `<span class="pill ghost">${icon('folder')} ${escape(config.workspace)}</span>` : ''}${status}</div></header>`;
  }

  function composer(placeholder, busy) {
    return `<form class="composer" id="chat-form">
      <textarea id="prompt" rows="1" maxlength="8000" placeholder="${placeholder}" ${busy ? 'disabled' : ''}></textarea>
      <div class="composer-row"><span class="hint">${icon('shield')} Pushes to a remote need your approval</span>
      ${busy
        ? `<button type="button" class="btn danger" data-action="stop">${icon('debug-stop')} Stop</button>`
        : `<button id="send" type="submit" class="btn primary" ${state.draft.trim() ? '' : 'disabled'}>${icon('arrow-up')} Send</button>`}</div>
    </form>`;
  }

  function homeView() {
    const history = [...state.sessions].filter(s => s.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
    const count = s => s.messages.filter(m => m.role === 'user').length;
    return `<div class="shell">${topbar(`<div class="brand">${icon('circuit-board')}<strong>Rootcode</strong></div>`)}
      <main class="home">
        <section class="hero"><h1>What are we building?</h1><p class="muted">Rootcode's agents write, test and ship code in your workspace, and review your pull requests.</p></section>
        ${composer('Describe a task and press Enter to start a new conversation…', false)}
        <div class="chips">${SUGGESTIONS.map(([ic, text]) => `<button class="chip" data-action="suggest" data-text="${escape(text)}">${icon(ic)}<span>${escape(text)}</span></button>`).join('')}</div>
        <section class="history"><div class="section-head"><h2>History</h2><span class="muted">${history.length ? `${history.length} conversation${history.length === 1 ? '' : 's'}` : ''}</span></div>
          ${history.length ? `<ul class="history-list">${history.map(s => `<li><div class="history-item" role="button" tabindex="0" data-open="${escape(s.id)}">
              <span class="history-icon">${icon(running.has(s.id) ? 'loading' : 'comment-discussion')}</span>
              <div class="history-text"><strong>${escape(s.title)}</strong><span class="muted">${running.has(s.id) ? 'Running…' : `${count(s)} message${count(s) === 1 ? '' : 's'} · ${ago(s.updatedAt)}`}</span></div>
              <button class="icon-btn" data-action="delete" data-id="${escape(s.id)}" title="Delete conversation" aria-label="Delete conversation">${icon('trash')}</button></div></li>`).join('')}</ul>`
            : `<div class="empty">${icon('history')}<span>Your conversations will appear here.</span></div>`}
        </section>
        <section class="tools"><button class="tool-card" data-action="trainer"><span class="tool-icon">${icon('settings-gear')}</span><span><strong>Fine-tune on your codebase</strong><span class="muted">Train a personalised model on Baseten or Fireworks.</span></span>${icon('chevron-right')}</button></section>
      </main></div>`;
  }

  // ---------- chat timeline ----------
  const isOpen = (m, fallback) => (m.open === undefined ? fallback : m.open);
  const thoughtDefaultOpen = m => !!m.live;
  const toolDefaultOpen = m => m.status === 'error';

  function thoughtStep(m, i) {
    const first = m.text.trim().split('\n')[0].slice(0, 90);
    return `<details class="step thought${m.live ? ' live' : ''}" data-idx="${i}" ${isOpen(m, thoughtDefaultOpen(m)) ? 'open' : ''}>
      <summary><span class="step-icon">${icon(m.live ? 'loading' : 'lightbulb')}</span><span class="step-title">${m.live ? 'Thinking…' : 'Thought process'}</span>${m.live ? '' : `<span class="step-sub">${escape(first)}</span>`}${icon('chevron-right')}</summary>
      <div class="step-body thought-text">${escape(m.text)}</div></details>`;
  }

  function toolStep(m, i) {
    const [ic, label] = toolInfo(m.name);
    const status = m.status || 'ok';
    const statusIcon = status === 'running' ? icon('loading') : status === 'ok' ? icon('check') : status === 'interrupted' ? icon('circle-slash') : icon('error');
    const arg = argSummary(m.args);
    const hasArgs = m.args && Object.keys(m.args).length;
    return `<details class="step tool ${status}" data-idx="${i}" ${isOpen(m, toolDefaultOpen(m)) ? 'open' : ''}>
      <summary><span class="step-icon">${icon(ic)}</span><span class="step-title">${escape(label)}</span>${arg ? `<code class="step-arg">${escape(arg)}</code>` : ''}<span class="step-status">${m.ms ? `<span class="muted">${duration(m.ms)}</span>` : ''}${statusIcon}</span>${icon('chevron-right')}</summary>
      <div class="step-body">
        ${hasArgs ? `<div class="kv"><span class="k">Input</span><pre>${escape(JSON.stringify(m.args, null, 2))}</pre></div>` : ''}
        ${m.preview ? `<div class="kv"><span class="k">${status === 'error' ? 'Error' : 'Result'}</span><pre>${escape(m.preview)}</pre></div>` : status === 'running' ? '<div class="muted">Running…</div>' : status === 'interrupted' ? '<div class="muted">Stopped before finishing.</div>' : ''}
      </div></details>`;
  }

  function approvalStep(m) {
    const label = m.status === 'pending' ? 'Waiting for your approval' : m.status === 'approved' ? 'Approved' : 'Denied';
    const ic = m.status === 'pending' ? icon('loading') : m.status === 'approved' ? icon('check') : icon('error');
    return `<div class="step approval ${m.status}"><span class="step-icon">${icon('shield')}</span><div class="approval-text"><strong>${label}</strong><code>${escape(m.description)}</code>${m.status === 'pending' ? '<span class="muted">Answer in the VS Code dialog.</span>' : ''}</div>${ic}</div>`;
  }

  function agentHead(author) {
    const a = agentInfo(author);
    return `<div class="agent-head tone-${a.tone}"><span class="avatar">${icon(a.icon)}</span><strong>${escape(a.name)}</strong>${a.role ? `<span class="muted">${escape(a.role)}</span>` : ''}</div>`;
  }

  const signedNum = v => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;

  function rlCard(m) {
    const u = m.update;
    const arms = (u ? u.arms : m.arms) || [];
    const rows = arms.map(a => {
      const pct = Math.round((Math.max(-1, Math.min(1, a.q)) + 1) * 50);
      const chosen = a.id === m.armId;
      return `<div class="rl-arm${chosen ? ' chosen' : ''}"><span class="rl-name">${chosen ? icon('arrow-right') : ''}${escape(a.label)}</span><span class="rl-bar"><i style="width:${pct}%"></i></span><span class="rl-q">Q ${signedNum(a.q)}</span><span class="rl-n">n=${a.n}</span></div>`;
    }).join('');
    const why = m.mode === 'explore'
      ? (m.totalPulls === 0 ? 'No experience yet for this task type, so the policy is exploring.' : 'Trying a less-proven strategy to keep learning.')
      : 'Best-known strategy so far for this task type.';
    let foot;
    if (u && u.failed) {
      foot = `<div class="rl-foot">${icon('warning')}<span>Couldn't record feedback — this decision is from an earlier session.</span></div>`;
    } else if (u) {
      foot = `<div class="rl-foot done">${icon('pulse')}<span>Reward <b class="${u.reward >= 0 ? 'pos' : 'neg'}">${signedNum(u.reward)}</b> (${u.source === 'you' ? 'your feedback' : 'from your edits, tests &amp; git'}) → <b>${escape(u.label)}</b> value ${signedNum(u.qBefore)} → <b>${signedNum(u.qAfter)}</b></span></div>`;
    } else if (m.feedback) {
      foot = `<div class="rl-foot">${icon('loading')}<span>Updating policy…</span></div>`;
    } else {
      foot = `<div class="rl-foot"><span>Was this approach helpful?</span><button class="rl-btn" data-action="rl" data-id="${escape(m.turnId)}" data-text="1" title="Reward this strategy">${icon('thumbsup')}</button><button class="rl-btn" data-action="rl" data-id="${escape(m.turnId)}" data-text="-1" title="Penalize this strategy">${icon('thumbsdown')}</button><span class="muted">or just keep working: edits, tests and git reverts also train it.</span></div>`;
    }
    return `<details class="rl" open><summary>${icon('graph')}<strong>Rootcode RL</strong><span>policy chose <b>${escape(m.label)}</b></span><em class="rl-mode ${m.mode}">${m.mode}</em><span class="rl-ctx">${escape(m.context)}</span></summary><div class="rl-body"><div class="rl-why">${why}</div>${rows}${foot}</div></details>`;
  }

  function messagesHtml(s) {
    const out = [];
    let steps = [];
    let lastAuthor = '';
    const flush = () => { if (steps.length) { out.push(`<div class="steps">${steps.join('')}</div>`); steps = []; } };
    s.messages.forEach((m, i) => {
      if (m.role === 'user') { flush(); lastAuthor = ''; out.push(`<article class="msg user"><div class="bubble">${escape(m.text).replace(/\n/g, '<br>')}</div></article>`); return; }
      if (m.role === 'error') { flush(); out.push(`<article class="msg error">${icon('error')}<div class="body">${markdown(m.text)}</div></article>`); return; }
      if (m.kind === 'handoff') {
        flush();
        const from = agentInfo(m.from), to = agentInfo(m.to);
        out.push(`<div class="handoff"><span>${escape(from.name)}</span>${icon('arrow-right')}<span class="to tone-${to.tone}">${icon(to.icon)} ${escape(to.name)}</span><span class="muted">took over</span></div>`);
        lastAuthor = '';
        return;
      }
      if (m.kind === 'context') {
        flush();
        out.push(`<details class="atlas-ctx"><summary>${icon('type-hierarchy')}<strong>Rootcode Atlas</strong><span>${m.count} relevant file${m.count === 1 ? '' : 's'} from the dependency graph</span><button class="atlas-show" data-action="atlas" data-text="${escape(m.files.join('|'))}">Show in graph</button></summary><ul>${m.files.map(x => `<li>${escape(x)}</li>`).join('')}</ul></details>`);
        lastAuthor = '';
        return;
      }
      if (m.kind === 'memory') {
        flush();
        out.push(`<details class="recall"><summary>${icon('history')}<strong>Rootcode Recall</strong><span>applied ${m.count} lesson${m.count === 1 ? '' : 's'} from past sessions</span></summary><ul>${m.items.map(x => `<li>${escape(x)}</li>`).join('')}</ul></details>`);
        lastAuthor = '';
        return;
      }
      if (m.kind === 'rl') { flush(); out.push(rlCard(m)); lastAuthor = ''; return; }
      if (m.kind === 'summary') {
        flush();
        out.push(`<div class="summary">${icon('clock')}<span>Worked for ${duration(m.ms)}</span>${m.tools ? `<span>· ${m.tools} tool call${m.tools === 1 ? '' : 's'}</span>` : ''}${m.agents.length > 1 ? `<span>· ${m.agents.length} agents</span>` : ''}</div>`);
        lastAuthor = '';
        return;
      }
      if (m.author && m.author !== lastAuthor) { flush(); out.push(agentHead(m.author)); lastAuthor = m.author; }
      if (m.kind === 'thought') { steps.push(thoughtStep(m, i)); }
      else if (m.kind === 'tool') { steps.push(toolStep(m, i)); }
      else if (m.kind === 'approval') { steps.push(approvalStep(m)); }
      else { flush(); out.push(`<div class="body answer${m.live ? ' streaming' : ''}">${markdown(m.text)}</div>`); }
    });
    flush();
    return out.join('');
  }

  function workingHtml(s) {
    if (!running.has(s.id)) { return ''; }
    const last = s.messages[s.messages.length - 1];
    if (last && last.live) { return ''; }
    const info = runInfo[s.id];
    const waiting = last && last.kind === 'approval' && last.status === 'pending';
    return `<div class="working">${icon('loading')}<span>${waiting ? 'Waiting for your approval…' : last && last.kind === 'tool' && last.status === 'running' ? `Running ${escape(toolInfo(last.name)[1].toLowerCase())}…` : 'Working…'}</span><span class="muted" id="elapsed">${info ? duration(Date.now() - info.start) : ''}</span></div>`;
  }

  function chatView() {
    const s = cur();
    const busy = running.has(s.id);
    return `<div class="shell chat-shell">${topbar(`<div class="chat-title"><button class="icon-btn" data-action="home" title="Back to home" aria-label="Back to home">${icon('arrow-left')}</button><strong>${escape(s.title)}</strong></div>`)}
      <main class="chat">
        <div id="messages" class="messages" role="log" aria-live="polite"><div class="messages-inner">${messagesHtml(s)}${workingHtml(s)}</div></div>
        <div class="composer-wrap">${composer('Message Rootcode…', busy)}</div>
      </main></div>`;
  }

  // ---------- state changes ----------
  function create(title) {
    const s = { id: newId(), title: title || 'New conversation', messages: [], updatedAt: Date.now() };
    state.sessions.unshift(s);
    // Keep storage bounded; never drop a running conversation.
    while (state.sessions.length > MAX_SESSIONS) {
      let idx = -1;
      for (let i = state.sessions.length - 1; i >= 0; i--) { if (!running.has(state.sessions[i].id)) { idx = i; break; } }
      if (idx < 0) { break; }
      state.sessions.splice(idx, 1);
    }
    return s;
  }

  function open(id) { state.current = id; state.view = 'chat'; state.draft = ''; render(); }

  function submit() {
    const prompt = state.draft.trim();
    if (!prompt || prompt.length > 8000) { return; }
    // From home a message always starts a new conversation.
    let s = state.view === 'chat' ? cur() : undefined;
    if (!s) { s = create(prompt.slice(0, 48)); }
    if (running.has(s.id)) { return; }
    if (!s.messages.length) { s.title = prompt.slice(0, 48); }
    s.messages.push({ role: 'user', text: prompt });
    s.updatedAt = Date.now();
    state.current = s.id; state.view = 'chat'; state.draft = '';
    running.add(s.id);
    runInfo[s.id] = { start: Date.now(), tools: 0, agents: new Set(), cursor: { thought: null, text: null } };
    vscode.postMessage({ type: 'agent-send', sessionId: s.id, prompt });
    render();
  }

  function action(name, id, text) {
    if (name === 'home') { state.view = 'home'; state.draft = ''; render(); }
    else if (name === 'stop') { vscode.postMessage({ type: 'cancel', sessionId: state.current }); }
    else if (name === 'suggest') { state.draft = text || ''; render(); }
    else if (name === 'rl' && id && (text === '1' || text === '-1')) {
      for (const s of state.sessions) {
        const m = s.messages.find(x => x.kind === 'rl' && x.turnId === id);
        if (m && !m.feedback && !m.update) { m.feedback = Number(text); vscode.postMessage({ type: 'rl-feedback', turnId: id, value: Number(text) }); render();
          // Never hang on "Updating policy…": if the host doesn't answer, say so.
          setTimeout(() => { if (!m.update) { m.update = { failed: true }; scheduleRender(); } }, 5000); }
      }
    }
    else if (name === 'atlas') { vscode.postMessage({ type: 'atlas-open', paths: text ? text.split('|') : [] }); }
    else if (name === 'trainer') { vscode.postMessage({ type: 'open-trainer' }); }
    else if (name === 'delete' && id) {
      if (running.has(id)) { vscode.postMessage({ type: 'cancel', sessionId: id }); running.delete(id); }
      state.sessions = state.sessions.filter(s => s.id !== id);
      delete runInfo[id];
      if (state.current === id) { state.current = ''; state.view = 'home'; }
      render();
    }
  }

  // Remember a step the user expanded or collapsed by hand; defaults keep applying otherwise.
  document.addEventListener('toggle', event => {
    const el = event.target;
    const s = cur();
    if (!s || !el || !el.dataset || el.dataset.idx === undefined) { return; }
    const m = s.messages[Number(el.dataset.idx)];
    if (!m) { return; }
    const fallback = m.kind === 'thought' ? thoughtDefaultOpen(m) : toolDefaultOpen(m);
    if (el.open !== isOpen(m, fallback)) { m.open = el.open; persist(); }
  }, true);

  document.addEventListener('submit', event => { event.preventDefault(); submit(); });
  document.addEventListener('keydown', event => {
    const el = event.target;
    if (el && el.classList && el.classList.contains('history-item') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(el.dataset.open); }
  });
  setInterval(() => {
    const el = document.getElementById('elapsed');
    const info = state.current && runInfo[state.current];
    if (el && info) { el.textContent = duration(Date.now() - info.start); }
  }, 1000);

  function closeLive(s, info) {
    for (const m of s.messages) { if (m.live) { m.live = false; } }
    info.cursor = { thought: null, text: null };
  }

  // Streamed deltas accumulate on one item per kind; the complete event for that step then replaces
  // the text. A finished item is never reused, so successive model turns get their own items.
  function streamInto(s, info, kind, data) {
    let item = info.cursor[kind];
    if (data.partial) {
      if (!item || item.final || item.author !== data.author) {
        item = { role: 'assistant', kind, author: data.author, text: '', live: true, final: false };
        s.messages.push(item); info.cursor[kind] = item;
      }
      item.text += data.text;
      if (kind === 'text') { const t = info.cursor.thought; if (t && t.live) { t.live = false; } }
    } else {
      if (!item || item.final || item.author !== data.author) {
        item = { role: 'assistant', kind, author: data.author, text: '', live: false, final: false };
        s.messages.push(item); info.cursor[kind] = item;
      }
      item.text = data.text; item.live = false; item.final = true;
    }
    info.agents.add(data.author);
  }

  function onAgentEvent(data) {
    const s = session(data.sessionId);
    if (!s) { return; }
    const info = runInfo[s.id] || (runInfo[s.id] = { start: Date.now(), tools: 0, agents: new Set(), cursor: { thought: null, text: null } });
    const t = data.type;
    if (t === 'agent-thought') { streamInto(s, info, 'thought', data); }
    else if (t === 'agent-text') { streamInto(s, info, 'text', data); }
    else if (t === 'agent-tool-call') {
      closeLive(s, info);
      info.tools++; info.agents.add(data.author);
      s.messages.push({ role: 'assistant', kind: 'tool', author: data.author, id: data.id, name: data.name, args: data.args || {}, status: 'running', startedAt: Date.now(), preview: '' });
    } else if (t === 'agent-tool-result') {
      const item = [...s.messages].reverse().find(m => m.kind === 'tool' && m.status === 'running' && (m.id === data.id || (!data.id && m.name === data.name)));
      if (item) { item.status = data.ok ? 'ok' : 'error'; item.preview = data.preview || ''; item.ms = Date.now() - (item.startedAt || Date.now()); }
    } else if (t === 'agent-handoff') {
      closeLive(s, info);
      info.agents.add(data.from); if (data.to) { info.agents.add(data.to); }
      s.messages.push({ role: 'assistant', kind: 'handoff', from: data.from, to: data.to });
    } else if (t === 'agent-memory-used') {
      s.messages.push({ role: 'assistant', kind: 'memory', count: Number(data.count) || 0, items: Array.isArray(data.items) ? data.items.map(String) : [] });
    } else if (t === 'agent-context-used') {
      s.messages.push({ role: 'assistant', kind: 'context', count: Number(data.count) || 0, files: Array.isArray(data.files) ? data.files.map(String) : [] });
    } else if (t === 'agent-rl-decision') {
      s.messages.push({ role: 'assistant', kind: 'rl', turnId: String(data.turnId), label: String(data.label), armId: String(data.armId), mode: data.mode === 'exploit' ? 'exploit' : 'explore', context: String(data.context), arms: Array.isArray(data.arms) ? data.arms : [], totalPulls: Number(data.totalPulls) || 0 });
    } else if (t === 'agent-approval') {
      closeLive(s, info);
      s.messages.push({ role: 'assistant', kind: 'approval', author: 'version_control_agent', description: data.description, status: 'pending' });
    } else if (t === 'agent-approval-result') {
      const item = [...s.messages].reverse().find(m => m.kind === 'approval' && m.status === 'pending');
      if (item) { item.status = data.approved ? 'approved' : 'denied'; }
    } else if (t === 'agent-error') {
      closeLive(s, info);
      s.messages.push({ role: 'error', text: data.message });
    } else if (t === 'agent-done') {
      closeLive(s, info);
      for (const m of s.messages) { if (m.kind === 'tool' && m.status === 'running') { m.status = 'interrupted'; } if (m.kind === 'approval' && m.status === 'pending') { m.status = 'denied'; } if (m.final === false) { m.final = true; } }
      if (info.tools || info.agents.size > 1) {
        s.messages.push({ role: 'assistant', kind: 'summary', ms: Date.now() - info.start, tools: info.tools, agents: [...info.agents] });
      }
      running.delete(s.id); delete runInfo[s.id];
    } else { return; }
    s.updatedAt = Date.now();
    if (state.view === 'chat' && state.current === s.id) {
      const input = document.getElementById('prompt');
      if (input) { state.draft = input.value; }
      scheduleRender();
    } else if (state.view === 'home') { scheduleRender(); } else { persist(); }
  }

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data.type !== 'string') { return; }
    if (data.type === 'agent-config') {
      config = { provider: String(data.provider || ''), model: String(data.model || ''), workspace: String(data.workspace || ''), hasKey: !!data.hasKey, error: String(data.error || '') };
      render(); return;
    }
    if (data.type === 'rl-update') {
      for (const s of state.sessions) {
        const m = s.messages.find(x => x.kind === 'rl' && x.turnId === data.turnId);
        if (m && data.failed) { m.update = { failed: true }; scheduleRender(); }
        else if (m) { m.update = { reward: Number(data.reward), source: data.source, label: String(data.label), qBefore: Number(data.qBefore), qAfter: Number(data.qAfter), arms: data.arms || m.arms }; scheduleRender(); }
      }
      return;
    }
    if (data.type.startsWith('agent-')) { onAgentEvent(data); }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
