# OpenCode integration

Target: **OpenCode 2.x**. Sidecar uses the OpenCode v2 HTTP API, the same surface as the official CLI (`opencode api …`) and the `@opencode/client` package. The running server publishes its OpenAPI document at `GET /openapi.json`.

## Server discovery

OpenCode 2 runs one shared **background service** per user (`opencode service start|status|stop`), registered in `$XDG_STATE_HOME/opencode/service.json` (default `~/.local/state/opencode/service.json`) with its `url`, `pid` and `password`. Sidecar discovers it as the official client does:

1. Read `service.json`. A service bound to every interface (`opencode service set hostname 0.0.0.0`) registers that bind address; `0.0.0.0` and `::` are reached at `127.0.0.1` and `::1`. Any other non-loopback `url` is refused.
2. Probe `GET /api/info` with HTTP Basic auth `opencode:<password>` and check the reported `pid` (this catches stale files).

The password stays in memory and is only sent to that loopback URL. With `opencodeSidecar.serverUrl` set, that URL is used instead (loopback unless `allowRemoteServer` is on); the password is sent only to the registered service's own origin, otherwise `OPENCODE_SERVER_PASSWORD` is used if set.

**Start OpenCode** runs `opencode service start` with the discovered executable and polls discovery. Executable discovery (`src/core/cliDiscovery.ts`): the `opencodeSidecar.executablePath` setting, then `PATH`, then known install locations.

## Endpoints

Workspace-scoped calls pass the open folder as `location[directory]`. OpenCode compares directories case-sensitively and its CLI records Windows drive letters in upper case, while VS Code reports them in lower case, so Sidecar upper-cases the drive letter (`c:\repo` → `C:\repo`). The session list also asks for the lower-case form, which older Sidecar versions recorded. ✓ marks calls checked against a live OpenCode service; `npm run test:live` (`test/live/`) repeats those checks.

| Purpose                      | Endpoint                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Health / version ✓           | `GET /api/info`                                                                                                       |
| Models, providers, default ✓ | `GET /api/model`, `GET /api/provider`, `GET /api/model/default`                                                       |
| Agents ✓                     | `GET /api/agent` (primary, non-hidden; with OpenCode's descriptions)                                                  |
| Commands ✓                   | `GET /api/command`; run one with `POST /api/session/{id}/command` `{ name, text, delivery? }`                         |
| Account and provider state ✓ | `GET /api/integration` (connection states only)                                                                       |
| Subagents and skills ✓       | `GET /api/agent` (non-primary, for `@` mentions), `GET /api/skill`                                                    |
| File search (`@`) ✓          | `GET /api/fs/find?query=&limit=` (ranked paths relative to the folder)                                                |
| Sessions ✓                   | `GET /api/session?parentID=null&archived=false` (workspace list; `archived=true` for the Archived view)               |
| Subagent sessions ✓          | `GET /api/session?parentID=`, `GET/POST /api/session`                                                                 |
| Rename ✓                     | `PATCH /api/session/{id}` `{ title }`                                                                                 |
| Archive ✓                    | `PATCH /api/session/{id}` `{ archived: true \| false }`                                                               |
| Delete ✓                     | `DELETE /api/session/{id}`                                                                                            |
| MCP servers ✓                | `GET /api/mcp` (each server's `status`: connected, pending, disabled, failed or needs_auth, with `error`)             |
| Fork ✓                       | `POST /api/session/{id}/fork` `{ before? }` (a non-empty session; the copy has `fork`, not `parentID`)                |
| History ✓                    | `GET /api/session/{id}/message` (newest first, cursor paging)                                                         |
| Prompt, steer, queue ✓       | `POST /api/session/{id}/prompt` `{ text, files?, agents?, skills?, delivery? }`                                       |
| Model and agent ✓            | `POST /api/session/{id}/model` (with `variant`), `POST /api/session/{id}/agent`                                       |
| Running state, stop ✓        | `GET /api/session/active`, `POST /api/session/{id}/interrupt`                                                         |
| Rewind ✓                     | `POST /api/session/{id}/revert/stage` `{ messageID, files }`, then `POST /api/session/{id}/revert/commit`             |
| Staged rewind ✓              | `DELETE /api/session/{id}/revert` (Restore) or `POST …/revert/commit` (Apply)                                         |
| Compact                      | `POST /api/session/{id}/compact` `{}`                                                                                 |
| Shell (`!command`) ✓         | `POST /api/session/{id}/shell` `{ command }`                                                                          |
| Permissions                  | `GET …/permission`, `POST …/permission/{requestID}/reply` `{ decision, message? }`                                    |
| Folder's project ✓           | `GET /api/location?location[directory]=` (its `project.id`; `C:\` and `c:\` are different projects)                   |
| Always-allowed rules         | `GET /api/permission/saved?projectID=` ✓, `DELETE /api/permission/saved/{id}` (from OpenCode's API description)       |
| Questions (forms)            | `GET …/form`, `POST …/form/{formID}/reply` `{ answer }`, `DELETE …/form/{formID}`                                     |
| Pending (steer/queue) items  | `GET …/inbox`, `DELETE …/inbox/{inboxID}`, `PATCH …/inbox/{inboxID}` `{ delivery }` (from OpenCode's API description) |
| Agent-only changes           | `GET …/diff?from=…&to=…` without `context`, for full-file patches                                                     |
| Events ✓                     | `GET /api/event` (Server-Sent Events, global for all locations)                                                       |

`decision` is `once`, `always` (only when the request carries `save` patterns, shown as "always allow `npm test *`") or `reject`; a rejection can carry `message`, which OpenCode hands to the agent as what to do instead. Model records can include provider headers or bodies; the adapter drops them on arrival because they can contain secrets. `GET /api/credential` is never called.

### Prompt attachments and mentions

- **Files and folders** are `files: [{ uri, name, mention? }]` with `file://` URIs; OpenCode reads them itself (up to 20 MB; a folder is sent as a listing). An `@` mention adds `mention: { start, end, text }`, the token's place in the text.
- **Images** are file entries too: a `file://` URI, or a base64 `data:image/…` URI that OpenCode stores inline (as its terminal UI does for pasted images). A model's `capabilities.input` lists `"image"` when it accepts them.
- **Pasted text** held as a chip is part of `text`: the webview sends it beside the message with its `[Pasted text #n]` token, and the host puts it in at the token after trimming the typed text and finding the `@` mentions (whose offsets move past it), so it reaches OpenCode exactly as pasted. OpenCode stores prompt text byte for byte (checked live, CRLF included); Sidecar sends line endings as `\n`, as the message box does for anything pasted into it.
- **Subagents** go in `agents: [{ name, mention }]` and **skills** in `skills: [{ id, mention }]`.

### Staged rewinds

A rewind can be staged without being applied (OpenCode's `/undo`). The session then carries `revert: { messageID, files }`, but its message list still contains every message, so Sidecar hides the turns from `messageID` on. Clearing the rewind resumes the session, which delivers anything still queued for it (for example the output of an earlier `!command`), so the agent may carry on.

## Events

The stream is global, so the controller filters by `sessionID`.

| OpenCode event                                                                     | Sidecar                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `session.inbox.enqueued/delivered/cancelled/delivery.changed`                      | pending items; a delivered user item becomes a prompt  |
| `session.execution.started/succeeded/failed/interrupted`                           | running state, end of a task, readable errors          |
| `session.text.*`, `session.reasoning.*`                                            | streamed text and thinking (with "Thought for Ns")     |
| `session.tool.*`, `shell.created`                                                  | tool rows (command, working directory, output, diffs)  |
| `session.shell.started/ended` ✓                                                    | `!command` as a Shell row                              |
| `session.synthetic` with `metadata.source: "subagent"`                             | a subagent's report, handed back to its parent         |
| `permission.asked/replied`, `form.created/replied/cancelled`                       | the permission and question docks                      |
| `session.step.started/ended/failed`, `session.usage.updated`                       | context, cost, steps, Budget Guard, cache estimate     |
| `session.revert.staged/committed/cleared` ✓                                        | reload the open session; a staged rewind shows its bar |
| `session.agent.selected`, `session.model.selected`                                 | follow an agent or model chosen in another client      |
| `session.compaction.started/ended/failed`                                          | notices                                                |
| `session.skill.activated`                                                          | a notice naming the skill                              |
| `session.retry.scheduled`                                                          | a retry notice                                         |
| `session.created/deleted/renamed/archived/unarchived/forked/moved`                 | the session list; `parentID` marks a subagent          |
| `integration.updated`, `provider.updated`, `model.updated`, `models-dev.refreshed` | reload models, agents and account state (debounced)    |

Stored history replays `user`, `assistant` (text, thinking, tool parts), `shell`, `synthetic`, `compaction` and `idle` messages through the same model, with OpenCode's stored times.

## Subagents

OpenCode runs a subagent (the `subagent` tool) in a child session: `session.created` carries `parentID`, and subagents can start their own. The subagent tool returns once the subagent is launched; its report reaches the parent later as a synthetic message, which wakes the parent.

- A subagent's permission requests and questions are raised on its own session, but the parent's run waits for them, so Sidecar shows them in the open conversation and replies to the subagent's session.
- `session.execution.*` events carry their session, so the parent's turn ending does not expire a subagent's pending request.
- A forked session is a root session (it has `fork`, not `parentID`), so it is listed in History and never treated as a subagent. Only the `session.forked` event names the original as `parentID`; Sidecar uses it to refresh the list.
- On reopen, subagents come from `GET /api/session?parentID=` (breadth-first, at most 200); pending requests are fetched only for subagents listed as running.
- A tool call is linked to its subagent through the result's `metadata.sessionID`, or the `sessionID` input when a subagent is continued.

## Compatibility notes

- A folder OpenCode has not loaded yet briefly answers with empty model and command lists. Sidecar retries the models once and the commands twice, and refreshes the commands when the / menu opens.
- A session created or switched without a model variant records it as `default`.
- A fork copies the history under new message ids, so a rewind in the fork names the fork's own message.
- An agent's default model can differ from `GET /api/model/default`, so new sessions are created with an explicit model.
- Rolling, weekly or monthly provider quotas are not exposed by OpenCode and are not shown. The prompt-cache clock is an estimate from the last step's time and the `cacheWarmMinutes` setting, shown only when that step reported cache tokens (`tokens.cache.read` or `tokens.cache.write` above zero).
