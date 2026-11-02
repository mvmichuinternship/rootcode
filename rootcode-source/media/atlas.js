/* Rootcode Atlas: dependency graph (canvas, no external deps).
 *
 * Two levels so big repos stay readable:
 *   clusters  one bubble per community of files that import each other (overview, default above ~1500 files)
 *   files     individual files; scoped to chosen clusters (plus their direct neighbours) on big repos
 * Double-click a cluster to drill into its files; the view always auto-fits what it shows.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="atlas">
      <div class="bar">
        <input type="search" id="q" placeholder="Filter…" />
        <select id="mode" title="Level of detail"><option value="clusters">Clusters</option><option value="files">Files</option></select>
        <span id="scopeChip" class="chip" hidden></span>
        <label>Blast radius <input type="range" id="depth" min="1" max="5" value="2" /> <span id="depthVal">2</span></label>
        <label><input type="checkbox" id="hideIso" checked /> Hide isolated</label>
        <button id="fit">Fit</button>
        <button id="reindex">Re-index</button>
        <span class="stats" id="stats">Indexing…</span>
      </div>
      <div class="stage"><canvas id="c"></canvas><div class="legend" id="legend"></div><div class="note" id="note" hidden></div></div>
      <aside class="side" id="side"></aside>
    </div>`;
  const $ = (id) => document.getElementById(id);
  const canvas = $('c'), ctx = canvas.getContext('2d'), side = $('side');
  const EMPTY_SIDE = '<p class="empty">Click a cluster or file to inspect it. Double-click a cluster to open its files, or a file to open it in the editor.</p>';
  side.innerHTML = EMPTY_SIDE;

  // getComputedStyle forces a style recalculation; read it once and again only when the theme changes.
  let fgColor = '#ccc';
  const readTheme = () => { fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#ccc'; };
  readTheme(); new MutationObserver(() => { readTheme(); requestDraw(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id'] });
  let drawQueued = false;
  function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }

  const MAX_FILES = 1200, CLUSTER_MODE_THRESHOLD = 1500;
  const ACTIVITY = '#a78bfa';
  const palette = ['#4e9af1', '#e5734b', '#58b368', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75', '#98a5c0', '#d19a66', '#7ec8a4'];
  const colorOf = new Map();
  const colorFor = (k) => { if (!colorOf.has(k)) colorOf.set(k, palette[colorOf.size % palette.length]); return colorOf.get(k); };

  // ── data ──
  let G = null;                 // { nodes (files), edges ([s,t] indices), clusters, clusterEdges }
  let fileIdx = new Map(), clusterIdx = new Map(), clusterFiles = new Map(), clusterText = new Map();
  let fullIn = [], fullOut = [];   // adjacency by file index, for blast radius over the whole repo
  let root = '';
  // ── what is displayed ──
  let mode = 'clusters', scope = null;      // scope: Set of cluster ids, or null = everything
  let nodes = [], edges = [], byId = new Map(), adjOut = new Map(), adjIn = new Map();
  let selected = null, hover = null, blast = new Map();
  let activity = new Map(), activeClusters = new Map(), activitySeq = 0, pulseRaf = 0, pendingActivity = [];
  let view = { x: 0, y: 0, k: 1 }, alpha = 0, W = 0, H = 0;
  let userMoved = false, autoFit = false, fitTarget = 'all', frames = 0, raf = 0, pendingFocus = null;

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height; canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); requestDraw();
  }
  window.addEventListener('resize', resize);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cid = (id) => (typeof id === 'string' && id.startsWith('cluster:')) ? id.slice(8) : null;

  // ── receiving the graph ──
  function setGraph(msg) {
    root = msg.root;
    G = msg.graph;
    fileIdx = new Map(G.nodes.map((n, i) => [n.path, i]));
    clusterIdx = new Map((G.clusters || []).map((c, i) => [c.id, i]));
    clusterFiles = new Map(); clusterText = new Map();
    G.nodes.forEach((n, i) => { const c = n.cluster || '?'; (clusterFiles.get(c) || clusterFiles.set(c, []).get(c)).push(i); });
    for (const [c, fs] of clusterFiles) clusterText.set(c, fs.map((i) => G.nodes[i].path).join('\n').toLowerCase());
    fullIn = G.nodes.map(() => []); fullOut = G.nodes.map(() => []);
    for (const [s, t] of G.edges) { fullOut[s].push(t); fullIn[t].push(s); }
    const first = nodes.length === 0;
    if (first) { mode = G.nodes.length > CLUSTER_MODE_THRESHOLD ? 'clusters' : 'files'; scope = null; }
    $('mode').value = mode;
    rebuild(!first);
    for (const a of pendingActivity.splice(0)) addActivity(a);
    if (pendingFocus) { focusFile(pendingFocus); pendingFocus = null; }
  }

  // ── building the displayed graph ──
  function rebuild(preserve) {
    const old = preserve ? new Map(nodes.map((n) => [n.id, n])) : new Map();
    const prevIds = new Set(old.keys());
    const place = () => { const R = 14 * Math.sqrt(Math.max(nodes.length, 1)) + 60, a = Math.random() * 6.2832, r = R * Math.sqrt(Math.random()); return [Math.cos(a) * r, Math.sin(a) * r]; };
    let note = '';
    nodes = []; edges = [];
    if (mode === 'clusters') {
      (G.clusters || []).forEach((c) => {
        const dir = c.name.split(' (')[0];
        nodes.push({ id: 'cluster:' + c.id, kind: 'cluster', cluster: c.id, label: c.name, dir, size: c.size, r: 7 + Math.min(30, Math.sqrt(c.size) * 1.5), lc: (c.name.toLowerCase() + '\n' + (clusterText.get(c.id) || '')), vx: 0, vy: 0 });
      });
      for (const n of nodes) { const o = old.get(n.id); const [x, y] = o ? [o.x, o.y] : place(); n.x = x; n.y = y; }
      const byC = new Map(nodes.map((n) => [n.cluster, n]));
      for (const [a, b, w] of G.clusterEdges || []) { const s = byC.get(G.clusters[a].id), t = byC.get(G.clusters[b].id); if (s && t) edges.push({ s, t, w }); }
    } else {
      const hide = $('hideIso').checked;
      const deg = (i) => G.nodes[i].imports + G.nodes[i].importedBy;
      let inScope = [];
      G.nodes.forEach((n, i) => { if ((!scope || scope.has(n.cluster)) && (!hide || deg(i) > 0 || activity.has(n.path))) inScope.push(i); });
      if (inScope.length > MAX_FILES) {
        inScope = inScope.sort((a, b) => deg(b) - deg(a)).slice(0, MAX_FILES);
        note = `Showing the ${MAX_FILES} most-connected files. Drill into a cluster to see all of its files.`;
      }
      const shown = new Set(inScope);
      const ext = [];
      if (scope) {   // direct neighbours of the scoped files, so cross-cluster links stay visible (dimmed)
        const extra = new Set();
        for (const i of inScope) for (const j of [...fullOut[i], ...fullIn[i]]) if (!shown.has(j)) extra.add(j);
        ext.push(...[...extra].sort((a, b) => deg(b) - deg(a)).slice(0, 250));
      }
      for (const i of [...inScope, ...ext]) {
        const f = G.nodes[i];
        nodes.push({ id: f.path, kind: 'file', file: i, label: f.path.split('/').pop(), dir: f.dir, cluster: f.cluster, symbols: f.symbols, imports: f.imports, importedBy: f.importedBy, ext: !shown.has(i), r: 3 + Math.min(10, Math.sqrt(f.importedBy) * 1.6 + Math.sqrt(f.symbols) * 0.3), lc: f.path.toLowerCase(), vx: 0, vy: 0 });
      }
      for (const n of nodes) { const o = old.get(n.id); const [x, y] = o ? [o.x, o.y] : place(); n.x = x; n.y = y; }
      const at = new Map(nodes.map((n) => [n.file, n]));
      for (const [s, t] of G.edges) { const a = at.get(s), b = at.get(t); if (a && b) edges.push({ s: a, t: b, w: 1 }); }
    }
    byId = new Map(nodes.map((n) => [n.id, n]));
    adjOut = new Map(); adjIn = new Map();
    for (const e of edges) {
      (adjOut.get(e.s.id) || adjOut.set(e.s.id, []).get(e.s.id)).push(e.t.id);
      (adjIn.get(e.t.id) || adjIn.set(e.t.id, []).get(e.t.id)).push(e.s.id);
    }
    colorOf.clear();
    const dirs = [...new Set(nodes.map((n) => n.dir))].sort();
    dirs.forEach(colorFor);
    $('legend').innerHTML = mode === 'clusters'
      ? '<span>Bubble = a cluster of files that import each other · size = files · line = imports between clusters</span>'
      : dirs.slice(0, 12).map((d) => `<span><i style="background:${colorFor(d)}"></i>${esc(d || '.')}</span>`).join('') + (dirs.length > 12 ? `<span class="empty">+${dirs.length - 12} more</span>` : '');
    const nt = $('note'); nt.hidden = !note; nt.textContent = note;
    const chip = $('scopeChip');
    chip.hidden = !(mode === 'files' && scope);
    if (!chip.hidden) { chip.innerHTML = `Scope: ${[...scope].map((c) => esc(clusterName(c))).join(', ')} <b id="clearScope" title="Show all files">✕</b>`; $('clearScope').onclick = () => { scope = null; rebuild(true); }; }
    $('stats').textContent = `${root} · ${G.nodes.length} files · ${G.edges.length} imports · ${(G.clusters || []).length} clusters` + (mode === 'files' && scope ? ` · showing ${nodes.length}` : '');
    if (selected && !byId.has(selected)) selected = null;
    computeBlast();
    const changed = !preserve || nodes.length !== old.size || nodes.some((n) => !prevIds.has(n.id));
    alpha = !preserve ? 1 : changed ? 0.5 : alpha;
    if (changed) { userMoved = false; autoFit = true; fitTarget = activity.size ? 'activity' : 'all'; frames = 0; }
    tick();
  }
  const clusterName = (c) => ((G.clusters || [])[clusterIdx.get(c)] || {}).name || c;

  // ── force simulation: grid-bucketed repulsion + springs + gravity, velocity-clamped ──
  function step() {
    const n = nodes.length; if (!n) return;
    const CELL = 90, grid = new Map();
    for (const a of nodes) { const k = Math.floor(a.x / CELL) + ',' + Math.floor(a.y / CELL); (grid.get(k) || grid.set(k, []).get(k)).push(a); }
    const big = mode === 'clusters';
    for (const a of nodes) {
      const cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const cell = grid.get((cx + i) + ',' + (cy + j)); if (!cell) continue;
        for (const b of cell) {
          if (a === b) continue;
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 > CELL * CELL) continue;
          if (d2 < 4) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 4; }
          const f = (big ? 2400 : 900) / d2 * alpha, d = Math.sqrt(d2);
          a.vx += dx / d * f; a.vy += dy / d * f;
        }
      }
    }
    for (const e of edges) {
      const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = big ? 90 + e.s.r + e.t.r : 60, f = (d - rest) * 0.02 * alpha * (big ? Math.min(1.5, 0.5 + Math.log2(e.w + 1) * 0.15) : 1), fx = dx / d * f, fy = dy / d * f;
      e.s.vx += fx; e.s.vy += fy; e.t.vx -= fx; e.t.vy -= fy;
    }
    for (const a of nodes) {
      a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
      const sp = Math.hypot(a.vx, a.vy); if (sp > 30) { a.vx *= 30 / sp; a.vy *= 30 / sp; }   // no explosions on dense starts
      if (!a.fixed) { a.x += a.vx; a.y += a.vy; }
      a.vx *= 0.6; a.vy *= 0.6;
    }
    alpha *= n > 800 ? 0.955 : 0.985;   // big graphs cool faster: they only need a rough layout
  }
  function tick() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (alpha > 0.02) {
        step(); if (nodes.length < 600) step();
        frames++;
        if (autoFit && !userMoved && (frames === 20 || alpha <= 0.05)) { fitView(true); if (alpha <= 0.05) autoFit = false; }
        draw(); tick();
      } else { if (autoFit && !userMoved) { fitView(true); } autoFit = false; draw(); }
    });
  }

  // ── view fitting ──
  function animateTo(target) {
    const from = { ...view }, t0 = performance.now(), dur = 450;
    const stepAnim = (now) => {
      const u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3);
      view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      draw(); if (u < 1) requestAnimationFrame(stepAnim);
    };
    requestAnimationFrame(stepAnim);
  }
  function fitView(animated, only) {
    let pts = nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && !n.ext);
    if (fitTarget === 'activity' || only) {
      const hit = pts.filter((n) => only ? only.has(n.id) : n.kind === 'file' ? activity.has(n.id) : activeClusters.has(n.cluster));
      if (hit.length) pts = hit;
    }
    if (!pts.length || !W) return;
    // ignore far outliers when fitting everything: fit the 95% of nodes around the median instead of one runaway node
    if (pts.length > 40 && fitTarget !== 'activity') {
      const xs = pts.map((n) => n.x).sort((a, b) => a - b), ys = pts.map((n) => n.y).sort((a, b) => a - b), lo = Math.floor(pts.length * 0.025), hi = Math.ceil(pts.length * 0.975) - 1;
      pts = pts.filter((n) => n.x >= xs[lo] && n.x <= xs[hi] && n.y >= ys[lo] && n.y <= ys[hi]);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of pts) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    const pad = 70, w = Math.max(x1 - x0, 60), h = Math.max(y1 - y0, 60);
    const k = Math.min(fitTarget === 'activity' ? 2.4 : 3, Math.max(0.02, Math.min((W - pad * 2) / w, (H - pad * 2) / h)));
    const target = { k, x: W / 2 - (x0 + x1) / 2 * k, y: H / 2 - (y0 + y1) / 2 * k };
    if (animated) animateTo(target); else { view = target; draw(); }
  }

  // ── drawing ──
  function computeBlast() {
    blast = new Map();
    if (!selected) return;
    if (mode === 'clusters') { blast.set(selected, 0); for (const q of adjIn.get(selected) || []) blast.set(q, 1); return; }
    const start = fileIdx.get(selected); if (start === undefined) return;
    const depth = +$('depth').value, dist = new Map([[start, 0]]);
    let frontier = [start];
    for (let h = 1; h <= depth && frontier.length; h++) {
      const next = [];
      for (const p of frontier) for (const q of fullIn[p]) if (!dist.has(q)) { dist.set(q, h); next.push(q); }
      frontier = next;
    }
    for (const [i, h] of dist) blast.set(G.nodes[i].path, h);
  }
  const filterText = () => $('q').value.trim().toLowerCase();
  function isActive(n) { return n.kind === 'file' ? activity.has(n.id) : activeClusters.has(n.cluster); }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (!nodes.length) return;
    ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
    const q = filterText(), fg = fgColor, clusterMode = mode === 'clusters';
    const focus = selected || hover;
    const outs = new Set(focus ? adjOut.get(focus) || [] : []);
    const actOnly = !selected && activity.size > 0;
    const dim = (n) => (q && !n.lc.includes(q)) || (selected && !blast.has(n.id) && !outs.has(n.id)) || (actOnly && !isActive(n)) || (n.ext && !selected);
    const vx0 = -view.x / view.k - 20, vy0 = -view.y / view.k - 20, vx1 = (W - view.x) / view.k + 20, vy1 = (H - view.y) / view.k + 20;
    const vis = (x, y) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;

    // Edges: bucket by style, one stroke per bucket.
    const base = selected || q || activity.size ? 0.05 : clusterMode ? 0.3 : 0.18;
    const buckets = new Map();
    for (const e of edges) {
      if (!vis(e.s.x, e.s.y) && !vis(e.t.x, e.t.y)) continue;
      const hl = focus && (e.s.id === focus || e.t.id === focus);
      const inBlast = selected && !clusterMode && blast.has(e.s.id) && blast.has(e.t.id);
      const act = actOnly && isActive(e.s) && isActive(e.t);
      const wc = clusterMode ? Math.min(5, Math.round(Math.log2(e.w + 1))) : 0;
      const key = (hl ? (e.s.id === focus ? 'out' : 'in') : act ? 'act' : inBlast ? 'blast' : 'base') + '|' + wc;
      (buckets.get(key) || buckets.set(key, []).get(key)).push(e);
    }
    const style = { out: ['#58b368', 0.9], in: ['#e5734b', 0.9], act: [ACTIVITY, 0.8], blast: [fg, 0.55], base: [fg, base] };
    for (const [key, list] of buckets) {
      const [kind, wc] = key.split('|'), st = style[kind];
      ctx.globalAlpha = st[1]; ctx.strokeStyle = st[0]; ctx.lineWidth = (1 + Number(wc) * 0.8) / view.k; ctx.beginPath();
      for (const e of list) { ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); }
      ctx.stroke();
    }

    // Nodes: one fill per colour+state group.
    const groups = new Map();
    for (const n of nodes) {
      if (!vis(n.x, n.y)) continue;
      const gk = colorFor(n.dir) + (dim(n) ? '|d' : '|n');
      (groups.get(gk) || groups.set(gk, []).get(gk)).push(n);
    }
    for (const [gk, list] of groups) {
      ctx.globalAlpha = gk.endsWith('|d') ? 0.15 : 1; ctx.fillStyle = gk.split('|')[0]; ctx.beginPath();
      for (const n of list) { ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, 7); }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!clusterMode) for (const p of blast.keys()) {
      const n = byId.get(p); if (!n || p === selected) continue;
      ctx.strokeStyle = '#e5734b'; ctx.lineWidth = 2 / view.k; ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.stroke();
    }
    for (const p of [selected, hover]) {
      const n = p && byId.get(p); if (!n) continue;
      ctx.strokeStyle = fg; ctx.lineWidth = 2 / view.k; ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.stroke();
    }
    // agent activity rings (newest touch pulses outward for ~1.5s)
    const now = Date.now();
    for (const n of nodes) {
      const a = n.kind === 'file' ? activity.get(n.id) : activeClusters.get(n.cluster);
      if (!a) continue;
      const age = (now - a.t) / 1500;
      ctx.globalAlpha = 1; ctx.strokeStyle = ACTIVITY; ctx.lineWidth = 2.5 / view.k;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, 7); ctx.stroke();
      if (age < 1) { ctx.globalAlpha = 1 - age; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + age * 22, 0, 7); ctx.stroke(); }
    }
    // labels
    ctx.globalAlpha = 1; ctx.fillStyle = fg; ctx.font = `${11 / view.k}px sans-serif`;
    const topClusters = clusterMode ? new Set(nodes.slice().sort((a, b) => b.size - a.size).slice(0, 60).map((n) => n.id)) : null;
    const zoomedIn = view.k > 1.8, filtering = q && nodes.length < 400;
    let drawn = 0;
    for (const n of nodes) {
      if (drawn > 300 || !vis(n.x, n.y)) continue;
      const show = n.id === selected || n.id === hover || (clusterMode ? topClusters.has(n.id) && !dim(n) : (zoomedIn || filtering) && !dim(n)) || (!clusterMode && blast.size < 25 && blast.has(n.id)) || (actOnly && isActive(n) && activity.size <= 30);
      if (show) { ctx.fillText(n.label, n.x + n.r + 3, n.y + 3); drawn++; }
    }
    ctx.restore();
  }

  // ── interaction ──
  const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k }; };
  function pick(ev) {
    const p = toWorld(ev); let best = null, bd = Infinity;
    for (const n of nodes) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < Math.max(n.r + 3, 8 / view.k) && d < bd) { best = n; bd = d; } }
    return best;
  }
  let drag = null, moved = false;
  canvas.addEventListener('mousedown', (ev) => {
    moved = false; const n = pick(ev);
    drag = n ? { node: n } : { pan: true, x: ev.clientX - view.x, y: ev.clientY - view.y };
    if (n) n.fixed = true; canvas.classList.add('drag');
  });
  window.addEventListener('mousemove', (ev) => {
    if (drag) {
      moved = true; userMoved = true;
      if (drag.node) { const p = toWorld(ev); drag.node.x = p.x; drag.node.y = p.y; alpha = Math.max(alpha, 0.3); tick(); }
      else { view.x = ev.clientX - drag.x; view.y = ev.clientY - drag.y; requestDraw(); }
      return;
    }
    const n = ev.target === canvas ? pick(ev) : null;
    if ((n && n.id) !== hover) { hover = n ? n.id : null; requestDraw(); }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.node) { drag.node.fixed = false; if (!moved) select(drag.node.id); }
    else if (!moved) select(null);
    drag = null; canvas.classList.remove('drag');
  });
  canvas.addEventListener('dblclick', (ev) => {
    const n = pick(ev); if (!n) return;
    if (n.kind === 'cluster') drillInto(new Set([n.cluster])); else vscode.postMessage({ type: 'open', path: n.id });
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault(); userMoved = true;
    const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const k = Math.min(8, Math.max(0.02, view.k * Math.exp(-ev.deltaY * 0.0015)));
    view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k; requestDraw();
  }, { passive: false });
  $('q').addEventListener('input', requestDraw);
  $('depth').addEventListener('input', () => { $('depthVal').textContent = $('depth').value; computeBlast(); requestDraw(); if (selected && !cid(selected)) renderSide(lastDetail); });
  $('hideIso').addEventListener('change', () => { if (G) rebuild(true); });
  $('mode').addEventListener('change', () => { mode = $('mode').value; if (mode === 'clusters') scope = null; selected = null; renderEmpty(); rebuild(false); });
  $('fit').addEventListener('click', () => { userMoved = false; fitTarget = 'all'; fitView(true); });
  $('reindex').addEventListener('click', () => { $('stats').textContent = 'Re-indexing…'; vscode.postMessage({ type: 'reindex' }); });

  function drillInto(clusters) {
    mode = 'files'; scope = new Set(clusters); $('mode').value = 'files'; selected = null; renderEmpty();
    rebuild(false);
  }
  function focusFile(p) {
    const i = fileIdx.get(p); if (i === undefined) return;
    if (!byId.has(p) || mode === 'clusters') { drillInto(new Set([G.nodes[i].cluster])); }
    select(p);
    const n = byId.get(p); if (n) { fitTarget = 'all'; fitView(true, new Set([p])); }
  }

  // ── side panel ──
  let lastDetail = null;
  const renderEmpty = () => { side.innerHTML = activity.size ? '' : EMPTY_SIDE; if (activity.size) renderActivity(); };
  function select(id) {
    selected = id; lastDetail = null; computeBlast(); requestDraw();
    if (!id) { renderEmpty(); return; }
    if (cid(id)) { renderCluster(cid(id)); return; }
    side.innerHTML = `<h3>${esc(id)}</h3><p class="muted">Loading…</p>`;
    vscode.postMessage({ type: 'detail', path: id });
  }
  const fileList = (title, paths, extra) => paths.length ? `<h4>${title} (${paths.length})</h4><ul>${paths.map((p) => `<li data-path="${esc(p.path || p)}">${esc(p.path || p)}${extra ? `<small>${extra(p)}</small>` : ''}</li>`).join('')}</ul>` : '';
  const refList = (label, items) => items.length ? `<details><summary>${label} (${items.length})</summary><ul>${items.map((i) => `<li data-path="${esc(i.path)}" data-line="${i.line}">${esc(i.name)}<small>${i.kind} · ${esc(i.path.split('/').pop())}</small></li>`).join('')}</ul></details>` : '';
  function renderSide(d) {
    if (!d || d.path !== selected) return;
    const depth = +$('depth').value, br = d.blast.filter((b) => b.hops <= depth);
    side.innerHTML = `<h3>${esc(d.path)}</h3>
      <div class="muted">${d.symbols.length} symbols · imports ${d.imports.length} · imported by ${d.importedBy.length}</div>
      ${fileList(`Blast radius ≤${depth} hops`, br, (b) => `${b.hops} hop${b.hops > 1 ? 's' : ''}`)}
      ${fileList('Imports', d.imports)}${fileList('Imported by', d.importedBy)}
      ${d.symbols.length ? `<h4>Symbols</h4>` + d.symbols.map((s) => `<details><summary data-path="${esc(d.path)}" data-line="${s.line}" title="${esc(s.signature || '')}">${esc(s.name)} <small class="muted">${s.kind}</small></summary>${refList('Used by', s.callers) || '<div class="empty">No callers found</div>'}${refList('Depends on', s.callees)}</details>`).join('') : ''}`;
  }
  function renderCluster(c) {
    const info = (G.clusters || [])[clusterIdx.get(c)]; if (!info) return;
    const files = (clusterFiles.get(c) || []).slice().sort((a, b) => G.nodes[b].importedBy - G.nodes[a].importedBy);
    const users = (G.clusters || []).filter((o) => o.dependsOn.includes(c));
    const cl = (o) => `<li data-cluster="${esc(o.id)}">${esc(o.name)}<small>${esc(o.id)}</small></li>`;
    side.innerHTML = `<h3>${esc(info.name)}</h3><div class="muted">${esc(info.id)} · ${info.size} files</div>
      <p><button id="drill">Open its files</button></p>
      ${info.dependsOn.length ? `<h4>Depends on (${info.dependsOn.length})</h4><ul>${info.dependsOn.map((d) => cl((G.clusters || [])[clusterIdx.get(d)] || { id: d, name: d })).join('')}</ul>` : ''}
      ${users.length ? `<h4>Used by (${users.length})</h4><ul>${users.map(cl).join('')}</ul>` : ''}
      <h4>Most-imported files</h4><ul>${files.slice(0, 15).map((i) => `<li data-path="${esc(G.nodes[i].path)}">${esc(G.nodes[i].path)}<small>${G.nodes[i].importedBy} importers</small></li>`).join('')}</ul>`;
    $('drill').onclick = () => drillInto(new Set([c]));
  }
  side.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-path],[data-cluster]'); if (!el) return;
    if (el.dataset.cluster) { if (mode === 'clusters') { select('cluster:' + el.dataset.cluster); } else { drillInto(new Set([el.dataset.cluster])); } return; }
    if (el.tagName === 'SUMMARY' || el.dataset.line) { vscode.postMessage({ type: 'open', path: el.dataset.path, line: +el.dataset.line || undefined }); return; }
    focusFile(el.dataset.path);
  });

  // ── agent activity ──
  function addActivity(m) {
    if (!G) { pendingActivity.push(m); return; }
    if (m.reset) { activity = new Map(); activeClusters = new Map(); }
    const now = Date.now();
    for (const p of m.paths) {
      const i = fileIdx.get(p); if (i === undefined) continue;
      activity.set(p, { t: now, order: ++activitySeq, label: m.label });
      const c = G.nodes[i].cluster, a = activeClusters.get(c) || { t: now, count: 0 };
      a.t = now; a.count++; activeClusters.set(c, a);
    }
    if (!activity.size) return;
    // Zoom in on where the agent is: a few touched clusters open as files; many stay as an overview with rings.
    const touched = new Set([...activeClusters.keys()]);
    const needDrill = mode === 'clusters' ? touched.size <= 3 : scope && [...touched].some((c) => !scope.has(c));
    if (needDrill && touched.size <= 4) { drillInto(touched); fitTarget = 'activity'; }
    else if (mode === 'files' && scope && touched.size > 4) { mode = 'clusters'; scope = null; $('mode').value = 'clusters'; rebuild(false); }
    else if (mode === 'files' && !byId.has([...activity.keys()].pop())) { rebuild(true); }
    selected = null; computeBlast(); fitTarget = 'activity'; userMoved = false; autoFit = true; frames = Math.max(frames, 15);
    fitView(true); pulseLoop(); renderActivity(); requestDraw();
  }
  function pulseLoop() {
    if (pulseRaf) return;
    const loop = () => {
      pulseRaf = 0;
      const last = Math.max(0, ...[...activity.values()].map((a) => a.t));
      if (Date.now() - last < 1600) { draw(); pulseRaf = requestAnimationFrame(loop); } else draw();
    };
    pulseRaf = requestAnimationFrame(loop);
  }
  function renderActivity() {
    if (selected) return;
    if (!activity.size) { side.innerHTML = EMPTY_SIDE; return; }
    const rows = [...activity].sort((a, b) => b[1].order - a[1].order);
    side.innerHTML = `<h3>Agent activity</h3><div class="muted">${rows.length} file${rows.length > 1 ? 's' : ''} in ${activeClusters.size} cluster${activeClusters.size > 1 ? 's' : ''} touched this run</div><p><button id="clearAct">Clear highlight</button></p><ul>${rows.map(([p, a]) => `<li data-path="${esc(p)}">${esc(p)}<small>${esc(a.label)}</small></li>`).join('')}</ul>`;
    $('clearAct').onclick = () => { activity = new Map(); activeClusters = new Map(); renderEmpty(); requestDraw(); };
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'graph') setGraph(m);
    else if (m.type === 'detail') { lastDetail = m; renderSide(m); }
    else if (m.type === 'focus') { if (G) focusFile(m.path); else pendingFocus = m.path; }
    else if (m.type === 'activity') addActivity(m);
    else if (m.type === 'error') app.innerHTML = `<div class="err">${esc(m.message)}</div>`;
  });
  resize();
  vscode.postMessage({ type: 'ready' });
})();
