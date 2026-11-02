# Rootcode — Setup and Run

How to take a fresh clone of this repository to a running Rootcode extension. For what Rootcode is and how it works, see [README.md](README.md).

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone and build](#2-clone-and-build)
3. [Configure `.env`](#3-configure-env)
4. [Run it](#4-run-it)
5. [Environment variables](#5-environment-variables)
6. [Package and install a VSIX](#6-package-and-install-a-vsix)
7. [Using the features](#7-using-the-features)
8. [Development commands](#8-development-commands)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites

| Needed for | Requirement |
|---|---|
| Everything | **VS Code 1.90 or newer**, **Node.js 20+** (22 LTS recommended) and npm, **git** |
| QA agent (sandboxed test runs) | **Docker** running locally (the agent pulls `node:22-slim` by default). Without Docker the QA agent's `run_in_sandbox` tool fails; everything else works. |
| Fine-tuning dataset generation | **Python 3.9+** on `PATH` (the extension creates its own venv and installs the bundled repo2lora wheel) |
| Fine-tuning | An account and API key for **Baseten** and/or **Fireworks** |
| Agents | A **Baseten** API key (main agents). A **Fireworks** key and fine-tuned model id for the PR review agent. |
| PR review agent | A **GitHub token** with pull-request read/write access |

You only need the sections relevant to what you want to use. The agents need just a model key; the dependency graph and structured context need nothing at all (they are local).

---

## 2. Clone and build

The repository has three parts; the extension depends on the trainer library by relative path, so **build the trainer first**.

```bash
git clone <this-repo-url> rootcode
cd rootcode

# 1. LoRA trainer library (the extension imports it from ../muse-lora-trainer)
cd muse-lora-trainer
npm install            # also runs `tsc` through the `prepare` script and produces dist/
cd ..

# 2. The extension
cd rootcode-source
npm install            # links ../muse-lora-trainer
npm run compile        # type-check + lint + bundle to dist/extension.js
```

`npm run compile` must finish without errors before you run or package anything. If it fails on `muse-lora-trainer`, re-run `npm run build` inside `muse-lora-trainer/` and `npm install` again in `rootcode-source/`.

> `repo2lora-components/` holds a copy of the repo2lora wheel and `start-repo2lora.sh` (installs it into a venv for manual CLI use). The extension does **not** need it — it uses the wheel vendored in `rootcode-source/resources/`.

---

## 3. Configure `.env`

The extension reads configuration from a **`.env` file in the root of the folder you open in VS Code** (the workspace being worked on — *not* necessarily this repo), then from the process environment, then from VS Code settings. The `.env` is re-read on every model call, so **edits apply on the next message with no reload**.

```bash
# from rootcode-source/, copy the template into the folder you will open in VS Code:
cp .env.example /path/to/your/project/.env
```

Then edit it. A minimal working configuration for the main agents:

```bash
BASETEN_API_KEY=your-baseten-key
```

That is enough: the main agents default to Baseten with `meta-models/muse-spark-open-1026`. Add the other variables only for the features you use (see the table below). **Never commit `.env`.** The agents are blocked from reading, writing or committing it.

Quote values that contain `#` (Fireworks LoRA model ids do), e.g.:

```bash
PR_REVIEW_MODEL="accounts/<account>/models/<model>#accounts/<account>/deployments/<deployment-id>"
```

---

## 4. Run it

### Option A — development host (recommended while developing)

1. Open `rootcode-source/` in VS Code.
2. Press **F5** (the **Run Extension** launch configuration builds first). A second *Extension Development Host* window opens.
3. In that window, **open the project folder that contains your `.env`** (File → Open Folder). The agents and Atlas work on whichever folder is open there.
4. Click the **Rootcode** icon in the activity bar, or run **Rootcode: Open Studio** from the Command Palette.

### Option B — installed VSIX

Build and install a package ([section 6](#6-package-and-install-a-vsix)), then open your project folder normally and click the Rootcode icon.

### First run checklist

- The Studio header shows a pill with `baseten · <model>`. If it says **Model not configured**, the key is missing — hover the pill for the exact variable.
- Atlas starts indexing in the background on startup (time-sliced, so the editor stays responsive; the first index of a large repo takes a few seconds, later starts use the cache). Open **Rootcode: Open Dependency Graph** to see it.
- Send a task in the chat. You should see, in order: an **RL** card (strategy chosen), an **Atlas** card (files put in context), then tool calls and the answer.

---

## 5. Environment variables

All variables go in the project's `.env` (template: [`rootcode-source/.env.example`](rootcode-source/.env.example)) or the process environment. Anything unset falls back to the shown default or to the matching VS Code setting.

### Provider keys

| Variable | Required for | Notes |
|---|---|---|
| `BASETEN_API_KEY` | main agents (default provider), Baseten fine-tuning | |
| `FIREWORKS_API_KEY` | Fireworks agents/fine-tuning, default PR review agent | |

Key lookup for an agent group is `<PREFIX>_API_KEY`, else the provider's key above.

### Main agents (orchestrator, developer, QA, version control) — prefix `ROOTCODE_`

| Variable | Default | Meaning |
|---|---|---|
| `ROOTCODE_PROVIDER` | `baseten` | `baseten` or `fireworks` |
| `ROOTCODE_MODEL` | `meta-models/muse-spark-open-1026` (baseten); **required** for fireworks | model slug |
| `ROOTCODE_API_KEY` | provider key | overrides the provider key |
| `ROOTCODE_BASE_URL` | `https://inference.baseten.co/v1` or `https://api.fireworks.ai/inference/v1` | OpenAI-compatible base URL |
| `ROOTCODE_MAX_TOKENS` | `8192` | per call, including reasoning tokens |
| `ROOTCODE_REASONING_EFFORT` | `medium` | Muse Spark Open on Baseten only |
| `ROOTCODE_STREAM` | `true` | `false` disables live streaming |
| `ROOTCODE_MODEL_SOURCE` | `baseten-model-api` | `trained-endpoint` uses the LoRA deployment saved at `.repo2lora/rootcode-endpoint.json` |

### PR review agent — prefix `PR_REVIEW_`

| Variable | Default | Meaning |
|---|---|---|
| `PR_REVIEW_PROVIDER` | `fireworks` | |
| `PR_REVIEW_MODEL` | **required** | e.g. `"accounts/<account>/models/<model>#accounts/<account>/deployments/<deployment-id>"` |
| `PR_REVIEW_API_KEY` | provider key | |
| `PR_REVIEW_BASE_URL` | provider default | |
| `PR_REVIEW_MAX_TOKENS` | `4000` | |
| `PR_REVIEW_REASONING_EFFORT` | – | |

### GitHub (PR review agent)

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` (or `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`) | – | token with pull-request read/write access. Alternatively run **Rootcode: Set GitHub Token** to store it in VS Code secret storage. |
| `GITHUB_MCP_URL` | `https://api.githubcopilot.com/mcp/` | GitHub MCP endpoint |
| `GITHUB_MCP_TOOLSETS` | `context,repos,pull_requests` | limits the tools exposed to the reviewer |

Without a token the PR agent still exists but has no GitHub tools and says so.

### Fine-tuning (only for the "Fine-tune on your codebase" flow)

| Variable | Default | Meaning |
|---|---|---|
| `LORA_PROVIDER` (or `PROVIDER`) | `baseten` | `baseten` or `fireworks` |
| `BASETEN_BASE_MODEL` | `meta-models/muse-spark-open-1026` | base model to fine-tune on Baseten |
| `BASETEN_GPU` / `BASETEN_GPU_COUNT` | `H100` / `1` | training GPU |
| `BASETEN_DEPLOY_GPU` | = `BASETEN_GPU` | GPU for the deployed adapter |
| `BASETEN_HF_SECRET_NAME` | `hf_access_token` | name of the Baseten secret holding your Hugging Face token |
| `FIREWORKS_ACCOUNT_ID` | – | your Fireworks account |
| `FIREWORKS_BASE_MODEL` | `accounts/fireworks/models/llama-v3p1-8b-instruct` | base model on Fireworks |
| `FIREWORKS_TRAINING_MODE` | `serverless` | `serverless` or `managed` |
| `FIREWORKS_DEPLOYMENT_ID` | – | existing deployment to attach to |
| `LORA_RANK` | `16` | |
| `LORA_LEARNING_RATE` | `0.0002` | |
| `LORA_EPOCHS` | `3` | |
| `LORA_MAX_SEQ_LEN` | `4096` (`8192` Fireworks serverless) | |
| `LORA_LOAD_IN_4BIT` | `true` | 4-bit loading for Baseten training |
| `LORA_N_EVAL` | `16` | evaluation examples |
| `LORA_ALLOW_PAID` | `false` | Fireworks serverless: allow steps that incur charges |
| `LORA_DOWNLOAD_ADAPTER` | `true` | save the adapter to `<folder>/.repo2lora/adapters` |
| `LORA_AUTO_DEPLOY` | `true` | deploy the trained adapter automatically |
| `REPO2LORA_WHEEL` | bundled wheel in `rootcode-source/resources/` | absolute path to a different repo2lora wheel |

### repo2lora's own variables (only if you run the `repo2lora` CLI yourself)

`MODEL_API_KEY` (needed for `repo2lora synthesize`), `GITHUB_TOKEN`/`GH_TOKEN` (PR review mining), and optional `REPO2LORA_META_MODEL`, `REPO2LORA_REASONING_EFFORT`, `REPO2LORA_SYNTH_LIMIT`, `REPO2LORA_SYNTH_CONCURRENCY`, `REPO2LORA_SYNTH_MAX_TOKENS`, `REPO2LORA_MIN_QUALITY`, `REPO2LORA_MAX_CHARS`, `MODEL_API_BASE_URL`, `REPO2LORA_GITHUB_API`. The extension's dataset step does not need them.

### VS Code settings (optional; env wins)

`rootcode.atlas.autoOpen`, `rootcode.atlas.tokenBudget`, `rootcode.agent.modelSource|baseUrl|model|reasoningEffort|maxTokens|sandboxImage`, `rootcode.memory.enabled`, `rootcode.memoryTrackingWindowMs`, `loraTrainer.*`. Defaults are listed in the README.

**Precedence:** `<folder>/.env` > process environment > VS Code settings.

---

## 6. Package and install a VSIX

```bash
cd rootcode-source
npm run package:vsix           # production build + rootcode-<version>.vsix
```

Install it:

```bash
code --install-extension rootcode-<version>.vsix
```

or in VS Code: Extensions (⌘/Ctrl+Shift+X) → **…** menu → **Install from VSIX…**. Reload the window afterwards.

`package:vsix` runs `vsce` with `--no-dependencies` because everything is already bundled into `dist/extension.js` by esbuild (the trainer library is a local `file:` dependency, which `vsce` cannot package otherwise).

---

## 7. Using the features

**Ask the agents.** Studio chat (or `@rootcode` in VS Code chat). Each turn shows the RL strategy, the graph context used, tool calls, hand-offs, and the result. Click 👍/👎 on the RL card to train the strategy policy (edits, tests, diagnostics and git reverts also train it automatically).

**See the dependency graph.** *Rootcode: Open Dependency Graph*, the Graph button in the Studio header, or right-click a file → *Show File in Dependency Graph*. While an agent runs, the graph opens beside your editor and highlights the files it touches (turn off with `rootcode.atlas.autoOpen`).

**Check whether the structured context helps.** After some real agent tasks run *Rootcode: Show Context Hit Rate*.

**Fine-tune on your repo.** Studio → *Fine-tune on your codebase* (or *LoRA: Start Fine-Tuning Job*): generate the dataset (needs Python), then train (needs the provider key and settings above). Afterwards set `ROOTCODE_MODEL_SOURCE=trained-endpoint` to use the deployed adapter. *LoRA: Check Job Status* re-checks the last job.

**Memory.** *Show / Open / Clear Agent Memory* manage cross-session failure memory.

---

## 8. Development commands

Run inside `rootcode-source/`:

| Command | What it does |
|---|---|
| `npm run compile` | type-check + lint + bundle |
| `npm run watch` | continuous build (used by F5) |
| `npm run check-types` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run test:workflow` | fast workflow tests, no VS Code download |
| `npm test` | VS Code integration tests (downloads a VS Code test runtime into `.vscode-test/` on first run; delete the folder afterwards if you don't want it) |
| `npm run package` | production bundle (no VSIX) |
| `npm run package:vsix` | production bundle + VSIX |

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Model not configured" pill | Set `BASETEN_API_KEY` (or the key for the provider in `ROOTCODE_PROVIDER`) in the `.env` of the **open folder**; hover the pill for the exact variable |
| `.env` changes seem ignored | The `.env` must be in the root of the folder open in VS Code (in the Extension Development Host, that is the folder you opened *there*). Values in `.env` override the process environment |
| `Cannot find module 'muse-lora-trainer'` | Build the trainer first: `cd muse-lora-trainer && npm install && npm run build`, then `npm install` again in `rootcode-source/` |
| QA agent errors about Docker | Start Docker Desktop; check `docker run --rm node:22-slim true` works; change the image with `rootcode.agent.sandboxImage` |
| Dataset generation: "No Python" | Install Python 3.9+ and make sure `python3` is on `PATH` |
| Fine-tuning: key/model errors | The panel names the missing variable; set it in `.env` ([section 5](#5-environment-variables)) |
| Fireworks model id rejected / treated as comment | Quote values containing `#` |
| Dependency graph shows bubbles, not files | On repos above ~1,500 files it opens in the **Clusters** overview; double-click a bubble to open its files, or pick **Files** in the toolbar |
| Dependency graph looks off-centre | Press **Fit** (auto-fit stops once you pan or zoom) |
| Dependency graph is empty | Atlas indexes TypeScript/JavaScript and Python only; open a folder containing such files, or press **Re-index** in the graph panel |
| Graph feels stale after big changes (e.g. branch switch) | Press **Re-index** in the graph panel |
| First index is slow on a huge repo | It is time-sliced (the editor stays responsive) and cached; later starts are fast. Delete `<folder>/.rootcode/atlas/` to force a clean rebuild |
| RL card said "Couldn't record feedback" | The decision belonged to an earlier session; it only affects that card. Feedback on new turns works normally |
| `npm run package:vsix` fails with `invalid relative path … muse-lora-trainer` | Use the repo's script (it passes `--no-dependencies`), or run `npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license` |
| `.rootcode/` shows up in git | Add `.rootcode/` to your project's `.gitignore` (it is already ignored in `rootcode-source/`) |
