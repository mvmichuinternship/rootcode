# Change Log

All notable changes to the "rootcode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.12]

Agentic workflows (Google ADK), Rootcode Recall memory + RL strategy policy, and the Atlas structured-deterministic-context layer.

- **Atlas** (`src/atlas/`): deterministic workspace index (symbols, signatures, import graph, call/inherit/inject edges), git timeline with co-change, LSP bridge, entry-point resolver, graph traversal, learned context scorer, orchestrator. Injected into every agent turn; also exposed as agent tools (`find_symbol`, `get_dependencies`, `trace_symbol`, `get_context`).
- **Dependency graph panel**: force-directed file graph with blast radius, per-symbol callers/callees, and live highlighting of the files agents touch.
- **Symbol-level context**: big files are sent as the relevant symbols plus signatures instead of whole.
- **Post-edit checks**: `write_file` returns compiler errors for the written file and its importers.
- **RL strategy arms** now control context depth/size as well as the prompt hint; separate bandit context when the active file has errors.
- **Cluster workers**: `plan_clusters` / `run_cluster_workers` split multi-area changes across graph clusters, each worker confined to its cluster, in dependency order.
- **Prompt caching layout**: static system prompt first, session state last, per-turn context ordered stable to volatile, unchanged files replaced by references.
- Performance: time-sliced indexing, mtime cache, incremental relink only on real content changes, batched/culled canvas drawing, stable layout across refreshes.
- Dependency graph scales to large repos: cluster overview with drill-down, auto-fit, scope chip, compact payload, stable layout; small clusters are merged so the overview stays readable.
- Fixes: RL feedback card no longer hangs on "Updating policy…"; `npm run package:vsix` now works (`--no-dependencies`).

## [Unreleased]

- Initial release