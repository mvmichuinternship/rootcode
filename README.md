# Rootcode

Rootcode is a VS Code extension that builds a **living dependency graph of your codebase**, uses it to give coding agents a **structured, deterministic context** (instead of RAG or keyword search), **fine-tunes a LoRA on your own repository's history**, and **learns from how you use the agents' output** (edits, errors, tests, git reverts, thumbs up/down).

> Setup, environment variables and run instructions are in **[SETUP.md](SETUP.md)**.

---

## Contents

1. [What is in this repository](#1-what-is-in-this-repository)
2. [How it fits together](#2-how-it-fits-together)
3. [The extension and the Studio UI](#3-the-extension-and-the-studio-ui)
4. [The agents](#4-the-agents)
5. [Models and providers](#5-models-and-providers)
6. [Fine-tuning on your codebase](#6-fine-tuning-on-your-codebase)
7. [Learning from use: Rootcode Recall and the RL strategy policy](#7-learning-from-use-rootcode-recall-and-the-rl-strategy-policy)
8. [Atlas: structured deterministic context](#8-atlas-structured-deterministic-context)
9. [The dependency graph panel](#9-the-dependency-graph-panel)
10. [Cluster workers: splitting work by graph cluster](#10-cluster-workers-splitting-work-by-graph-cluster)
11. [Prompt layout for caching](#11-prompt-layout-for-caching)
12. [Performance work](#12-performance-work)
13. [Reference: commands, settings, agent tools, events](#13-reference-commands-settings-agent-tools-events)
14. [Where data is stored](#14-where-data-is-stored)
15. [Security model](#15-security-model)
16. [Verification status and measured numbers](#16-verification-status-and-measured-numbers)
17. [Known limitations and not-yet-built](#17-known-limitations-and-not-yet-built)
18. [Lineage: how Atlas relates to code-atlas-mcp and the design doc](#18-lineage)
19. [Project history](#19-project-history)

---

## 1. What is in this repository

```
rootcode/
├── README.md                    this file
├── SETUP.md                     clone -> build -> configure -> run
├── rootcode-source/             the VS Code extension (TypeScript, bundled with esbuild)
│   ├── src/
│   │   ├── extension.ts         activation, commands, webview wiring
│   │   ├── workflow.ts          legacy simulated workflow runner (kept for the tuning/task stubs)
│   │   ├── agents/              Google ADK agents, tools, prompts, model client, env resolution
│   │   ├── atlas/               structured deterministic context (index, graph, git, LSP, scorer, clusters, UI panel)
│   │   ├── memory/              Rootcode Recall (failure memory) + RL strategy policy
│   │   └── providers/           fine-tuning panel (TrainerPanel)
│   ├── media/                   webview assets: studio.js/css (chat UI), atlas.js/css (graph UI), codicons
│   ├── resources/               bundled repo2lora wheel (dataset generation)
│   ├── .env.example             every environment variable the extension reads
│   └── rootcode-<version>.vsix  packaged builds
├── muse-lora-trainer/           Node library: LoRA training/deploy clients for Baseten and Fireworks (no VS Code dependency)
└── repo2lora-components/        repo2lora wheel + a helper script to install it into a venv
```

Two sibling projects outside this repository fed into it (see [section 18](#18-lineage)): `repo2lora` (git history → LoRA dataset; its built wheel is vendored here) and `code-atlas-mcp` (the MCP server whose graph logic Atlas re-implements inside the extension).

---

## 2. How it fits together

```
                               ┌───────────────────────── VS Code ─────────────────────────┐
  you ── chat / Studio ───────▶│  Studio webview (media/studio.js)   Atlas graph panel       │
                               │            │  postMessage                │ postMessage       │
                               │            ▼                             ▼                   │
                               │      extension.ts  ─────────────▶  AtlasPanel                │
                               │            │                                                │
                               │            ▼                                                │
                               │      AgentService ──────────── RL policy ◀── Recall memory  │
                               │      (Google ADK)   picks strategy   records outcomes       │
                               │            │                                                │
                               │            │ per turn: buildForQuery()                       │
                               │            ▼                                                │
                               │   IndexOrchestrator  (Atlas)                                 │
                               │   ├─ AtlasIndex      symbols · imports · calls (in memory)   │
                               │   ├─ GitTimelineIndex  recent files · co-change             │
                               │   ├─ LSPBridge       diagnostics · definition · hover       │
                               │   ├─ EntryPointResolver → GraphTraversalEngine → Scorer     │
                               │   └─ clusters        communities of the import graph        │
                               └────────────────────────────────┬───────────────────────────┘
                                                                │ OpenAI-compatible HTTPS
                                          Baseten / Fireworks model APIs  (base model or your LoRA)
```

Every agent turn does this, in order:

1. **Classify** the request (`debug`, `refactor`, `explain`, `generate`, `unknown`).
2. **RL policy** picks a working strategy (Survey first / Minimal diff / Verify first / Plan then act). The strategy sets a prompt hint **and** how much graph context to build.
3. **Atlas** resolves entry points (active file, errors, stack traces, git, symbols, tabs…), traverses the dependency graph, scores candidates, and renders a budgeted context block.
4. **Recall** adds lessons from past similar failures, re-ranked by the dependency neighbourhood of this request.
5. The **agents** run with that context plus graph tools. Writes are checked against the language server on the spot.
6. The outcome (your edits, diagnostics, tests, git reverts, thumbs) feeds back into the RL policy, the memory, and the context scorer.

---

## 3. The extension and the Studio UI

- **Activity-bar container "Rootcode"** with a webview view (`rootcode.welcome`) and an editor-tab panel (**Rootcode: Open Studio**).
- **Home screen:** *Start with a task* (opens an agent chat) and *Fine-tune on your codebase* (opens the trainer panel).
- **Chat view** renders the full agent run live: model thinking, tool calls with arguments/results/duration, agent hand-offs, approval prompts, and a run summary. Three coloured cards sit inline:
  - **Rootcode RL** (purple): which strategy the policy chose, whether it is *exploring* or *exploiting*, the Q-value and pull count of every strategy, and the 👍/👎 buttons.
  - **Rootcode Recall** (teal): how many lessons from past sessions were applied.
  - **Rootcode Atlas** (violet): how many files the dependency graph put in context, with a **Show in graph** button.
- A **Graph** button in the Studio header opens the dependency graph.
- The agents are also reachable as a **chat participant** (`@rootcode`, sticky) in VS Code's chat panel, using the same agents.
- Webviews use a strict CSP (nonce'd scripts, no external resources), bundled Codicons, and VS Code theme variables. Prompts are limited to 8,000 characters.

`src/workflow.ts` is the original simulated workflow runner from the first prototype; the real agent path is `AgentService`.

---

## 4. The agents

Built on **Google ADK** (`@google/adk`). Agent tree:

```
rootcode_agent                 orchestrator: answers simple questions, routes the rest
├── dev_workflow               SequentialAgent
│   ├── developer_agent        explores + writes code           tools: read, write, graph, clusters
│   ├── qa_agent               verifies in a Docker sandbox     tools: run_in_sandbox, read, write
│   └── version_control_agent  branch + commit + push           tools: git_* (push needs approval)
└── pr_review_agent            reviews GitHub PRs               tools: read + GitHub MCP
```

- **Tools**
  - *Workspace:* `list_files`, `read_file` (200 KB cap), `search_code` (substring, 50 hits), `write_file`.
  - *Graph (Atlas):* `find_symbol`, `get_dependencies`, `trace_symbol`, `get_context`.
  - *Clusters (developer only):* `plan_clusters`, `run_cluster_workers`.
  - *Sandbox:* `run_in_sandbox` runs a command inside a throwaway Docker container on a copy of the workspace (no network, 2 GB RAM, 2 CPUs, 512 pids, no `.git`, no secrets, nothing written back).
  - *Git:* `git_status`, `git_diff`, `git_create_branch`, `git_commit` (secrets excluded from staging), `git_push` (**modal human approval required**).
  - *GitHub MCP* for the PR agent (`context,repos,pull_requests` toolsets by default).
- **Streaming:** token/thought streaming over SSE; disable with `ROOTCODE_STREAM=false`.
- **Sessions:** each chat thread is an independent ADK session; runs can be cancelled.
- **Approval flow:** tools marked `requireConfirmation` pause the run and show a modal; the answer resumes it.

---

## 5. Models and providers

All model calls go through `OpenAICompatLlm` (an ADK `BaseLlm` over OpenAI-compatible chat completions). Provider, model, key and URL are **re-read from the environment on every call**, so editing `.env` takes effect without a reload.

| Group | Default provider | Default model | Env prefix |
|---|---|---|---|
| Main agents (orchestrator, developer, QA, VCS) | Baseten | `meta-models/muse-spark-open-1026` | `ROOTCODE_` |
| PR review agent | Fireworks | your fine-tuned model (set `PR_REVIEW_MODEL`) | `PR_REVIEW_` |

- Supported providers today: **Baseten** and **Fireworks**.
- `ROOTCODE_MODEL_SOURCE=trained-endpoint` (or the setting `rootcode.agent.modelSource`) makes the main agents use the LoRA deployment saved by the trainer in `.repo2lora/rootcode-endpoint.json`.
- Baseten dedicated deployments (`*.api.baseten.co`) use `Api-Key` auth; everything else uses Bearer.
- `reasoning_effort` is sent only for Muse Spark Open on Baseten (the only model documented to accept it).

---

## 6. Fine-tuning on your codebase

The **LoRA: Start Fine-Tuning Job** / "Fine-tune on your codebase" flow (`TrainerPanel`) has three stages:

1. **Generate dataset** — installs the vendored **repo2lora** wheel into a private venv (in the extension's global storage) and runs it against your repository. repo2lora mines git history into `.repo2lora/dataset/{train,val}.jsonl`: bug fixes, refactors and feature implementations (per-hunk before/after, classified by commit message), test generation (commits adding `test_foo.*` next to `foo.*`), docstring generation (Python AST) and code review (GitHub PR review comments). It validates, scores, de-duplicates (rename-insensitive simhash), caps per task and splits by commit/PR/file.
2. **Train** — `muse-lora-trainer` drives the provider:
   - **Baseten:** generates a Truss training project, launches the job on your chosen GPU(s) (4-bit loading optional), polls it, and optionally deploys the adapter.
   - **Fireworks:** *serverless* (cookbook-based, optional download of the adapter) or *managed* training, polling, and optional deployment.
3. **Deploy and use** — on success the endpoint is saved to `<repo>/.repo2lora/rootcode-endpoint.json`; setting the model source to `trained-endpoint` points the agents at it. **LoRA: Check Job Status** re-checks the last job.

Hyper-parameters come from `.env` (`LORA_RANK`, `LORA_LEARNING_RATE`, `LORA_EPOCHS`, `LORA_MAX_SEQ_LEN`, …) or the `loraTrainer.*` settings — full list in [SETUP.md](SETUP.md#5-environment-variables).

---

## 7. Learning from use: Rootcode Recall and the RL strategy policy

Two cooperating mechanisms, both in `src/memory/`:

### 7.1 Implicit feedback (`SuggestionTracker`, `ImplicitRewardComputer`)

After each agent turn the tracker watches the workspace for a window (default 5 minutes, `rootcode.memoryTrackingWindowMs`): how much you edited the agent's output (edit distance), the **diagnostic delta** (errors after − before), whether tests ran and passed (VS Code tasks), and whether the change was **reverted in git**. These become a reward in [−1, 1]:

```
base   = accepted as-is ? +1.0 : −editDistance
reward = clamp(base + diagnostics(−1 → +0.3, +1 → −0.4) + tests(pass +0.2, fail −0.3) + gitRevert(−0.5), −1, 1)
```

### 7.2 Rootcode Recall — cross-session failure memory

Every finished turn is stored (up to 200, weakest signals pruned first) with its reward, a failure reason and a deterministic, code-free lesson pattern ("avoid X → prefer Y", with an observed count). When a similar request comes up, `MemoryInjector` retrieves strongly-rewarded memories (|reward| > 0.3) and renders **AVOID / PREVIOUSLY FAILED / WORKED WELL** lessons (capped at about 6,000 characters).

Relevance scoring: same entry file +3, same query type +2, same directory +1, failures +1, last week +0.5 — and, new, **dependency neighbourhood**: +2 if the memory's entry file is among the files Atlas put in context for this request, +1.5 if it referenced any of them. The first message of a conversation gets lessons through the session state; **follow-up turns re-rank per turn** using the neighbourhood.

Commands: **Show Agent Memory (Recall)**, **Open Agent Memory File**, **Clear Agent Memory**. Toggle with `rootcode.memory.enabled`.

### 7.3 RL strategy policy (`RlPolicy`) — where exploration/exploitation happens

A **contextual bandit** that chooses *how the agent works*, not which files it reads.

- **Arms** (each is a prompt hint *and* a context recipe):

  | Arm | Hint (summary) | Graph hops | Max files | Token budget |
  |---|---|---|---|---|
  | Survey first | start from the injected context, widen with graph tools, read related files first | 3 | 16 | ×1.5 |
  | Minimal diff | smallest change that satisfies the request | 1 | 6 | ×0.6 |
  | Verify first | decide verification up front; fix every `check.errors` after each write | 2 | 10 | ×1 |
  | Plan then act | brief numbered plan, then execute | 2 | 12 | ×1 |

- **Context** (one table per context): the query type, plus `+errors` when the active file currently has compiler errors (e.g. `debug+errors`).
- **Selection — UCB1:** `score = q + 0.6 · √( ln(total + 1) / n )`. An arm with `n = 0` scores ∞ so every arm is tried once first; afterwards the second term keeps under-tried arms in play. The card shows **explore** when the pick is untried or its `q` is below the best `q`, otherwise **exploit**.
- **Update:** on the first reward for a turn `n += 1`; always `q += (reward − q) · max(1/n, 0.1)` — a plain average for the first 10 pulls, then an exponential moving average so the policy keeps adapting.
- **Rewards:** your 👍/👎 (immediate) or the implicit reward when the window closes. An explicit click after the implicit reward still nudges `q`; an implicit reward after an explicit click is ignored.
- **Reliability fix:** the policy keeps up to 500 past decisions so late feedback still lands, the host always answers a click, and the UI times out after 5 s with an explanatory message instead of hanging on "Updating policy…".
- Stored per workspace in the extension's global storage (`rl-policy-<hash>.json`).

---

## 8. Atlas: structured deterministic context

**Goal:** give agents the right files by following the repository's *structure* — imports, calls, inheritance, injection — instead of embeddings or keyword search. The same workspace state always produces the same candidate set and ranking.

Atlas lives in `rootcode-source/src/atlas/` and implements all nine components of the original design (see [section 18](#18-lineage) for the mapping).

### 8.1 Index (`AtlasIndex`, extractors, `resolveImports`)

- **Languages:** TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) via the **TypeScript compiler API**; Python (`.py`) via an indentation-based parser (no native/WASM parser, so it bundles cleanly).
- **Nodes:** `file`, `class`, `interface`, `method`, `function`, plus Angular-aware kinds `component`, `service`, `module`, `directive`, `pipe` (from decorators) and React components in `.tsx/.jsx`.
- **Symbol table (O(1)):** `lookupSymbol(name)` by short or qualified name, each with file, line range and a one-line **signature** (decorators stripped, body excluded) — "where is `UserAuth` defined?" with no search.
- **Edges:** `imports` (file→file), `calls`, `inherits`, `implements`, `injects` (constructor parameters and `inject(Foo)` fields), `references` (decorators, e.g. `@app.get`).
- **Call attribution:** `foo()`, `this.bar()`, `Service.run()`, `ns.fn()`, `this.svc.get()` (via constructor-parameter / property types) and `new Foo()`.
- **Import resolution:** relative paths, ESM `./x.js` → `x.ts`, `index` files, tsconfig/jsconfig `baseUrl` + `paths` (root config), Python absolute/relative imports and package `__init__.py`. Third-party/stdlib imports are dropped.
- **Cross-file linking:** edges carry `"<path>::<qualified name>"` refs resolved after all files are parsed; **barrel re-exports** are followed up to 3 hops; if a member isn't indexed the edge falls back to its owning class.
- **Ignored:** `node_modules`, `dist`, `out`, `build`, `coverage`, `.git`, `.rootcode`, virtualenvs/caches, dot-directories, files over 1 MB.
- **Cache:** per-file extraction cached in `.rootcode/atlas/index.json`, validated by `mtime + size` (then a SHA-1 only if those differ), so a warm start never re-reads unchanged files. Linking is re-run in memory (cheap) and only when a file's content actually changed.

### 8.2 Queries (`queries.ts`)

`findSymbols` (ranked name search), `getCallers`, `getCallees`, `symbolBlastRadius` (reverse calls/inherits/implements/injects, N hops), `fileNeighbors` (imports / importedBy), `traverseFiles`, `fileBlastRadius` ("what breaks if I change this file?"), `fileDependencyGraph` (for the UI).

### 8.3 Git timeline (`GitTimelineIndex`)

`git log --name-only -n 50` plus `git status`: uncommitted files first (rank 0), then newest commit first. Handles workspaces that are subfolders of the repo (strips the repo prefix). Also builds a **co-change map** — files that appear in the same commits (bulk commits over 25 files are ignored). Refreshes (debounced) on save and never triggers a graph repaint.

### 8.4 LSP bridge (`LSPBridge`)

Wraps VS Code's built-in language features, called at query time only: active file + cursor line, workspace **diagnostics** (errors/warnings with line and message), `executeDefinitionProvider`, `executeHoverProvider`, open editor tabs, selected text, and `waitForDiagnostics` (used after writes).

### 8.5 Entry-point resolver (`EntryPointResolver`)

Decides where graph traversal starts — **not** at the top of the tree, but where the evidence points:

| Priority | Source | Detail |
|---|---|---|
| 1 | Active editor | file + cursor line |
| 2 | Diagnostics | files with compile errors, most errors first |
| 2 | Stack traces | `file.ts:45:10` / `File "x.py", line 9` in the request, resolved by path suffix |
| 3 | Git | uncommitted files, then recently committed |
| 3 | Open tabs | other files open in editors |
| 4 | Query | file names / path suffixes mentioned |
| 4 | Symbols | identifiers in the request or selection looked up in the symbol table (camelCase, snake_case, qualified or long names; ≤ 3 definitions) |
| 5 | Package main | `package.json` `main` (mapped from `dist` back to source) — **only if nothing else resolved** |
| 5 | Overview | for "overview / architecture / how does this project work": package entry + the most-imported hub files |

A file hit by several sources keeps its highest-priority entry and also keeps any symbol/line detail from the weaker ones.

### 8.6 Traversal (`GraphTraversalEngine`, `focus.ts`)

- **Breadth-first** over the import graph with **independent forward/reverse depth by task type** (base 2 hops): debug 2/2, refactor 1 forward + 3 back (blast radius), explain/generate 2 forward + 1 back. RL arms override the base depth.
- **Hub damping:** a file imported by more than 25 files is included but not expanded through in reverse, so a shared utility can't flood the set. Hard cap of 60 files.
- **Siblings:** files that change together with an entry file in git, and its test file (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`).
- **Focus symbols:** the symbol under the cursor / at the failing line / named in the request, plus its direct callers and callees (≤ 8 each).
- Deterministic: sorted neighbours; output ordered by hop distance, entry priority, path. Candidates are *described*, not read.

### 8.7 Scorer (`CausalContextScorer`)

A weighted linear scorer over features of each candidate, then greedy selection within a **token budget** (default 16,000 tokens, `rootcode.atlas.tokenBudget`, scaled by the RL arm) and a top-K cap.

| Feature | Default weight | Meaning |
|---|---|---|
| `hop` | −1.0 | hop distance |
| `entryActive` / `entryStack` / `entryDiagnostic` / `entryQuery` / `entrySymbol` | 3.0 / 2.6 / 2.5 / 2.2 / 2.0 | how the file became an entry |
| `entryGit` / `entryOverview` / `entryTab` / `entryPackage` | 1.2 / 1.0 / 0.8 / 0.5 | weaker entry sources |
| `hasErrors` / `errorCount` | 2.0 / 0.3 (cap 5) | compile errors in the file |
| `recency` | 1.0 | `1 / (1 + 0.2·gitRank)` if recently changed |
| `dependency` | 0.3 | reached by following an entry's imports |
| `cochange` / `test` | 0.6 / 0.5 | git sibling / test file |
| `focus` | 0.8 | holds symbols the entry is about |
| `hub` | 0.2 | `log(1 + importedBy)` |
| `sizePenalty` | −0.3 | `log(1 + chars/4000)` |

- **Representation per file:** small files (≤ 6,000 chars) go in **full**; larger files with focus symbols go in as **focus** (bodies of the relevant symbols with line numbers + signatures of the rest — roughly a 70% saving on a big file in testing); otherwise an **outline** (signatures). Files with no extractable symbols are sent whole or skipped. The best candidate is always kept.
- **Exploration slot:** with probability 0.15 one lower-ranked file is added as an outline, flagged `explored`. The draw is **seeded by the turn id**, so a given turn is reproducible, and it lets the scorer learn about files it normally hides.
- **Learning:** every selection is logged to `.rootcode/atlas/context-log.jsonl` with its features. When a turn ends, the files the agent used are labels (**edited = 1.0, read only = 0.6, untouched = 0**) for an online logistic-regression SGD step; the implicit reward later reinforces or undoes it. Weights are kept **per query type**, with an L2 pull toward the hand-set defaults. `trainFromLog()` retrains offline. This is a bandit-style learner on usage, **not** a causal model — the `ContextScorer` interface is the swap point for a trained model.
- **Measuring:** **Rootcode: Show Context Hit Rate** reports, from the log: recall of the code files the agent used among the injected files and among all reachable files, precision of injected files, exploratory-pick hit rate, and recall per task type.

### 8.8 Orchestrator (`IndexOrchestrator`)

One object owning everything above. Builds on activation (time-sliced, background), keeps itself fresh from file watchers (debounced, only source files outside ignored directories), and exposes:

- `getContext(entryPoints, opts)` — explicit entry points → `ContextItem[]`
- `resolveAndGetContext(query, opts)` — resolver chooses the entry points
- `buildForQuery(query, turnId, opts, sessionId)` — prompt-ready block (see below)
- `checkAfterWrite(path)`, `repoMap()`, `hasActiveErrors()`, `recordUsage()`, `applyReward()`

### 8.9 How agents use it

1. **Injection.** Each turn gets a "Rootcode structured context" block: entry points with reasons, then every selected file with *why* it is there (entry source, hops, errors, recently changed, exploratory) and its content as full / focus / outline. If the files span two or more graph clusters, a cluster summary and execution order is added.
2. **Tools.** `find_symbol`, `get_dependencies`, `trace_symbol`, `get_context`. The agent instructions tell models to treat the injected context as the starting point and to prefer these over `search_code` for structure.
3. **Post-edit check.** After every `write_file`, Atlas re-indexes that file, opens it, waits for the language server to settle, and returns `check.errors` for the file **and the files that import it**, plus the importers list. The model sees this in the tool result and is told to fix it.
4. **Live highlighting.** File paths in tool calls/results stream to the graph panel (see below).
5. **Learning loop.** Used/edited files and the implicit reward train the scorer.
6. **Conversation dedupe.** Files already sent earlier in the same conversation with unchanged content become a one-line reference.

---

## 9. The dependency graph panel

Open with **Rootcode: Open Dependency Graph**, the Studio header **Graph** button, the editor-title button, the Explorer context menu (**Show File in Dependency Graph**), or the **Show in graph** button on an Atlas card.

- **Two levels, so big repos stay readable.** *Clusters* (default above ~1,500 files) shows one bubble per community of files that import each other: bubble size = files, line thickness = imports between clusters. *Files* shows individual files. Double-click a cluster (or **Open its files**) to drill into it; a scope chip shows what you are looking at and ✕ clears it. A scoped file view also shows the direct neighbours of those files, dimmed, so cross-cluster links stay visible. The all-files view is capped at the 1,200 most-connected files; drill into a cluster to see everything in it.
- **Always fits what it shows.** The view auto-fits after the layout settles (ignoring runaway outliers) until you pan or zoom; **Fit** re-fits on demand. Initial node placement scales with node count and velocities are clamped, so dense starts don't blow the layout apart.
- Colour by top-level directory, size by importers and symbols; pan, zoom, drag nodes; filter box (matches cluster names and any file inside a cluster in overview); *Hide isolated* toggle; **Re-index** button.
- **Click a file:** blast radius (reverse imports, 1–5 hops via a slider, highlighted on the canvas), imports, imported-by, and every symbol with its signature and expandable **Used by / Depends on** lists. Double-click opens the file; clicking a symbol or reference jumps to its line.
- **Live agent activity:** while an agent runs, every file it reads, searches, edits or looks up lights up with a pulsing purple ring, unrelated nodes dim and the links between touched files highlight. From the overview, if the agent works in 1–3 clusters the graph **drills into them automatically** and animates to fit the touched files (max 2.4× zoom); if it touches many clusters it stays in the overview with rings on every cluster involved. The side panel lists touched files in order. The panel opens beside the editor without stealing focus (`rootcode.atlas.autoOpen`, default on).
- **Performance:** layout and view are preserved across refreshes (re-heated only when the node set changes); edges are drawn in batches, off-screen items are culled, redraws are coalesced and the theme colour is cached.

---

## 10. Cluster workers: splitting work by graph cluster

For changes that span several areas of the codebase, the developer agent can split the work along **communities of the dependency graph** instead of one agent touching everything.

**Clustering (`clusters.ts`)** — deterministic **label propagation** over the import graph: each file starts in its own community and repeatedly adopts the label most common among its import neighbours (same-directory neighbours count extra; fixed visiting order and tie-breaks; ≤ 20 rounds). Hub files are ignored as links. Files with no usable links group by directory. Label propagation leaves many tiny groups on sparse graphs (7,262 files gave 1,285), so the smallest groups are **merged into their most-connected neighbour** (else the group sharing the longest directory prefix) until there are at most ~1.5·√files clusters and none has fewer than 3 files — 128 clusters for that repo, unchanged for small repos. Clusters are numbered `c1…` by size and named after their dominant directory; each records the other clusters it `dependsOn`. Cached per index version; deterministic across runs.

**Tools (developer agent):**

- `plan_clusters(files)` → the clusters those files fall into (id, name, files, `dependsOn`) and a safe execution order in **waves**.
- `run_cluster_workers(goal, tasks[])` → one worker per cluster (max 4, one task per cluster):
  - Each worker is a separate ADK agent with its own session, read/graph tools and a **write tool confined to its cluster** (its files, or new files next to them). A write elsewhere is rejected with an instruction to report the needed change instead — so parallel workers can never touch the same file.
  - Clusters run in **dependency order**: a cluster runs only after the clusters it depends on; independent clusters in a wave run in parallel; a dependency cycle runs as one final wave. Upstream workers' summaries are passed to downstream workers.
  - Each worker has a 5-minute timeout; results return per-cluster summaries, changed files and errors. File writes also light up the graph panel.
  - Every `write_file` inside a worker also returns the post-edit `check.errors`.

The developer's instructions tell it to use this only when the change genuinely spans 2+ clusters, then to read each summary and fix cross-cluster fallout itself.

---

## 11. Prompt layout for caching

Providers with prefix caching reuse the longest identical prefix of *tools + system prompt + history*. Everything is ordered stable → volatile (documented at the top of `src/agents/prompts.ts`):

1. **Tool definitions** — fixed order.
2. **Static instruction text** — identical across conversations. Hints (graph tools, cluster workers) are inserted here via `compose()`, *before* any session state.
3. **Session-stable state, at the end of the system prompt** — `{repo_map?}` (a compact, deterministic summary of clusters, their key files and most-imported files; unchanged until the graph changes) then `{memory_injection?}`. Previously the memory text sat at the very *start* of the prompt, which invalidated the cache for every new conversation.
4. **Per-turn user message**, in order: memory lessons → structural context → RL strategy line → the request.
5. **Append-only history:** a file already shown earlier in the conversation with unchanged content is replaced by a one-line reference, which also saves tokens.

Caching itself is provider-side and automatic for OpenAI-compatible endpoints that support it; this layout maximises hits but cache hit rates have not been measured.

---

## 12. Performance work

Measured on ~1,500 source files (standalone Node, not inside VS Code):

| Item | Before | After |
|---|---|---|
| Longest event-loop stall during a cold index | ~1.2 s (synchronous) | ~25 ms (time-sliced, 8 ms slices) |
| Warm start (nothing changed) | ~190 ms (read + hash every file) | ~100 ms (`mtime + size` check) |
| Update after a save with no content change | full relink + graph repaint | ~1 ms, nothing else |
| Agent turn context build | read up to 60 files synchronously | descriptions only; bodies read (async) for the few selected |
| Force layout | — | ~5 ms/frame at 1,228 nodes / 3,297 edges, settles in ~130 frames |
| Dependency graph on a 7,262-file / 39,114-import repo (Bitwarden clients) | blank canvas (nodes flung off-screen, no fit, unreadable) | cluster overview of 128 bubbles: 99% on-screen, 131 frames; all-files view capped at 1,200: 99% on-screen, 95 frames (~19 ms/frame); graph payload 1.6 MB (edges sent as index pairs) |

Also: watcher events for ignored folders are dropped; git refreshes never repaint the graph; the resolver/tsconfig parse is reused across relinks; cache writes are debounced.

---

## 13. Reference: commands, settings, agent tools, events

### Commands (Command Palette)

| Command | What it does |
|---|---|
| Rootcode: Open Studio | open the Studio editor panel |
| Rootcode: Open Dependency Graph | open the graph panel |
| Rootcode: Show File in Dependency Graph | focus the active/selected file in the graph |
| Rootcode: Show Context Hit Rate | report how well injected context matched what agents used |
| Rootcode: Open Agent Chat | open the chat |
| Rootcode: Set GitHub Token | store a token (secret storage) for the PR agent |
| Rootcode: Show Agent Memory (Recall) / Open Agent Memory File / Clear Agent Memory | inspect, open or wipe failure memory |
| LoRA: Start Fine-Tuning Job / Check Job Status | trainer panel / re-check last job |

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `rootcode.atlas.autoOpen` | `true` | open the graph beside the editor while agents work |
| `rootcode.atlas.tokenBudget` | `16000` | approximate token budget of injected context |
| `rootcode.agent.modelSource` | `baseten-model-api` | or `trained-endpoint` |
| `rootcode.agent.baseUrl` / `model` | empty | Baseten overrides |
| `rootcode.agent.reasoningEffort` | `medium` | Muse Spark Open on Baseten |
| `rootcode.agent.maxTokens` | `8192` | per-call output cap (incl. reasoning) |
| `rootcode.agent.sandboxImage` | `node:22-slim` | Docker image for QA runs |
| `rootcode.memory.enabled` | `true` | Recall + RL policy |
| `rootcode.memoryTrackingWindowMs` | `300000` | implicit-feedback window |
| `loraTrainer.provider` / `baseModel` / `loraRank` / `learningRate` / `epochs` | baseten / – / 16 / 0.0002 / 3 | trainer defaults |
| `loraTrainer.basetenApiKey` / `fireworksApiKey` | empty | fallback keys (prefer `.env`) |

Environment variables: see [SETUP.md](SETUP.md#5-environment-variables).

### Agent tools

`list_files`, `read_file`, `search_code`, `write_file` · `find_symbol`, `get_dependencies`, `trace_symbol`, `get_context` · `plan_clusters`, `run_cluster_workers` · `run_in_sandbox` · `git_status`, `git_diff`, `git_create_branch`, `git_commit`, `git_push` · GitHub MCP tools.

### Events to the UI (`AgentService`)

`thought`, `text` (streamed deltas), `tool-call`, `tool-result`, `handoff`, `approval`, `approval-result`, `memory-used`, `context-used`, `rl-decision`, `error`, `done`; plus `rl-update` for feedback.

---

## 14. Where data is stored

| What | Where |
|---|---|
| Atlas index cache, scorer weights, context session log | `<workspace>/.rootcode/atlas/` (`index.json`, `scorer-weights.json`, `context-log.jsonl`) — add `.rootcode/` to your `.gitignore` |
| Failure memory | VS Code global storage: `failure-memory-<workspace-hash>.json` |
| RL policy table | VS Code global storage: `rl-policy-<workspace-hash>.json` |
| repo2lora venv | VS Code global storage: `repo2lora-venv/` |
| Dataset, adapters, deployed endpoint | `<repo>/.repo2lora/` (dataset/, adapters/, `rootcode-endpoint.json`; self-gitignored) |
| GitHub token | VS Code secret storage |
| Last training job | VS Code global state |

---

## 15. Security model

- **Secrets:** agents can never read, write, search, copy or commit `.env`, `.env.*` (except `.env.example`/`.sample`), `.npmrc`, `*.pem`, `*.key`. Staging for commits excludes env files even if the repo forgot to ignore them.
- **Paths:** every model-supplied path is resolved inside the workspace root; escapes are rejected. Cluster workers are further confined to their cluster's files.
- **Sandbox:** QA commands run in Docker with no network and capped resources on a throw-away copy of the workspace; nothing is written back.
- **Approval:** `git_push` requires explicit modal approval; denial leaves the commit local.
- **Webviews:** strict CSP with per-load nonces, only local resources, escaped user text, validated incoming messages.
- **API keys** stay in `.env`/environment/secret storage and are sent only to the configured provider URL.

---

## 16. Verification status and measured numbers

What has been verified, and how:

- `tsc --noEmit`, `eslint`, and the esbuild bundle pass.
- Graph UI headlessly (the real `atlas.js` run against stub DOM/canvas, fed the real payload of a 7,262-file repo): auto-fit, cluster overview, drill-in on agent activity (touched file lands at the canvas centre), cap behaviour, and layout stability across refreshes. Not visually inspected in a real webview.
- Outside VS Code (standalone scripts against this repo, a 1,491-file sample and synthetic fixtures): indexing, linking and caching; entry-point resolution (stack traces, symbols, overview, fallback); traversal direction by task type; focus extraction; scorer budgeting, exploration rate (≈11–15%, reproducible per turn) and per-type weight learning; cluster determinism and ordering; cluster-worker waves, upstream summary hand-off, duplicate rejection, and the write-confinement guard (a cross-cluster write is blocked, own-cluster writes allowed); composed prompt order.
- **Not exercised inside VS Code:** the webviews, the LSP bridge, post-edit diagnostics checks, live graph highlighting, the RL/agent wiring with a real model, and the cluster workers with a real model. Prompt-cache hit rates and the end-to-end quality gain from structured context are **unmeasured** — use **Show Context Hit Rate** after real tasks to collect the first numbers.

---

## 17. Known limitations and not-yet-built

- Call resolution is syntactic (plus import bindings); it is not type-aware, so dynamic dispatch and untyped receivers are missed. Language-server-based resolution is not implemented.
- Python is parsed by indentation, not a real AST; C#/YAML from the original MCP server were not ported.
- Embeddings / vector search from code-atlas-mcp were intentionally not ported (the point is graph-based context).
- The scorer is a learned linear model over hand-made features; priors/Thompson sampling for the RL policy are not implemented.
- The first message of a conversation retrieves memory lessons without the dependency neighbourhood (follow-ups use it).
- Providers: Baseten and Fireworks only. A Meta Model API (Muse Spark 1.2) provider has not been added.
- `muse-lora-trainer` pins `typescript ^5` while the extension uses `^6`; both build independently.

---

## 18. Lineage

**`code-atlas-mcp`** (a separate project) indexes a repo into SQLite + embeddings and serves it over MCP. Atlas re-implements its *graph* logic natively in the extension: the extractors (tree-sitter → TypeScript compiler API / indentation parser), `resolveImports`, cross-file edge resolution with barrel following, `getCallers/getCallees/blastRadius`, and the node/edge schema. It does **not** run as an MCP server and drops SQLite, embeddings, Neo4j export, C# and YAML.

**`StructuredDeterministicContext.md`** (design doc) → implementation:

| # | Component in the doc | Implemented as |
|---|---|---|
| 1 | AST Parser & Symbol Table | `AtlasIndex` + extractors; O(1) `lookupSymbol`; signatures |
| 2 | Import/Dependency Graph | `AtlasIndex` imports edges, `queries.fileNeighbors/blastRadius` |
| 3 | Call Graph | `calls`/`inherits`/`implements`/`injects` edges, `getCallers/getCallees/symbolBlastRadius` |
| 4 | Git Timeline Index | `GitTimelineIndex` (+ co-change) |
| 5 | LSP Bridge | `LSPBridge` |
| 6 | Index Orchestrator | `IndexOrchestrator.getContext/resolveAndGetContext/buildForQuery` |
| 7 | Entry Point Resolver | `EntryPointResolver` (doc's 5 priorities + stack traces, symbols, tabs, overview) |
| 8 | Graph Traversal Engine | `GraphTraversalEngine` (+ direction by task type, hubs, focus) |
| 9 | Causal RL Scorer | `CausalContextScorer` (phase-1 weighted scorer with online learning + exploration) |
| — | Cross-Session Failure Memory (Idea C) | Rootcode Recall (`src/memory/`) |

---

## 19. Project history

1. **Prototype** — the VS Code extension scaffold with simulated fine-tuning and task workflows; the Muse LoRA fine-tuning client (`muse-lora-trainer`); repo2lora dataset creation.
2. **Agentic workflows** — Google ADK agents: orchestrator, developer → QA (Docker sandbox) → version control (approval-gated push), PR review via GitHub MCP; live thought/tool/hand-off UI.
3. **Rootcode Recall** — cross-session failure memory with implicit rewards, then the RL strategy policy with UCB exploration and explicit 👍/👎 feedback.
4. **Atlas** — structured deterministic context ported from code-atlas-mcp into the extension; dependency-graph panel; all nine design-doc components; agent tools and per-turn injection.
5. **Optimisation** — time-sliced indexing, caching, stable graph UI, focus-mode (symbol-level) context, structural RL arms, post-edit diagnostics checks, richer entry points, direction-aware traversal, exploration slot, per-task-type learned weights.
6. **Cluster workers and prompt caching** — graph-cluster subagent splitting with write confinement and dependency ordering; stable-to-volatile prompt layout with conversation-level dedupe.
