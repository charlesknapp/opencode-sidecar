# Architecture

Sidecar is a thin user interface. OpenCode remains the agent engine: it owns reasoning, tools, model providers, credentials, permissions and session storage.

```
┌────────────────────────── VS Code ──────────────────────────┐
│ Webview (chat view)          Extension host                 │
│  src/webview/main.ts  ◀──▶  src/host/chatView.ts            │
│  timeline, message box, typed  connection, VS Code APIs,    │
│  docks, menus           messages context, diffs, editor tabs│
│                                    │                        │
│                         src/core/sessionController.ts       │
│                         sessions, prompts, requests,        │
│                         subagents, changes, usage, budget   │
│                                    │                        │
│                         src/opencode/  (adapter)            │
│                         OpenCodeClient ─ HttpOpenCodeClient │
└────────────────────────────────────┼────────────────────────┘
                                     │ HTTP + SSE, 127.0.0.1
                          OpenCode 2.x background service
```

## Layers

| Layer            | Files                                                                      | Depends on VS Code? |
| ---------------- | -------------------------------------------------------------------------- | ------------------- |
| Shared model     | `src/shared/` (model, protocol, transcript reducer, tool descriptions)     | no                  |
| Core logic       | `src/core/` (session controller, subagents, budget, forms, context, …)     | no                  |
| OpenCode adapter | `src/opencode/` (HTTP client, service discovery, SSE, event normalization) | no                  |
| Host integration | `src/host/`, `src/extension.ts` (webview provider, workspace, diffs, tabs) | yes                 |
| Webview UI       | `src/webview/` (rendering, menus, docks, Markdown parser, strings)         | browser only        |

Everything except `src/host` and `src/extension.ts` runs in plain Node, so most behaviour is unit-tested without VS Code. The webview is tested in headless Chrome.

## Adapter

`OpenCodeClient` (`src/opencode/client.ts`) is the only interface the rest of the extension uses to talk to OpenCode. `HttpOpenCodeClient` implements it on the OpenCode v2 HTTP API; the endpoints are listed in [OPENCODE_INTEGRATION.md](OPENCODE_INTEGRATION.md). Another transport could replace it without touching the UI.

## Events and the transcript

OpenCode emits one global event stream. `EventNormalizer` (`src/opencode/events.ts`) turns raw envelopes into the internal `UiEvent` union; raw transport objects never reach the controller or the webview. Stored history is replayed through the same union by `historyToEvents`, so live and reopened sessions render identically. Live events get their arrival time in the host (`stampTime`); history keeps OpenCode's stored times.

`Transcript` (`src/shared/transcript.ts`) is the reducer from `UiEvent`s to transcript items (prompts, text, thinking, tool calls, subagent reports, requests, notices). The host keeps the canonical copy, so a hidden or reloaded view is restored at once; the webview runs the same reducer on incremental event batches and re-renders only the items that changed, at most once per animation frame.

## Controller

`SessionController` (`src/core/sessionController.ts`) owns the open session: creating it lazily on the first prompt, continuing a stored one, model and agent selection, prompts with steer or queue delivery, stopping, permission and question replies, rewind, rename, fork, archive, a rewind staged elsewhere, `@` mentions, OpenCode commands, compaction and `!command`. It follows changes made by other clients (a rewind, an agent or model choice) and reloads or updates accordingly.

- **Subagents:** OpenCode runs each subagent in a child session. `SubagentTracker` (`src/core/subagents.ts`) keeps one view per subagent (status, activity, counts, timing, cost). Events are routed by session: a subagent's own events update its view; only its permission requests and questions join the open conversation, because the run waits for them. Opening a subagent loads its history into a second transcript and streams its live events.
- **Budget Guard:** `BudgetTracker` (`src/core/budget.ts`) counts cost and steps per task from live figures only and stops the run through the same path as Stop.
- **Current task:** `src/core/currentTask.ts` derives a short task summary and decides the native notifications (completed, needs input, failed, budget stopped). Replayed history never notifies.
- **Agent changes:** OpenCode's session diff gives full-file patches; `src/core/patch.ts` rebuilds both sides, which `AgentDocumentProvider` serves to VS Code's diff editor. Partial or binary patches are reported as unavailable.

## Webview

- **Layout:** a one-line header (title, Bookmarks, History, New session), the conversation as turns (a prompt, then a timeline with a dot per step), and a message box that floats over the bottom of the conversation. Permission requests and questions replace the message box with a dock until answered.
- **Communication:** the host sends `state` (a `ViewState` snapshot), `transcript` (a full reset) and batched `events`; the webview sends a closed set of intents. `parseWebviewMessage` validates every intent strictly (known type, field types, sizes, no extra keys); invalid messages are dropped.
- **Safety:** a strict CSP (`default-src 'none'`, nonce-only scripts), no `eval`, and no `innerHTML`: the DOM is built with `createElement`/`textContent`, and Markdown is parsed into a tree and rendered the same way. Link clicks are routed to the host.
- **Styling:** VS Code theme variables only, so dark, light and high-contrast themes work. Layout follows the panel's own width through container queries.

## Host

- `src/host/chatView.ts`: the webview provider, connection lifecycle, onboarding, attachments, notifications, bookmarks (workspace storage) and the Status Bar item.
- `src/host/workspace.ts`: the active folder, branch and repository type (local repository or Git worktree) from the built-in Git extension, with a `.git/HEAD` fallback. Nothing scans the repository on activation; files are searched only when the user asks (the + menu, or `@` through OpenCode's own search).
- `src/host/diff.ts`: agent-only and workspace diffs in VS Code's diff editor.
- `src/host/toolText.ts`: read-only editor tabs for a tool call's full command, output or subagent prompt.

## Lifecycle

- Activation registers the view, commands, the output channel and the content providers, and nothing else. The OpenCode connection starts when the view is first shown.
- Sidecar starts OpenCode only on **Start OpenCode** (or `autoStart`), through `opencode service start`. The service is shared with other OpenCode clients and is left running when VS Code closes.
- The event stream reconnects with backoff, and the open session is reloaded after a reconnect to close any gap.
