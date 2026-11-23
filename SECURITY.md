# Security

Sidecar is a user interface for a locally running OpenCode service. This document describes how it handles connections, permissions, secrets, files and its own view.

## Local service

- By default Sidecar uses the OpenCode 2 background service registered on this machine in OpenCode's own `service.json` (under `$XDG_STATE_HOME/opencode/` or `~/.local/state/opencode/`). It checks the service with `GET /api/info` and verifies the reported process id.
- A registered service that is **not on a loopback address** (`127.0.0.0/8`, `localhost`, `::1`) is refused.
- A custom `opencodeSidecar.serverUrl` must also be loopback unless you enable `opencodeSidecar.allowRemoteServer`. The service password is sent only to the registered service's own origin.
- Sidecar never changes how OpenCode binds. **Start OpenCode** runs `opencode service start`, and OpenCode decides the address.

## Workspace trust

Sidecar declares `untrustedWorkspaces: { supported: false }`, so it is disabled in Restricted Mode. OpenCode can read files and run commands, so use it in trusted workspaces only.

## Permissions and actions

- Every OpenCode permission request, including one raised by a subagent, takes the message box's place until you answer it. **Nothing is approved automatically.**
- **Yes, always allow** is offered only when OpenCode supports it for that request, and OpenCode stores the rule. "Tell the agent what to do instead" rejects the request and hands your text to the agent.
- **Sensitive path warnings** are added for `.env` files (templates such as `.env.example` excluded), SSH keys, GnuPG, private keys and certificates (`.pem`, `.key`, …), keystores (`.jks`, `.p12`, …) and common credential files (`.npmrc`, `.netrc`, cloud CLI credentials, …). Attaching such a file yourself asks for confirmation first.
- **`@` mentions** are checked by the extension, not trusted from the view: a file or folder must exist inside the open folder (sensitive files are confirmed as when attached), and an agent or skill must be one OpenCode lists. Anything else is dropped.
- **Images** from the view must be base64 PNG, JPEG, GIF or WebP `data:` URIs of at most about 5 MB; other types (SVG included) are refused. Picked image files are read by OpenCode, up to its 20 MB limit.
- **`!command`** runs a shell command through OpenCode in the session's folder only when you type it and press Enter, and never while the agent is working.
- **Rewind**, and **Apply** for a rewind staged in another client, ask for confirmation in a dialog over the chat, because OpenCode removes messages (and, if chosen, undoes the agent's file changes). The choice travels with the message (`files`), and the extension still refuses a rewind while the agent is working.

## Credentials and logging

- Sidecar stores no provider credentials and no OpenCode password. The service password is held in memory and used only in the `Authorization` header to the local service.
- Sign-in is OpenCode's own: **Sign in to OpenCode** runs `opencode auth login` in a VS Code terminal, and OpenCode stores the result. Sidecar has no login form, never asks for passwords, emails, API keys or tokens, and never reads browser cookies.
- Account state is read from OpenCode's integration list as connection states only; labels and ids are discarded, and the credential API (`/api/credential`) is never called.
- Model records can include provider headers or request bodies. They are dropped on arrival and never reach the UI or the logs.
- Logs (output channel **Sidecar**) leave out prompts, file contents and tool payloads. Authorization headers, passwords, tokens, API-key patterns and URL credentials are redacted.

## The chat view

- The view runs with a strict Content Security Policy: no remote content, nonce-only scripts, no `eval`.
- Model output is rendered from a parsed Markdown tree with DOM text APIs, never as HTML. Syntax colors come from Prism's tokenizer only: its tokens become text nodes in spans, and Prism's own page highlighting (which writes HTML) is switched off. Links with unsafe schemes are dropped; link clicks are handled by the extension, and only `http(s)` opens externally.
- Every message from the view to the extension is validated against a strict schema (known type, field types, size limits, no extra keys). The view can change only two of Sidecar's own settings (pinned prompts and grouped activity), with fixed values.

## Files and editor tabs

- Agent changes are rebuilt from OpenCode's full-file session patches and shown as read-only virtual documents in VS Code's diff editor. Partial, binary or inconsistent patches are reported as unavailable instead of guessed. Nothing is written to disk.
- A tool call's full command, output or subagent prompt opens as a read-only virtual document; nothing is written to disk or executed.
- Diff actions resolve paths only inside the open folder. File links in the chat open existing files in the editor.
- Bookmarks (a short excerpt of an answer and its session's title) are kept in VS Code's workspace storage on your machine.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting:

https://github.com/charlesknapp/opencode-sidecar/security/advisories/new

Please do not open a public issue for security problems, and never include secrets or credentials in reports. For everything else, use the issue tracker: https://github.com/charlesknapp/opencode-sidecar/issues
