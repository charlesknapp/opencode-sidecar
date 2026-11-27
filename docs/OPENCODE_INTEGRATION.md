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

| Purpose                      | Endpoint                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Health / version ✓           | `GET /api/info`                                                                                                                   |
| Models, providers, default ✓ | `GET /api/model`, `GET /api/provider`, `GET /api/model/default`                                                                   |
| Agents ✓                     | `GET /api/agent` (primary, non-hidden; with OpenCode's descriptions)                                                              |
| Agents panel ✓               | `GET /api/agent` (every agent: mode, model, `system`, `request.body.temperature`, rules), `GET /api/config` (folders)             |
| Agent file changes ✓         | none: OpenCode watches its config folders; `agent.updated` follows, `POST /api/location/reload` only as a fallback                |
| Commands ✓                   | `GET /api/command`; run one with `POST /api/session/{id}/command` `{ name, text, delivery? }`                                     |
| Account and provider state ✓ | `GET /api/integration` (connection states only)                                                                                   |
| Providers panel ✓            | `GET /api/integration`, `GET /api/integration/{id}`, `GET /api/provider` (`integrationID`, `settings.baseURL` host)               |
| Connect with a key ✓         | `POST /api/integration/{id}/connect/key` `{ key, answer? }`                                                                       |
| Connect with OAuth ✓         | `POST …/connect/oauth` `{ methodID, answer? }`, `GET …/connect/oauth/{attemptID}`, `POST …/complete` `{ code }`                   |
| Cancel an OAuth sign-in ✓    | `DELETE /api/integration/{id}/connect/oauth/{attemptID}`                                                                          |
| Connect external ✓           | `POST /api/integration/{id}/connect/external` `{ methodID, answer? }`                                                             |
| Disconnect ✓                 | `DELETE /api/credential/{credentialID}` (each `credential` connection of the integration)                                         |
| Reload config ✓              | `POST /api/location/reload` (retried while a deleted folder is still loaded)                                                      |
| Subagents and skills ✓       | `GET /api/agent` (non-primary, for `@` mentions), `GET /api/skill`                                                                |
| File search (`@`) ✓          | `GET /api/fs/find?query=&limit=` (ranked paths relative to the folder)                                                            |
| Sessions ✓                   | `GET /api/session?parentID=null&archived=false` (workspace list; `archived=true` for the Archived view)                           |
| Subagent sessions ✓          | `GET /api/session?parentID=`, `GET/POST /api/session`                                                                             |
| Rename ✓                     | `PATCH /api/session/{id}` `{ title }`                                                                                             |
| Archive ✓                    | `PATCH /api/session/{id}` `{ archived: true \| false }`                                                                           |
| Delete ✓                     | `DELETE /api/session/{id}`                                                                                                        |
| Goal ✓                       | `POST /api/rpc/opencode.goal/get` `{ input: { sessionID } }` (`output`: `Goal.State` or `null`); `/goal pause`, `resume`, `clear` |
| Instruction files ✓          | `GET /api/location` (`project.directory`), `GET /api/config` (documents' `instructions` only); files read from disk               |
| MCP servers ✓                | `GET /api/mcp` (each server's `status`: connected, pending, disabled, failed or needs_auth, with `error`)                         |
| MCP connect, disconnect ✓    | `POST /api/experimental/mcp/{name}/connect`, `…/disconnect` (for this OpenCode run; `404 McpServerNotFoundError`)                 |
| MCP for this run ✓           | `PUT /api/experimental/mcp/{name}` `{ config }`, `DELETE /api/experimental/mcp/{name}` (runtime only, per folder)                 |
| MCP sign-in ✓                | the server's `integrationID`: `GET /api/integration/{id}`, then the OAuth calls below                                             |
| Fork ✓                       | `POST /api/session/{id}/fork` `{ before? }` (a non-empty session; the copy has `fork`, not `parentID`)                            |
| Side question (`/btw`) ✓     | `POST …/fork` `{}`, `POST …/agent` `{ agent: "plan" }`, `POST …/prompt`, then `DELETE /api/session/{id}` on close                 |
| History ✓                    | `GET /api/session/{id}/message` (newest first, cursor paging; one `limit=1` page past the newest 400 says whether there are more) |
| Prompt, steer, queue ✓       | `POST /api/session/{id}/prompt` `{ text, files?, agents?, skills?, delivery? }`                                                   |
| Model and agent ✓            | `POST /api/session/{id}/model` (with `variant`), `POST /api/session/{id}/agent`                                                   |
| Running state, stop ✓        | `GET /api/session/active`, `POST /api/session/{id}/interrupt`                                                                     |
| Rewind ✓                     | `POST /api/session/{id}/revert/stage` `{ messageID, files }`, then `POST /api/session/{id}/revert/commit`                         |
| Staged rewind ✓              | `DELETE /api/session/{id}/revert` (Restore) or `POST …/revert/commit` (Apply)                                                     |
| Compact                      | `POST /api/session/{id}/compact` `{}`                                                                                             |
| Context messages ✓           | `GET /api/session/{id}/context` (the messages after the last compaction; for what fills the context)                              |
| Usage limits ✓               | `GET /api/experimental/usage/limits?location[directory]=` (`data: null` unless signed in to an OpenCode workspace)                |
| Usage stats ✓                | `GET /api/experimental/session/stats?from=&project=&tools=none` (today's cost in the project)                                     |
| Voice (not used) ✓           | `GET /api/experimental/voice/models`, `POST /api/experimental/voice/session` (see "Voice input" below)                            |
| One-off generation ✓         | `POST /api/experimental/generate/text` `{ prompt, model? }` → `{ data: { text } }` (commit messages; no session)                  |
| Shell (`!command`) ✓         | `POST /api/session/{id}/shell` `{ command }`                                                                                      |
| Permissions ✓                | `GET …/permission`, `POST …/permission/{requestID}/reply` `{ decision, message? }`                                                |
| Folder's project ✓           | `GET /api/location?location[directory]=` (its `project.id`; `C:\` and `c:\` are different projects)                               |
| Always-allowed rules ✓       | `GET /api/permission/saved?projectID=`, `PATCH /api/permission/saved/{id}` `{ action?, resource? }`, `DELETE …/{id}`              |
| Session rules ✓              | `PATCH /api/session/{id}` `{ permissions }` (the whole list), read back with `GET /api/session/{id}`                              |
| Agents' rules ✓              | `GET /api/agent` (each agent's `permissions`, subagents included)                                                                 |
| New session in a mode ✓      | `POST /api/session` `{ location, agent, model, permissions }`                                                                     |
| Questions (forms)            | `GET …/form`, `POST …/form/{formID}/reply` `{ answer }`, `DELETE …/form/{formID}`                                                 |
| Pending (steer/queue) items  | `GET …/inbox`, `DELETE …/inbox/{inboxID}`, `PATCH …/inbox/{inboxID}` `{ delivery }` (from OpenCode's API description)             |
| Agent-only changes ✓         | `GET …/diff?from=…&to=…&context=10000000` (full-file patches; see below)                                                          |
| Rewind preview ✓             | `GET …/message` (each assistant message's `snapshot.files`) and `GET …/diff?from=…&to=…&context=3`                                |
| Events ✓                     | `GET /api/event` (Server-Sent Events, global for all locations)                                                                   |

`decision` is `once`, `always` (only when the request carries `save` patterns, shown as "always allow `npm test *`") or `reject`; a rejection can carry `message`, which OpenCode hands to the agent as what to do instead. Model records can include provider headers or bodies; the adapter drops them on arrival because they can contain secrets. `GET /api/credential` is never called.

## Providers

Checked against the live service (2.4.2), its OpenAPI document and its build, without connecting, changing or removing any credential:

- `GET /api/integration` lists every provider OpenCode can connect (334 in 2.4.2) with its `methods` (`key`, `env` with variable `names`, `oauth`, `command` and `external` with an `id` and `label`, some with a `form` of questions, such as GitHub Copilot's deployment type with a `when` condition, or OpenCode's hidden `server`) and its `connections`: `credential` (`id`, `label`, `method`) or `env` (`name`), each with `status: { status: "needs_auth", message, url }` when it needs a new sign-in. Sidecar keeps states, methods and credential ids; labels (which can hold an email address) are dropped. An unknown id is `404 IntegrationNotFoundError`.
- `GET /api/provider` lists the active providers with their `integrationID`; their `settings` hold the base URL and can hold an `apiKey` (the free `opencode` provider's is `public`), so the adapter keeps only whether the base URL is on this machine. Model counts per provider come from `GET /api/model`. There is no provider error state: the panel's errors are the last failed run's, and OpenCode's `needs_auth` notes.
- A key goes in `POST …/connect/key` `{ key }` (a missing key is `400`); Sidecar asks for it in a masked input box, sends it and keeps no copy. `GET /api/credential` returns every stored secret and is never called. Disconnect sends `DELETE /api/credential/{id}` for each `credential` connection of the integration (an unknown id answers `204`); one connected through an environment variable or the config has nothing to remove.
- OAuth: `POST …/connect/oauth` returns `{ attemptID, url, instructions, mode: auto | code, paste?, time.expires }`. Sidecar opens `url`; for `auto` it polls `GET …/oauth/{attemptID}` (`pending`, `complete`, `failed` with `message`, `expired`) every 2 s, for `code` it asks for the code and sends `POST …/complete` `{ code }`. Giving up sends `DELETE …/oauth/{attemptID}`. An unknown attempt is `404 IntegrationAttemptNotFoundError`; an unknown integration or method in `POST …/connect/oauth` is a `500 UnknownError` in 2.4.2, not the documented `404`.
- `command` methods and questions Sidecar cannot ask in an input box (multiple choice, external pages) run `opencode auth login <id> --method <methodID>` in a VS Code terminal, like Sign in. No 2.4.2 integration has a command method.
- `POST /api/location/reload` rebuilds every loaded folder (pending permissions and forms are cancelled; running sessions continue). It answers `503 ServiceUnavailableError` "Directory not found" while OpenCode still has a folder loaded that was deleted since, and drops that folder as it does, so Sidecar tries again (up to five times). A rebuilt folder briefly lists no models, so the catalog is reloaded once it lists them again.
- A run on a model OpenCode does not have fails before its first step with `session.execution.failed` `{ error: { type: "provider.no-route", message: "Model unavailable: opencode/…" } }` and no step event, so Sidecar puts it down to the session's model. The build's error tags: `provider.auth`, `provider.no-route` (also "Cannot initialize …" for a provider that is not set up), `provider.free-limit`, `provider.go-limit`, `provider.quota`, `provider.budget-limit`, `provider.chatgpt-limit`, `provider.rate-limit`, `provider.transport`, `provider.timeout`, `provider.content-filter`, `provider.invalid-request` (also context overflow) and `provider.error`.
- **Adding an OpenAI-compatible endpoint is config-only.** `POST /api/credential` stores a credential for an existing integration, `GET /api/provider` has no create or update, and `PATCH /api/experimental/config` accepts only `shell`, so a custom provider (base URL, models) is added in `opencode.json`; **Reload config** then picks it up. `POST /api/experimental/integration/wellknown` adds a `.well-known` integration source, which is not the same thing, and is not used.

### Prompt attachments and mentions

- **Files and folders** are `files: [{ uri, name, mention? }]` with `file://` URIs; OpenCode reads them itself (up to 20 MB; a folder is sent as a listing). An `@` mention adds `mention: { start, end, text }`, the token's place in the text.
- **Images** are file entries too: a `file://` URI, or a base64 `data:image/…` URI that OpenCode stores inline (as its terminal UI does for pasted images). A model's `capabilities.input` lists `"image"` when it accepts them.
- **Pasted text** held as a chip is part of `text`: the webview sends it beside the message with its `[Pasted text #n]` token, and the host puts it in at the token after trimming the typed text and finding the `@` mentions (whose offsets move past it), so it reaches OpenCode exactly as pasted. OpenCode stores prompt text byte for byte (checked live, CRLF included); Sidecar sends line endings as `\n`, as the message box does for anything pasted into it.
- **Subagents** go in `agents: [{ name, mention }]` and **skills** in `skills: [{ id, mention }]`.
- **Problems** (Fix with OpenCode) and **selections** are part of `text`: a heading OpenCode's model reads as context and Sidecar's transcript folds back into a chip (`Problems from VS Code (1 error in src/a.ts):` or `Selected code from …`), then one fenced block. Problems name the file relative to the folder with `/`, `line L:C` or `lines A-B`, the severity, `source(code)` and the message, each with the code around it and `>` on its lines. The editor context (`autoContext`) is an ordinary file or selection attachment, added at send time only while its chip is there.

### Custom agents

Checked against the live service (2.4.2), its documentation and its OpenAPI document. Agents are Markdown files: YAML frontmatter, and the body as the system prompt.

- **Where.** A config folder's `agents/` (the documented name) or `agent/` (still read); a subfolder gives an id with a slash (`agents/team/review.md` → `team/review`). `GET /api/config?location[directory]=` lists the config folders, lowest priority first: the global one, `%USERPROFILE%\.config\opencode` on Windows too (not `%APPDATA%`), then the folder's `.opencode` when it existed as OpenCode loaded the folder. A `.opencode` made later is not listed there, but its agents are picked up, so Sidecar also scans `<folder>/.opencode` itself. Agents defined in an `opencode.json` (`agents`) show as read-only; only those ids are read from the config documents, which can hold provider keys.
- **Fields.** `description`, `mode` (`primary`, `subagent` or `all`; any other value and OpenCode drops the agent without an error), `model` (`provider/model#variant`, or `{ providerID, model, variant }`), `permissions` (rules, put between OpenCode's defaults and its final browser rules), `request` (`body.temperature` and other overlays, which OpenCode 2.4 stores but does not send yet), `steps`, `hidden`, `color`, `disabled`. A non-empty body wins over a `system` key. Unknown keys are ignored; a YAML error drops the file silently.
- **OpenCode 1 fields** still load: `tools` (`write`, `patch`, `multiedit` → `edit`; `bash` → `shell`; `task` → `subagent`; true allows, false denies), `permission` (an effect, or patterns with effects), `temperature`, `top_p` (into `request.body`) and `maxSteps` (→ `steps`), converted in that order with repeats dropped. Once a file has `permissions`, `request`, `system` or `disabled`, OpenCode ignores every OpenCode 1 field, so Sidecar converts them (to the same rules, checked live) before it writes one of those.
- **Picking up a change.** OpenCode watches the config folders: a new, changed or deleted file shows in `GET /api/agent` within a second or two and emits `agent.updated` with the folder's `location`. The first request for a folder OpenCode has not loaded lists only the built-in agents. Sidecar polls the list until it shows the change and only after 6 s calls `POST /api/location/reload`, which rebuilds every folder and cancels pending permissions and questions.
- **Built-in agents** are those with no file: `build`, `plan`, `general`, `explore`, and the hidden `compaction`, `title` and `summary`. Build also allows OpenCode's `question` tool; a custom agent does not get that rule.
- **Overriding a built-in** ✓ (`test/live/agents.test.ts`): `agents/build.md` (the exact id; ids are case sensitive) does not replace the built-in but is applied on top of it. `GET /api/agent` still lists one `build`, with the built-in's `name`; each field the file sets (`description`, `mode`, `model`, `request.body.temperature`) replaces the built-in's, the fields it leaves out stay the built-in's, the body replaces the prompt (an empty body leaves the agent with none, also for Explore, whose built-in prompt is long), and its `permissions` come after every built-in rule (Build's `question` allow, Plan's `edit` deny) and before the final browser rules, so they win where both match. Deleting the file brings back the exact built-in record. A global file does the same in every folder; a project file wins over it. Sidecar offers `build`, `plan`, `general` and `explore` (not the hidden ones), after a warning.
- **Roo Code and Kilo Code** keep custom modes in `.roomodes` / `.kilocodemodes` (JSON or YAML, `customModes`) and globally in `<globalStorage>/rooveterinaryinc.roo-cline/settings/custom_modes.yaml` (older: `cline_custom_modes.json`) and `<globalStorage>/kilocode.kilo-code/settings/`, where `globalStorage` is `%APPDATA%\Code\User\globalStorage` on Windows (Insiders, Cursor and VSCodium beside it). Groups map to rules on top of OpenCode's defaults: no `read` → `read`, `glob`, `grep` denied; no `edit` → `edit` denied, `edit` with `fileRegex` → `edit * deny` then `allow` per glob (regular expressions that globs cannot express make every edit ask); no `command` → `shell` denied; `browser` → `webfetch` and `websearch` allowed (otherwise denied; OpenCode's own browser stays off). MCP tools are named per tool in OpenCode's rules, so the `mcp` group is not mapped.

### Goals

`/goal` is OpenCode's goal plugin (`opencode.goal`). Checked live (2.4.2, `test/live/goal.test.ts`) and against its build:

- The plugin keeps one goal per session, `Goal.State` `{ id, objective, status: active | paused | complete, reason?, rounds, maxRounds: 50, stalls?, boot, updatedAt }`, and serves it through its RPC: `POST /api/rpc/opencode.goal/get?location[directory]=` `{ input: { sessionID } }` → `{ output }` (`null` without a goal or for an unknown session). While the folder's plugins load it answers `400 RpcError` `rpc.unavailable`, so Sidecar asks once more and otherwise falls back to the goal's notices in the history (objective and rounds, no status).
- Every change is the event `rpc.opencode.goal.changed` `{ sessionID, goal }` (`goal: null` once cleared), whichever client made it.
- `/goal <objective>` (`POST …/command` `{ name: "goal", text }`) sets it and posts the kickoff as a synthetic message with `metadata: { source: "goal", goalID }`; after each turn a reviewer (a stateless generation) answers `done`, `continue` (another synthetic "Continue working toward the active goal" with the reason and next step, `rounds + 1`), `blocked`, `paused` or `wait`. It stops (`paused`, with a `reason`) when the session fails ("The session failed: …", also at the free limit), is interrupted by the user ("Stopped by the user"), after 50 rounds, after 3 rounds without progress, or when the server restarts. `/goal pause`, `/goal resume` (back to `active`, `rounds: 1`, and a new turn) and `/goal clear` (removes it) control it; `/goal` alone or `pause` without an active goal answer `500 CommandExecutionError` with a message ("No active goal to pause.").

### Instruction files

Which files OpenCode 2.4.2 builds a session's instructions from, from its documentation (opencode.ai/docs/rules), its build and live checks (`test/live/instructions.test.ts`): `session.instructions.updated` carries a hash per instruction part (`core/instructions` for the files, also `core/date`, `core/environment`, …) when a prompt starts, even when the step then fails at the free limit, and the hash changes exactly when a file OpenCode reads changes. `GET /api/experimental/session/{id}/instructions/entries` lists only entries added through the API, and `GET /api/session/{id}/context` has no system prompt, so the hash is the only live signal.

- **Global:** `<global config>/AGENTS.md` (`~/.config/opencode`, also on Windows), or without it `~/.claude/CLAUDE.md`.
- **Project:** only when the folder is inside OpenCode's project (`GET /api/location` → `project.directory`, the Git root or the folder). Every folder from the open one up to the home folder, both included (outside home: up to the project root), so an AGENTS.md above the Git root is read too: its `AGENTS.md`, or its `CLAUDE.md` when it has none. `.opencode/AGENTS.md` is not read. AGENTS.md files below the folder load as the agent reads files there.
- **Config `instructions`:** after the AGENTS.md files, from every config document (`GET /api/config` lists them with `info.instructions`; Sidecar reads only that key, since documents can hold keys). Relative paths and globs are looked up from the folder to the project root, `~/` from home, absolute paths as written, `http(s)` URLs fetched when the config loads. A new entry is picked up without a reload.
- OpenCode watches these files; a change applies to the next session after a second or two. `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` (set on the service) skips every CLAUDE.md, which Sidecar cannot see.
- Sidecar writes only the project's `AGENTS.md` (Remember this, Create). Beside a `CLAUDE.md` OpenCode reads, it warns first and can start the new file as a copy of it; checked live: after that OpenCode reads the new `AGENTS.md` and a change to the `CLAUDE.md` no longer changes the hash.
- `/init` (`GET /api/command`: "guided AGENTS.md setup") is a command; Sidecar runs it like any other.

### MCP servers

Checked live (2.4.2, `test/live/mcp.test.ts`, in a temporary folder) and against its build:

- `GET /api/mcp?location[directory]=` lists `{ name, status: { status, error? }, title?, integrationID? }`. There is no tool list: no endpoint returns a server's tools or their schemas (`GET /api/mcp/resource` lists resources and templates only), so Sidecar shows no tool count or context cost per server.
- `POST …/mcp/{name}/connect` answers `204` once the server has connected or failed, and overrides a `disabled` config until restart; `…/disconnect` removes its tools, after which the list says `disabled`. On a server that needs a sign-in, connect answers `204` and the state stays `needs_auth`.
- `PUT /api/experimental/mcp/{name}` `{ config: { type: "local", command: [...] } | { type: "remote", url } }` adds or replaces a server for the folder at runtime and connects it; nothing is written to a config document, other folders do not see it, and `POST /api/location/reload` or a restart drops it. `DELETE` stops it until then. A name with spaces is accepted; an empty `command` fails with a JavaScript error as its reason, so Sidecar checks names and commands first. A process that exits is `failed` with `Connection closed: MCP server process exited with code N`.
- A remote server that answers `401` with OAuth metadata is `needs_auth` (`error: "Unauthorized"`) with an `integrationID` (`mcp_<hash>`). That integration has `metadata.source: "mcp"` and one `oauth` method, so signing in is the providers' OAuth flow: `POST /api/integration/{id}/connect/oauth` returns the server's authorize page (after OpenCode registered a client with it) in `auto` mode, and once the browser reaches OpenCode's callback the attempt is `complete` and OpenCode reconnects the server by itself. The token is a `credential` connection of the integration (`DELETE /api/credential/{id}` removes it; the live test does). The terminal UI does the same: `needs_auth` with an `integrationID` opens that integration's connect dialog.
- `mcp.status.changed` `{ server }` carries the folder in `location`; Sidecar refreshes an open MCP panel on it.

### Commit messages

"Write commit message with OpenCode" uses `POST /api/experimental/generate/text`, which runs one generation from the server's base configuration and stores nothing, with the chat's selected model as `model: { providerID, id, variant? }`. `POST /api/session/{id}/generate` would also leave the history alone, but its tokens and cost count toward the session, so it is not used. The diff comes from VS Code's Git extension (`repository.diff(true)`, the staged changes), or from the agent's patches in OpenCode's session diff when nothing is staged; the style examples from `repository.log`. The message goes into `repository.inputBox.value`; nothing is committed. Checked live (2.4.2): an unknown model is `404 ModelNotFoundError` with `providerID` and `modelID`; a missing `prompt` is `400 InvalidRequestError`; the free limit is `502 ProviderRequestError` with `reason: "rate_limit"`, `status: 429` and `retryAfterMs`, which Sidecar reports as the model's usage limit.

### Agent changes and the Keep / Undo review

Checked live (2.4.2, `test/live/review.test.ts`, in a temporary Git repository):

- `GET /api/session/{id}/diff` "compares the range's first recorded snapshot with its last". Each agent step records a snapshot at its start and end (also a step that fails at once, such as at the free limit), so edits made between two prompts show in the range like the agent's. A folder that was not a Git repository when OpenCode first loaded it gets no snapshots at all (the diff is empty).
- Without `context`, OpenCode 2.4.2 sends one whole-file hunk per change (`@@ -1,40 +1,41 @@` repeated, each with only its own change), which is not a valid patch once a file has two changes, so it cannot be rebuilt. With a `context` longer than the file it sends one proper full-file hunk; Sidecar asks for `context=10000000` and rebuilds the baseline and the snapshot from it (`src/core/patch.ts`). CRLF lines keep their `\r`. The baseline includes changes the user had made before the session.
- The review splits the two sides into hunks itself (`src/core/review.ts`, a line diff), places each one in the document as it is now through a diff between the snapshot and the document, and undoes one with a `WorkspaceEdit`. Decisions are kept in workspace state (`opencodeSidecar.review`) per session, file and hunk content hash.
- VS Code's Git API (`vscode.git`, version 1) can stage whole files only (`add`), and its `apply` changes the working tree. **Stage kept changes** reads the staged blob (`git cat-file blob :<path>`, its mode from `git ls-files -s`), applies the kept hunks to it and runs `git apply --cached --whitespace=nowarn -` with the patch on stdin, through `execFile` (no shell) with the Git that VS Code uses, in the file's repository. The patch uses the blob's own line endings (LF with `core.autocrlf`); paths are `/`-separated and C-quoted when needed.

### Rewind with code

Checked live: `POST …/revert/stage` with `files: true` reverts what the agent's steps changed, the files in each assistant message's `snapshot.files` from the prompt on (its reply lists them as `files`). A `!command` (`POST …/shell`) is not a step: its changes, and edits made between prompts, are in the session diff but are not reverted. Sidecar's rewind dialog lists the steps' files, the changed files no edit tool reported (written by a shell command), the agent's shell commands since (their changes outside the folder or in ignored files are not in OpenCode's snapshots) and the changed files that stay.

### Staged rewinds

A rewind can be staged without being applied (OpenCode's `/undo`). The session then carries `revert: { messageID, files }`, but its message list still contains every message, so Sidecar hides the turns from `messageID` on. Clearing the rewind resumes the session, which delivers anything still queued for it (for example the output of an earlier `!command`), so the agent may carry on.

## Events

The stream is global, so the controller filters by `sessionID`.

| OpenCode event                                                                                      | Sidecar                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `session.inbox.enqueued/delivered/cancelled/delivery.changed`                                       | pending items; a delivered user item becomes a prompt  |
| `session.execution.started/succeeded/failed/interrupted`                                            | running state, end of a task, readable errors          |
| `session.text.*`, `session.reasoning.*`                                                             | streamed text and thinking (with "Thought for Ns")     |
| `session.tool.*`, `shell.created`                                                                   | tool rows (command, working directory, output, diffs)  |
| `session.shell.started/ended` ✓                                                                     | `!command` as a Shell row                              |
| `session.synthetic` with `metadata.source: "subagent"`                                              | a subagent's report, handed back to its parent         |
| `permission.asked/replied`, `form.created/replied/cancelled`                                        | the permission and question docks                      |
| `session.permissions` ✓                                                                             | the approval badge and the session's rules             |
| `session.step.started/ended/failed`, `session.usage.updated`                                        | context, cost, steps, Budget Guard, cache estimate     |
| `session.step.first-token/streamed` ✓                                                               | a step's stream time, for its tokens a second          |
| `session.revert.staged/committed/cleared` ✓                                                         | reload the open session; a staged rewind shows its bar |
| `session.agent.selected`, `session.model.selected`                                                  | follow an agent or model chosen in another client      |
| `session.compaction.started/ended/failed`                                                           | notices                                                |
| `rpc.opencode.goal.changed` ✓                                                                       | the goal header                                        |
| `mcp.status.changed` ✓                                                                              | refresh the MCP panel (the event's `location`)         |
| `session.skill.activated`                                                                           | a notice naming the skill                              |
| `session.retry.scheduled`                                                                           | a retry notice                                         |
| `session.created/deleted/renamed/archived/unarchived/forked/moved`                                  | the session list; `parentID` marks a subagent          |
| `agent.updated`, `integration.updated`, `provider.updated`, `model.updated`, `models-dev.refreshed` | reload models, agents and account state (debounced)    |

Stored history replays one message at a time: one that is not an object, has no `type` or breaks the replay becomes a placeholder row with its raw JSON, and the rest still shows. Checked live with 1,203 stored messages (`test/live/history.test.ts`, built with `POST /api/session/{id}/synthetic` `{ text, metadata, resume: false }`, which holds each note in the inbox until one run delivers them all): all of them load in about 0.4 s, the newest 400 open through the controller in about 0.2 s. Stored history replays `user`, `assistant` (text, thinking, tool parts), `shell`, `synthetic`, `compaction` and `idle` messages through the same model, with OpenCode's stored times.

## Stuck detection

No endpoint: Sidecar watches the event stream of the open session and its subagents (`src/core/stuck.ts`). A call is the tool's name and its input from `session.tool.called`, with key order, spacing, `\` and drive-letter case evened out and the model's `description` left out, plus its result from `session.tool.success` / `failed` (numbers evened out, so timings do not hide a loop). The same call three times in a row, or two taking turns three times, is a loop; calls that wait or poll (`sleep`, `Start-Sleep`, `tail`, `Get-Job`, a tool named like `*_status` or `*_output`) never are. A busy session (`session.execution.started` without its end) that sends no event for the set minutes has stalled, unless a shell tool is running (no output arrives until it ends) or a permission or question waits; a subagent's events count as progress for its parent. A user message or a delivered steer starts over.

## Permissions and approval modes

How OpenCode 2.4 decides, checked against the live service (and its build):

- A rule is `{ action, resource, effect }` with `effect` `allow`, `ask` or `deny` (`Permission.Rule`). A request names an `action` (`shell`, `edit`, `read`, `glob`, `grep`, `external_directory`, `webfetch`, `websearch`, `subagent`, `skill`, …) and its `resources` (a command, a path, a URL), plus `save`, the patterns an _always_ reply would save.
- The rules checked are the **agent's** (`GET /api/agent`) followed by the **session's** `permissions`. The last rule that matches wins; no match means _ask_; one denied resource denies the request. If the result is _ask_, the folder's **saved** rules (allow only) can still allow it.
- Patterns are globs: `*` any text, `?` one character, a trailing ` *` also matches nothing (`npm test *` matches `npm test`), case-insensitive, with `\` read as `/`. Actions match the same way, so an agent's `{ action: "*", resource: "*" }` covers every action.
- Build allows everything except reading `.env` files (ask) and the browser (deny); Plan also denies `edit` except its plan files. So by default OpenCode asks for very little.
- `PATCH /api/session/{id}` `{ permissions }` replaces the session's list (`[]` clears it; `null` leaves it as it is); an unknown effect is a `400`. Every change emits `session.permissions` with the whole list, whichever client made it. A subagent's session copies its parent's list when it is created (later changes to the parent do not reach it).
- Saved rules have no create endpoint: OpenCode saves the request's `save` patterns when it is answered `always`. `PATCH /api/permission/saved/{id}` changes a rule's `action` or `resource`; a rule the project already has is a `409`.
- The config's `permissions` (global `~/.config/opencode` or a folder's `opencode.json`) cannot be changed through the API: `PATCH /api/experimental/config` only accepts `shell`, and `GET /api/config` lists the config documents. Sidecar never writes config files.
- `POST /api/session/{id}/permission` `{ action, resources, agent?, save? }` evaluates a request without a tool (and opens it when the answer is _ask_). The live tests use it to check what each mode makes OpenCode decide, without a model.

So the least invasive place for each kind of rule:

| Rule                                  | Where                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| An approval mode for a session        | The session's `permissions`, as the first rules                                                                   |
| A mode for the folder                 | Sidecar's workspace state; new sessions Sidecar creates in the folder get the mode's rules in `POST /api/session` |
| The user's own rules for a session    | The session's `permissions`, after the mode's                                                                     |
| _Always allow like this_ for a folder | OpenCode's saved rules: an `always` reply, then `PATCH` its pattern to the one typed (a duplicate is removed)     |
| Anything global                       | Not changed: OpenCode's config stays the user's                                                                   |

A mode's rules are fitted to the session's agent (`src/shared/approval.ts`): for each action the mode sets a catch-all (`edit * ask`, `shell * allow`, …), but an action the agent denies outright gets no rule (Plan keeps not editing), one the agent already treats the same way gets none either, and otherwise the agent's own exceptions for that action are repeated after the catch-all (Build's `.env` asks stay in Auto). Auto adds `deny` rules for destructive commands after its allows. On an agent switch (in Sidecar or another client) Sidecar fits the mode to the new agent. The badge reads the list back after each change and on `session.permissions`: the mode whose rules the list starts with, and the user's rules after them; a list that starts with no mode is _Custom_, an empty one _Default_. The TUI's own "auto accept" setting answers requests in the TUI and is not visible to other clients.

## Side questions

`/btw` forks the open session with `{}` (the whole conversation; `before` may also be `null`), switches the copy to the `plan` agent when OpenCode lists it (and to the model picked in Sidecar when the copy kept another), and prompts it. Checked live:

- A fork keeps the original's agent, model and variant, so the agent is switched explicitly.
- OpenCode answers `400 Cannot fork empty session` for a session with no messages; Sidecar then starts a new session in the folder with the same model and `plan`.
- A fork sends no `session.created`, only `session.forked` (with the original as `parentID`); it is a root session, so `GET /api/session?parentID=null` lists it. Sidecar keeps the ids in workspace state and leaves them out of History until they are deleted.
- The stream is global, so the copy's events (and its subagents', found through `session.created`'s `parentID`) go to the aside card only. Its permission requests are rejected with a short instruction and its questions cancelled, so it never waits on an answer nobody sees.
- Closing interrupts a running copy and deletes it. Archiving was not chosen: it would keep a full copy of the conversation in the Archived list. Ids that could not be deleted (VS Code closed first, OpenCode was away) are deleted at the next start; a `404` counts as deleted.

## Several sessions

The event stream is global, so Sidecar also follows the folder's other sessions for the session strip and its notices, without loading their history. Checked live:

- `session.execution.started/succeeded/failed` carry `sessionID` but no `location`, so a session's folder comes from the folder's session list (or the strip, for older ones), never from the event.
- A `!command` (`POST …/shell`) returns when the command is done and sends no `session.execution.*` events: it does not make a session busy.
- `permission.asked` carries the asking session's id (OpenCode's API description; the live test checks it, and its `location` when present, whenever the free model asks for a permission); `GET /api/session/{id}/permission` ✓ lists pending requests. A session found working at start or after a reconnect has its pending permissions and questions read this way (`GET …/permission`, `GET …/form`, also for its running subagents from `GET /api/session?parentID=`), once per run and without a notification.
- `session.deleted` carries no `location`. A deleted or archived session leaves the strip; a session OpenCode no longer knows answers `404` (`SessionNotFoundError`), also to `POST …/prompt`.
- Subagents are tied to their session through `session.created`'s `parentID`: their requests show on its tab, and it counts as finished once they are done too. Side-question forks are never followed.

## Subagents

OpenCode runs a subagent (the `subagent` tool) in a child session: `session.created` carries `parentID`, and subagents can start their own. The subagent tool returns once the subagent is launched; its report reaches the parent later as a synthetic message, which wakes the parent.

- A subagent's permission requests and questions are raised on its own session, but the parent's run waits for them, so Sidecar shows them in the open conversation and replies to the subagent's session.
- `session.execution.*` events carry their session, so the parent's turn ending does not expire a subagent's pending request.
- A forked session is a root session (it has `fork`, not `parentID`), so it is listed in History and never treated as a subagent. Only the `session.forked` event names the original as `parentID`; Sidecar uses it to refresh the list.
- On reopen, subagents come from `GET /api/session?parentID=` (breadth-first, at most 200); pending requests are fetched only for subagents listed as running.
- A tool call is linked to its subagent through the result's `metadata.sessionID`, or the `sessionID` input when a subagent is continued.

## Usage and costs

Checked against the live service (2.4.2) and its build:

- A step's `session.step.started` names its `agent` and `model`; `session.step.ended` carries its `cost` (USD; `0` for a free model) and `tokens` (`input`, `output`, `reasoning`, `cache.read/write`). OpenCode stores the `created` time of `session.step.first-token` and `session.step.streamed` as the assistant message's `time.firstToken` and `time.streamed`, so live and stored steps give the same stream time: the turn footer's tokens a second is `(output + reasoning) / (streamed − firstToken)`. While text streams no token counts arrive, so the live figure is estimated from the text (about 4 characters a token) and marked as an estimate.
- `session.usage.updated` carries the session's whole cost, which also covers title generation and compaction (`session.usage.recorded` with `source`); the usage menu shows the difference from the steps' sum as "titles and compaction". A subagent's session has its own cost; Sidecar adds a subagent's subagents to it, and all of them to the session's total.
- `GET /api/session/{id}/context` lists the messages a model call is built from (after the last compaction). It does not include the system prompt, tool definitions (MCP included) or instructions, and OpenCode reports no split of the context's tokens, so Sidecar estimates the parts it can see from their text and shows the rest of the reported total as one figure. `GET /api/experimental/session/{id}/instructions/entries` lists only instruction entries added through the API (empty for ordinary sessions), so it is not used.
- `GET /api/experimental/usage/limits` returns `UsageLimits.Info` only when OpenCode is signed in to an OpenCode Console workspace: `go` (OpenCode Go's `rolling`, `weekly` and `monthly` windows, each `{ percent, limited, resetsAt }`) and `budgets` (`{ limit, spent, scope, coverage, models, resetsAt, … }` in USD). Other providers' quotas are not exposed (`data: null`), and nothing is shown for them. Sidecar reads it with the catalog and after each task (at most once a minute).
- `GET /api/experimental/session/stats` sums steps, tokens and cost over a time range (all sessions, or one `project`), with one row per model variant.
- Auto-compaction (`compaction.auto`, `compaction.buffer`) is set in OpenCode's config documents; `PATCH /api/experimental/config` accepts only `shell`, so it cannot be changed through the API and Sidecar offers no control for it.

## Voice input

Sidecar has no microphone button. Checked on this machine (OpenCode 2.4.2, VS Code 1.148, Windows), none of the three ways in works today:

- **OpenCode's voice is realtime speech models on paid keys.** `GET /api/experimental/voice/models` lists `{ model, name, engine, provider, transports, available }` and an optional `default`: in 2.4.2 ten models, OpenAI's `gpt-live-1(.1)` (WebRTC) and `gpt-realtime-1.5` to `2.1(-mini)` (WebRTC and WebSocket), xAI's `grok-voice-3.0` and Google's `gemini-3.8-live(-extended-thinking)` and `gemini-3.1-flash-live-preview` (WebSocket). All are `available: false` here. `POST /api/experimental/voice/session` `{ model, transport: { type: "websocket" } | { type: "webrtc", sdp, dcid? }, session? }` returns `{ transport: { type: "websocket", url, token, expiresAt } }` (an ephemeral token for the provider's socket) or `{ type: "webrtc", sdp }` (the provider's SDP answer); the browser then streams microphone audio to the provider itself. Without a key it answers `503 ServiceUnavailableError` with `service` and a message such as "Voice needs an OpenAI API key on the server (a stored key or OPENAI_API_KEY). ChatGPT sign-in can't start voice sessions." (or a Google key: `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY`); an unknown model is `400 InvalidRequestError` listing the supported ones. The free `opencode` provider and OpenCode's own sign-in cannot start one, and these are spoken conversations with a model, billed by the provider, not dictation into a message box. `test/live/client.test.ts` checks both answers.
- **A VS Code webview cannot use the microphone.** VS Code puts webviews in a cross-origin iframe whose `allow` list is `cross-origin-isolated; autoplay` plus `fullscreen`, `local-network-access`, `clipboard-read` and `clipboard-write` (VS Code 1.148's workbench, `allow` set in its webview element), never `microphone`. Checked in a real VS Code 1.148 webview (a test extension in a temporary profile): `getUserMedia({ audio: true })` fails with `NotAllowedError: Permission denied` and `document.featurePolicy.allowsFeature("microphone")` is `false`, whatever the operating system allows; the same frame in Chrome with `microphone` added to its `allow` list gets the device. So even with a provider key, the webview could not capture audio for OpenCode's voice session or any other.
- **VS Code Speech cannot type into a webview.** `ms-vscode.vscode-speech` (0.16.0) contributes a speech provider through VS Code's proposed `speech` API, which other extensions cannot call. What they can call is VS Code's `workbench.action.editorDictation.start` / `stop`, which dictate into the focused text editor only, not into a webview's text box; VS Code 1.148's own speech-to-text (`chat.speechToText.*`) is for VS Code's chat input. A workaround through a temporary editor tab (dictate there, then move the text into the message box) was tried in VS Code 1.148 with VS Code Speech installed in a temporary profile: both commands run without an error, but no speech session started (the extension was not even activated and its log stayed empty), and real dictation cannot be checked without speaking into a microphone. A button built on that would be unverified and clumsy, so it is not shipped.

What would change this: VS Code allowing `microphone` for extension webviews (or a public speech API for extensions), or OpenCode offering transcription on a provider that its free tier or sign-in covers.

## Compatibility notes

- A folder OpenCode has not loaded yet briefly answers with empty model and command lists. Sidecar retries the models once and the commands twice, and refreshes the commands when the / menu opens.
- A session created or switched without a model variant records it as `default`.
- A fork copies the history under new message ids, so a rewind in the fork names the fork's own message.
- An agent's default model can differ from `GET /api/model/default`, so new sessions are created with an explicit model.
- The prompt-cache clock is an estimate from the last step's time and the `cacheWarmMinutes` setting, shown only when that step reported cache tokens (`tokens.cache.read` or `tokens.cache.write` above zero).
