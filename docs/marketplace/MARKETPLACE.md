# Marketplace release notes (internal)

This folder is not shipped in the VSIX.

## Identity

| Field        | Value                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Display name | Sidecar for OpenCode                                                                            |
| Publisher ID | `charlesknapp` (**placeholder**: replace with the registered publisher before the first upload) |
| Package name | `opencode-sidecar`                                                                              |
| Identifier   | `<publisher>.opencode-sidecar`                                                                  |
| License      | MIT (original copyright kept; see LICENSE)                                                      |

Before the first upload, create the publisher at https://marketplace.visualstudio.com/manage, and set `publisher` in `package.json` (and the manifest test) to its exact, case-sensitive ID. Sidecar's own icons are in `media/` (`icon.png` is rendered from `media/src/icon.svg` with `node scripts/icons.mjs`). After the first upload, never rename `name` or `publisher`: together they form the extension ID that installs and updates track. Setting keys (`opencodeSidecar.*`), command IDs and the view ID are part of users' saved state and must stay stable too.

The listing must say that the extension is independent and not affiliated with OpenCode (the official extension is `sst-dev.opencode`). `LICENSE` keeps every copyright line it has; the MIT License requires that.

## Screenshots and hero

Generated from the real webview bundle with generic demo data, in VS Code Dark Modern colors: `npm run build && node scripts/screenshots.mjs` writes the README set below (800×1720 px, 2× DPR), then `node scripts/hero.mjs` composes `hero.png` (2560×1280) from the icon and two of them. `node scripts/screenshots.mjs --all --out=<folder>` renders every scene, including 300 and 520 px widths, for review.

| File                            | Shows                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `hero.png`                      | Name, tagline and two panels                                                                  |
| `screenshots/timeline.png`      | Turns on the timeline: pinned prompt, times, a read, a shell call, Copy and Bookmark          |
| `screenshots/tools.png`         | A read link, an inline edit diff, a written file and a failed shell command                   |
| `screenshots/subagents.png`     | Subagent rows, a report line, and a subagent's permission request in place of the message box |
| `screenshots/subagent-view.png` | A subagent's own conversation                                                                 |
| `screenshots/question.png`      | A question in place of the message box, with a queued message above it                        |
| `screenshots/commands.png`      | The / action palette                                                                          |
| `screenshots/usage.png`         | The prompt-cache and usage menu                                                               |
| `screenshots/bookmarks.png`     | The Bookmarks popover                                                                         |
| `screenshots/mentions.png`      | The `@` list above the message box, with an image attached                                    |
| `screenshots/onboarding.png`    | First run: the setup card and its checklist                                                   |
| `screenshots/budget.png`        | Budget Guard: the warning, then the stop with its three choices                               |
| `screenshots/agent-changes.png` | Agent changes kept apart from workspace changes                                               |

They are referenced from README.md with relative paths. On the Marketplace, `vsce package` rewrites them to the repository (the `repository` field in `package.json`), so the repository must be public.

## Public URLs

| Item       | URL                                                                      |
| ---------- | ------------------------------------------------------------------------ |
| Repository | https://github.com/charlesknapp/opencode-sidecar                         |
| Homepage   | https://github.com/charlesknapp/opencode-sidecar#readme                  |
| Issues     | https://github.com/charlesknapp/opencode-sidecar/issues                  |
| Security   | https://github.com/charlesknapp/opencode-sidecar/security/advisories/new |
| Release    | https://github.com/charlesknapp/opencode-sidecar/releases/tag/v0.1.0     |

`package.json` contains `repository`, `homepage` and `bugs`; packaging runs plain `vsce package` (no `--allow-missing-repository`, no `--skip-license`).

## Manual upload steps (not automated)

1. Sign in at https://marketplace.visualstudio.com/manage and confirm your publisher exists and matches `publisher` in `package.json` and is owned by you.
2. Build: `npm ci && npm run package` → `dist-vsix/opencode-sidecar-<version>.vsix` (also attach it to the GitHub release). Upload this file.
3. Upload with **New extension → Visual Studio Code** in the web portal and choose the `.vsix` file. This needs no personal access token. (Alternatively `vsce publish --packagePath <file>` with a PAT you create yourself; this project never creates one.)
4. Check the listing: name, icon, README rendering, categories (AI, Chat, Other), license.
5. Install from the Marketplace in a clean VS Code profile and run the smoke test (connect, models, agents, one prompt, a subagent, a permission request, Copy, Stop).
