# Marketplace release notes (internal)

This folder is not shipped in the VSIX.

## Identity

| Field        | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| Display name | Sidecar for OpenCode                                                  |
| Publisher ID | `cadogy` (Visual Studio Marketplace publisher and Open VSX namespace) |
| Package name | `opencode-sidecar`                                                    |
| Identifier   | `cadogy.opencode-sidecar`                                             |
| License      | MIT (see LICENSE)                                                     |

The publisher `cadogy` is created at https://marketplace.visualstudio.com/manage, and the Open VSX namespace of the same name by the first release. Sidecar's own icons are in `media/` (`icon.png` is rendered from `media/src/icon.svg` with `node scripts/icons.mjs`). After the first upload, never rename `name` or `publisher`: together they form the extension ID that installs and updates track. Setting keys (`opencodeSidecar.*`), command IDs and the view ID are part of users' saved state and must stay stable too.

The listing must say that the extension is independent and not affiliated with OpenCode (the official extension is `sst-dev.opencode`).

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

## Releasing

`.github/workflows/release.yml` releases a version when its tag is pushed:

1. Set `version` in `package.json` and add its section to `CHANGELOG.md` (`## <version> (<date>)`).
2. Commit, then `git tag v<version> && git push origin main v<version>`.
3. The workflow runs every check, packages the VSIX, creates the GitHub release with the VSIX and the CHANGELOG section, and publishes to each store whose secret is set:

| Secret     | Store                     | Token                                                                                                                                                                             |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VSCE_PAT` | Visual Studio Marketplace | Azure DevOps personal access token (https://dev.azure.com, User settings → Personal access tokens): organization **All accessible organizations**, scope **Marketplace → Manage** |
| `OVSX_PAT` | Open VSX                  | Access token from https://open-vsx.org/user-settings/tokens, after signing in with GitHub and accepting the Eclipse publisher agreement                                           |

Secrets go in the repository's **Settings → Secrets and variables → Actions**; they never pass through the code or the chat. A store without its secret is skipped, and every step is safe to re-run (**Re-run all jobs**): the release keeps its notes and gets the VSIX replaced, and a version already on a store is skipped.

Without a Marketplace token, upload the release's `.vsix` by hand: https://marketplace.visualstudio.com/manage → **cadogy** → **New extension → Visual Studio Code** (or **⋯ → Update** for a later version).

After a release, install from each store in a clean profile and run the smoke test: connect, models, agents, one prompt, a subagent, a permission request, Copy, Stop.
