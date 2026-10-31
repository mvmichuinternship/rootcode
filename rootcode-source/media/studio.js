/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const tuningSteps = ['Collecting data', 'Cleansing data', 'Transforming data', 'Preparing dataset', 'Sending to fine-tuning pipeline'];
  const taskSteps = ['Understanding task', 'Planning workflow', 'Preparing agent handoff'];
  const descriptions = ['Gather repository context and engineering history.', 'Remove duplicates, noise, and sensitive content.', 'Normalize examples into a consistent structure.', 'Assemble and validate the training dataset.', 'Hand the prepared dataset to the training pipeline.'];
  const saved = vscode.getState();
  const state = { view: 'home', tuning: 'idle', task: 'idle', step: -1, messages: [], draft: '', ...saved };
  let busy = false;
  if (state.tuning === 'running') { state.tuning = 'cancelled'; }
  if (state.task === 'running') { state.task = 'cancelled'; }
  const app = document.getElementById('app');
  const icon = name => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const persist = () => vscode.setState(state);

  function render() {
    persist();
    app.innerHTML = `<div class="shell">
      <header class="topbar"><div class="brand">${icon('circuit-board')}<strong>Rootcode</strong><span class="divider"></span><span class="muted">Studio</span></div><span class="badge">${icon('beaker')} Interface preview</span></header>
      <main>${state.view === 'home' ? home() : state.view === 'tuning' ? tuning() : chat()}</main>
      <footer><span><span class="status-dot"></span> Local demo</span><span>No external services connected</span></footer>
    </div>`;
    app.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action)));
    const form = document.getElementById('chat-form');
    const input = document.getElementById('prompt');
    if (form && input) {
      input.value = state.draft;
      input.addEventListener('input', () => {
        state.draft = input.value;
        document.getElementById('send').disabled = busy || !input.value.trim();
        persist();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
      });
      form.addEventListener('submit', event => { event.preventDefault(); send(); });
    }
    const log = document.getElementById('messages');
    if (log) { log.scrollTop = log.scrollHeight; }
  }

  function home() {
    return `<section class="home"><div class="eyebrow">YOUR WORKSPACE, IN CONTEXT</div><h1>Rootcode</h1><p class="lead">What are we working on?</p>
      <div class="actions">
        <button class="action-tile" data-action="tuning"><span class="tile-icon tuning-icon">${icon('settings-gear')}</span><span class="tile-copy"><strong>Fine-tuning</strong><span>Prepare your codebase for a personalized model.</span></span>${icon('arrow-right')}</button>
        <button class="action-tile" data-action="task"><span class="tile-icon task-icon">${icon('comment-discussion')}</span><span class="tile-copy"><strong>Start with a task</strong><span>Bring a task to your agent workflow.</span></span>${icon('arrow-right')}</button>
      </div><div class="notice">${icon('info')}<span>Fine-tuning runs remotely on your configured provider (Fireworks or Baseten). The task workflow is a demo and does not change files.</span></div>
      <div class="workspace-strip">${icon('repo')}<span>Codebase context</span><span class="muted">Not indexed</span></div>
    </section>`;
  }

  function heading(title, subtitle) {
    return `<div class="page-heading"><button class="icon-button" data-action="home" title="Back to home" aria-label="Back to home">${icon('arrow-left')}</button><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>`;
  }

  function tuning() {
    const running = state.tuning === 'running';
    const complete = state.tuning === 'complete';
    const done = complete ? 5 : Math.max(0, state.step);
    return `<section class="flow">${heading('Fine-tuning', 'From repository context to a training-ready dataset.')}<div class="section-label"><span>PREPARATION PIPELINE</span><span class="badge">Demo run</span></div>
      <div class="progress-summary"><strong>${complete ? 'Ready for pipeline handoff' : running ? tuningSteps[state.step] : state.tuning === 'cancelled' ? 'Run cancelled' : 'Ready when you are'}</strong><span>${done} / 5 stages</span></div>
      <progress max="5" value="${done}" aria-label="Fine-tuning preparation progress"></progress>
      <ol class="pipeline" aria-label="Preparation stages">${tuningSteps.map((label, index) => {
        const status = complete || (running && index < state.step) ? 'done' : running && index === state.step ? 'active' : 'pending';
        return `<li class="stage ${status}"><span class="stage-mark">${status === 'done' ? icon('check') : status === 'active' ? icon('loading') : index + 1}</span><div><strong>${label}</strong><p>${descriptions[index]}</p></div><span class="stage-status">${status === 'done' ? 'Complete' : status === 'active' ? 'In progress' : 'Pending'}</span></li>`;
      }).join('')}</ol>
      <div class="notice ${complete ? 'success' : ''}" role="status">${icon(complete ? 'pass' : 'info')}<span>${complete ? 'Demo handoff complete. No data was collected or uploaded. The fine-tuning pipeline is not connected.' : 'Simulated stages only. No repository files are read, modified, or sent anywhere.'}</span></div>
      <div class="flow-actions"><span class="muted">${running ? 'Preparation in progress' : complete ? 'Final stage reached' : 'Five stages. One pipeline.'}</span><button class="${running ? 'secondary' : 'primary'}" data-action="${running ? 'cancel' : 'run-tuning'}">${icon(running ? 'debug-stop' : complete ? 'refresh' : 'play')}${running ? 'Cancel run' : complete || state.tuning === 'cancelled' ? 'Run again' : 'Start preparation'}</button></div>
    </section>`;
  }

  function chat() {
    return `<section class="chat">${heading('Start with a task', 'A conversation with your codebase in mind.')}<div class="chat-meta"><span>${icon('hubot')} Rootcode agent</span><span class="badge">Demo workflow</span><button class="icon-button" data-action="clear" title="New conversation" aria-label="New conversation" ${busy ? 'disabled' : ''}>${icon('new-file')}</button></div>
      <div id="messages" class="messages" role="log" aria-label="Conversation" aria-live="polite">${state.messages.length ? state.messages.map(message => `<article class="message ${message.role}"><span class="avatar">${icon(message.role === 'user' ? 'account' : 'hubot')}</span><div><strong>${message.role === 'user' ? 'You' : 'Rootcode'}</strong><p>${escape(message.text)}</p></div></article>`).join('') : `<div class="empty-chat">${icon('comment-discussion')}<h2>What would you like to work on?</h2><p class="muted">Your next task starts here.</p><div class="suggestions"><button class="secondary" data-action="suggest-review">Review the project structure</button><button class="secondary" data-action="suggest-tests">Plan tests for a feature</button></div></div>`}</div>
      ${state.task !== 'idle' ? `<div class="workflow-status" role="status">${icon(busy ? 'loading' : state.task === 'complete' ? 'check' : 'debug-stop')}<span>${busy ? taskSteps[state.step] : state.task === 'complete' ? 'Demo workflow complete' : 'Workflow cancelled'}</span>${busy ? '<button class="icon-button" data-action="cancel" title="Stop workflow" aria-label="Stop workflow">' + icon('debug-stop') + '</button>' : ''}</div>` : ''}
      <form id="chat-form" class="composer"><label class="sr-only" for="prompt">Describe your task</label><textarea id="prompt" rows="3" maxlength="8000" placeholder="Describe your task..." ${busy ? 'disabled' : ''}></textarea><div class="composer-bottom"><span class="muted">${icon('lock')} Local demo</span><button id="send" class="primary icon-button" type="submit" title="Send task" aria-label="Send task" ${busy || !state.draft.trim() ? 'disabled' : ''}>${icon('arrow-up')}</button></div></form>
      <p class="chat-disclaimer">Simulated workflow. No model calls or file changes.</p></section>`;
  }

  function action(name) {
    if (name === 'tuning') {
      vscode.postMessage({ type: 'open-trainer' });
    } else if (name === 'home' || name === 'task') {
      if (busy) { vscode.postMessage({ type: 'cancel' }); busy = false; state[state.view] = 'cancelled'; }
      state.view = name;
      render();
    } else if (name === 'run-tuning' && !busy) {
      busy = true; state.tuning = 'running'; state.step = 0;
      vscode.postMessage({ type: 'start', kind: 'tuning' }); render();
    } else if (name === 'cancel') {
      vscode.postMessage({ type: 'cancel' });
    } else if (name === 'clear' && !busy) {
      state.messages = []; state.task = 'idle'; state.draft = ''; render();
    } else if (name.startsWith('suggest-')) {
      state.draft = name === 'suggest-review' ? 'Review the project structure and suggest improvements.' : 'Help me plan tests for a new feature.';
      render(); document.getElementById('prompt').focus();
    }
  }

  function send() {
    const prompt = state.draft.trim();
    if (busy || !prompt || prompt.length > 8000) { return; }
    state.messages.push({ role: 'user', text: prompt });
    state.draft = ''; state.task = 'running'; state.step = 0; busy = true;
    vscode.postMessage({ type: 'start', kind: 'task', prompt }); render();
  }

  window.addEventListener('message', ({ data }) => {
    if (!data || !['tuning', 'task'].includes(data.kind)) { return; }
    if (data.type === 'progress') {
      state[data.kind] = 'running'; state.step = data.step; busy = true;
    } else if (data.type === 'complete' || data.type === 'cancelled') {
      state[data.kind] = data.type; busy = false;
      if (data.kind === 'task') { state.messages.push({ role: 'assistant', text: data.type === 'complete' ? data.message : 'Workflow stopped. No files were changed.' }); }
    } else { return; }
    render();
  });
  render();
})();