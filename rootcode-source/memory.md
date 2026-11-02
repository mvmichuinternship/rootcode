# Rootcode Project Memory

## Product Decisions

- The user requested a VS Code extension with two primary actions: fineTuning and start with a task.
- Fine-tuning displays collecting data, cleansing, transforming, dataset preparation, and sending to a fine-tuning pipeline. Pipeline handoff is the final stage; do not extend into model training without a new requirement.
- Start with a task opens a chat; sending a message triggers an agentic workflow.
- Current scope is the extension and interface first. Both workflows are explicitly simulated. No actual file access, uploads, training, or agent execution is implemented.
- The user chose the internal identifier `rootcode` and supplied the product description during generator setup. The product is branded Rootcode.
- Keep this file up to date for future conversations.
- The user does not want downloaded VS Code test applications left on their Mac. Delete the project-local `.vscode-test` runtime and disposable profiles after integration tests; do not touch their installed VS Code. Prefer isolated workflow tests when sufficient.

## Implementation

- TypeScript VS Code extension scaffolded with generator-code, npm, and esbuild.
- Command: `rootcode.open` / **Rootcode: Open Studio**. Opens or reveals a single editor webview panel.
- Host: `src/extension.ts`. Secure CSP, bundled local resources, input validation, panel cleanup.
- Controller: `src/workflow.ts`. Progress/complete/cancelled events, one active run, cancellable timers, no backend dependencies.
- UI: `media/studio.js`, `media/studio.css`. Home, five-stage progress, chat, cancellation, new conversation, message escaping, VS Code theme variables, bundled Codicons.
- State survives hidden-panel navigation, not closing the panel or restarting VS Code. No filesystem persistence of conversations.
- Chat prompt limit: 8,000 characters, enforced in UI and host.
- F5 launches the Extension Development Host; run **Rootcode: Open Studio** there.

## Checks

- `npm run compile`: TypeScript, ESLint, esbuild.
- `npm run test:workflow`: isolated workflow tests.
- `npm test`: VS Code integration tests; may require network access to download the runtime.
- Verified: compile/lint pass; four isolated workflow tests pass; all five tests pass in VS Code 1.144.0, including opening/revealing the panel.
- Browser checks with a mocked VS Code bridge pass for stage completion, task dispatch, escaped task text, and no horizontal overflow at desktop and 360px widths. Real backend execution remains out of scope.
- Removed the downloaded `.vscode-test` app and profiles after testing at the user's request.
- Local installation: build a VSIX with `npm exec --yes --package @vscode/vsce -- vsce package --allow-missing-repository --skip-license`, then use Extensions > ... > Install from VSIX. Minimum VS Code version is 1.85.0. Publisher is `rootcode`; package version 0.0.2 targets compatibility with VS Code 1.143.1.
- The user's editor is VS Code 1.143.1. Pin `@types/vscode` to 1.85.0 (not a caret range): vsce rejects a manifest engine below a newer API typing version. Verified `rootcode-0.0.2.vsix` manifest has publisher `rootcode` and engine `^1.85.0`.

## Next Integration Work

- Define data sources, privacy/consent requirements, secret filtering, and dataset format before collecting real repository content.
- Decide the fine-tuning provider and authenticated submission contract. Do not silently upload repository data.
- Choose an agent orchestration service, streaming protocol, approval model, and cancellation/error handling.
- Add real service adapters behind the workflow event boundary; replace demo copy only when execution is real.
## Update — scope has grown beyond the original prototype

The "simulated, no real agents" notes above describe the first scaffold only. The extension now has real Google ADK agents (orchestrator, developer, QA in a Docker sandbox, version control with approval-gated push, GitHub PR review), a real fine-tuning flow (repo2lora + Baseten/Fireworks), cross-session failure memory (Rootcode Recall) with a UCB RL strategy policy, and Atlas (`src/atlas/`): structured deterministic context from a dependency graph, a graph UI panel, symbol-level context, post-edit diagnostics checks, cluster workers, and a cache-friendly prompt layout. See `../README.md` for the complete description and `../SETUP.md` for setup. Package builds are kept as version 0.0.12 (overwritten), not bumped.
