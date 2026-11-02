# Rootcode

A VS Code extension that builds a living dependency graph of your codebase, gives coding agents a structured, deterministic context from it, fine-tunes a LoRA on your repository's history, and learns from how you use the agents' output.

**Full documentation: `README.md` at the repository root. Setup, environment variables and run instructions: `SETUP.md` at the repository root.**

## What you get

- **Agents** (Google ADK): orchestrator → developer → QA (Docker sandbox) → version control (push needs your approval), plus a GitHub PR review agent. Live view of thinking, tool calls and hand-offs.
- **Atlas — structured deterministic context:** a local index of symbols, imports, calls, inheritance and DI; entry points from your editor, errors, stack traces, git and symbols; graph traversal and a learned scorer; injected into every agent turn, with symbol-level context, graph tools (`find_symbol`, `get_dependencies`, `trace_symbol`, `get_context`) and post-edit error checks.
- **Dependency graph panel:** interactive file graph with blast radius and per-symbol callers/callees; lights up the files agents touch while they work.
- **Cluster workers:** multi-area changes are split across graph clusters, each worker confined to its cluster and run in dependency order.
- **Rootcode Recall + RL strategy policy:** cross-session failure memory and a UCB bandit that picks the agent's working strategy; 👍/👎 and implicit signals (edits, diagnostics, tests, git reverts) train it.
- **Fine-tuning:** mine your git history with repo2lora, train a LoRA on Baseten or Fireworks, deploy it, and point the agents at it.

## Quick start

```bash
# from the repository root
cd muse-lora-trainer && npm install && cd ..
cd rootcode-source && npm install && npm run compile
cp .env.example /path/to/your/project/.env     # set BASETEN_API_KEY at minimum
```

Open `rootcode-source/` in VS Code, press **F5**, open your project folder in the new window, and click the Rootcode icon. Details: `SETUP.md` at the repository root.

## Commands

`npm run compile` (type-check, lint, bundle) · `npm run watch` · `npm run test:workflow` · `npm test` · `npm run package:vsix` (builds `rootcode-<version>.vsix`).

Source map: `src/extension.ts` (activation), `src/agents/` (agents, tools, prompts, model client), `src/atlas/` (index, graph, clusters, scorer, graph panel), `src/memory/` (Recall + RL policy), `src/providers/` (fine-tuning panel), `media/` (webview UIs).
