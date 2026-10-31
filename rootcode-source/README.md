# Rootcode

A VS Code extension interface for codebase fine-tuning and task-driven agent workflows.

## Features

- **Activity Bar Integration**: Rootcode now appears as a separate section in VS Code's activity bar (like GitLens, Copilot, etc.)
- **Sidebar Panel**: Access your Rootcode workflows directly from the VS Code sidebar
- **Command Palette**: Launch Rootcode Studio with the **Rootcode: Open Studio** command

## Run

1. Run `npm install`.
2. Open this folder in VS Code and press **F5** using the **Run Extension** configuration.
3. Look for the Rootcode icon in the VS Code activity bar (left sidebar), or run **Rootcode: Open Studio** from the Command Palette.

## Workflows

- **Fine-tuning** opens a progress view. Select **Start preparation** to simulate collecting, cleansing, transforming, dataset preparation, and sending to the fine-tuning pipeline. Pipeline handoff is the final stage.
- **Start with a task** opens a chat. Sending a task simulates understanding, planning, and agent handoff. Enter sends; Shift+Enter adds a line. Runs can be cancelled and conversations reset.

## Current Scope

This is an interface prototype, not a connected AI service. Progress is simulated in the extension host. No repository data is read or uploaded, no model is trained, and no agent executes or modifies files. State survives hiding the panel; closing it starts fresh. Only one workflow runs at a time.

The interface follows the active VS Code theme, uses bundled Codicons, and loads no external scripts, fonts, or services. Task text is escaped before rendering. Incoming messages are validated and pending work is cancelled when the panel closes.

## Development

- `npm run compile`: type-check, lint, and bundle.
- `npm run watch`: continuous build for F5 development.
- `npm run test:workflow`: fast workflow tests without launching VS Code.
- `npm test`: VS Code integration tests. Downloads a test runtime on the first run.
- `npm run package`: production build, not a VSIX archive.
- `npm run package:vsix`: production build and installable VSIX archive.

`src/workflow.ts` owns simulated runs and emitted events. Replace its simulated stages with backend integration later, retaining progress, cancellation, and completion events. `src/extension.ts` owns the sidebar panel, webview views, and message validation. `media/studio.js` and `media/studio.css` own the interface.

## Install in Your Existing VS Code

1. Build the installer with `npm run package:vsix`.
2. In VS Code, open Extensions with **Cmd+Shift+X**.
3. Use the **...** menu and select **Install from VSIX...**.
4. Choose `rootcode-0.0.2.vsix` from this project.
5. Click the Rootcode icon in the activity bar to open the sidebar panel.

Requires VS Code 1.85.0 or newer. Packaging does not download another VS Code application.

Integration testing with `npm test` downloads a separate VS Code runtime into `.vscode-test`. Remove that directory after testing. Use `npm run test:workflow` for tests without downloading an editor.
