# Development

## Setup

```sh
npm install          # local devDependencies only
npm run build        # esbuild → dist/extension.js, dist/webview.js
npm run watch        # rebuild on change
```

Press **F5** (launch configuration "Run Extension" in `.vscode/launch.json`) to start an Extension Development Host. After a rebuild, run **Developer: Reload Window** in that window.

## Checks

| Command                   | What it runs                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| `npm run typecheck`       | `tsc` for the host (Node) and webview (DOM) projects                        |
| `npm run lint`            | ESLint (typescript-eslint)                                                  |
| `npm run format:check`    | Prettier                                                                    |
| `npm test`                | Unit tests (`node:test`), compiled to `out-test/`                           |
| `npm run test:webview`    | The webview in headless Chrome (set `CHROME_PATH` when Chrome is not found) |
| `npm run test:live`       | The HTTP client against the local OpenCode service (skips without one)      |
| `npm run test:acceptance` | End-to-end scenarios in a real VS Code against the local OpenCode service   |
| `npm run package`         | `dist-vsix/opencode-sidecar-<version>.vsix` (never publishes)               |

CI (`.github/workflows/ci.yml`) runs all of these except the live tests and the acceptance harness, on Linux, and uploads the VSIX as an artifact. Pushing a `v<version>` tag runs `.github/workflows/release.yml`, which repeats the checks, creates the GitHub release and publishes to the Visual Studio Marketplace and Open VSX (see `docs/marketplace/MARKETPLACE.md`).

## Unit tests

Pure modules are tested directly. Behaviour that would need a live server goes through `MockClient` (`test/mockClient.ts`), an in-memory `OpenCodeClient`. Covered: CLI and server discovery, loopback rules, repository and worktree detection, message validation, the HTTP client, event normalization and history replay, the transcript reducer, the session controller (sessions, prompts, steer/queue, permissions, questions, subagents, rewind, rename, fork, archive, staged rewinds, mentions, commands, shell, Budget Guard, changes made by other clients), context formatting, sensitive paths, redaction and Markdown parsing.

## Webview tests

`test/webview/webview.test.ts` loads `dist/webview.js` and `media/main.css` into headless Chrome through `puppeteer-core`, with the VS Code API stubbed: it records what the webview posts and delivers host messages with `window.postMessage`. It covers the timeline and turns, pinned prompts, tool rows, subagents, the docks, the menus and tooltips, the message box (its column and fade, `@` mentions, pasted images and text), fork, archive, staged rewinds, bookmarks, onboarding, widths of 300, 400 and 520 px, high contrast and reduced motion, and a performance check (400 messages and 2,000 streamed deltas). It uses an installed Chrome (on Windows, Chrome or else Edge) and downloads no browser; point `CHROME_PATH` at another Chromium browser if needed.

## Live tests

`test/live/*.test.ts` run `HttpOpenCodeClient` against the real local OpenCode service, found the way the extension finds it (`discoverServer`, from `service.json`). Every client call that does not touch your account is covered: server info, models, agents, skills, commands, file search, account state, MCP servers, the folder's project and saved rules, sessions (create, rename, archive, fork, rewind, delete, and on Windows both drive-letter forms), history, the pending lists, running state and the event stream. Each test asserts the parsed shapes the UI uses.

They work in a new temporary folder and delete every session they create. Two tests send a prompt to the free `opencode/big-pickle` model (skipped when it is not offered): one checks that a prompt with a large paste is stored exactly and stops the session at once, the other waits for the reply (skipped when the free daily limit is reached). The others make no model calls. Without a registered service, or when it does not answer, every test is skipped with the reason, so the suite also passes on CI. The service password is never printed.

```sh
npm run test:live
```

## Acceptance harness

`test/acceptance/runAcceptance.ts` launches VS Code (`VSCODE_EXECUTABLE` overrides the path) with temporary user data and `--disable-extensions`, then runs `test/acceptance/suite.ts` inside the extension host. It drives the real extension through the same handlers the webview uses, against the real OpenCode service, so **it makes real model calls**.

```sh
npm run test:acceptance                       # fixture repository scenarios
ACCEPT_REAL_REPO=/path/to/repo ACCEPT_REAL_FILE=src/a.ts ACCEPT_REAL_LINES=20-27 npm run test:acceptance
ACCEPT_ONBOARDING=1 npm run test:acceptance   # also first-run scenarios (temporary OpenCode servers)
```

The scenarios run on `opencode-go/kimi-k2.7-code` when OpenCode offers it, otherwise on the free `opencode/big-pickle`; `ACCEPT_MODEL=<provider/model>` picks another. Shell commands in the prompts work in bash, zsh and the Windows PowerShell that OpenCode uses on Windows; when the model does not run the command it is asked once more.

The real-repository scenario is read-only: it uses OpenCode's `plan` agent, fingerprints the repository's Git state before and after, and fails if anything changed.

## Images

| Command                                          | Output                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `node scripts/screenshots.mjs`                   | README screenshots in `docs/marketplace/screenshots/` (run `npm run build` first)   |
| `node scripts/screenshots.mjs --all --out=<dir>` | every scene, including 300 and 520 px widths, for review                            |
| `node scripts/hero.mjs`                          | `docs/marketplace/hero.png` from the icon and two screenshots                       |
| `node scripts/icons.mjs`                         | `media/icon.png` from `media/src/icon.svg`, plus a preview of the Activity Bar icon |

All three use `puppeteer-core` with an installed Chrome, or the browser in `CHROME_PATH`.

## Packaging

`npm run package` runs the production build and `vsce package`. `.vscodeignore` is a whitelist: the VSIX contains only the two bundles, `media/main.css`, the icons, `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `THIRD-PARTY-NOTICES.md` and `package.json`. Uploading to the Marketplace is a manual step; see `docs/marketplace/MARKETPLACE.md`.

## Project layout

```
src/
  extension.ts   activation: view, commands, output channel, content providers
  host/          VS Code integration (webview provider, workspace and Git, diffs, editor tabs, config)
  core/          VS Code-free logic (session controller, subagents, budget, forms, context, discovery)
  opencode/      OpenCode adapter (HTTP client, service discovery, SSE, event normalization)
  shared/        types and reducers shared by host and webview
  webview/       the chat view (plain TypeScript and DOM, no framework) and Markdown parser
media/           CSS and icons (icon source in media/src/)
scripts/         build, screenshots, hero and icon rendering
test/            unit tests, webview tests, live tests, mock client, acceptance harness
docs/            architecture, development, OpenCode integration, Marketplace notes
```

The extension has no runtime dependencies to install: the UI uses plain DOM APIs, and the Markdown renderer and SSE parser are small in-repo modules. The one bundled library is [Prism](https://prismjs.com) (MIT), used only as a tokenizer for syntax colors (`src/webview/highlight.ts`); its license is in `THIRD-PARTY-NOTICES.md`, which ships in the VSIX.
