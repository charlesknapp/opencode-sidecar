import type { ArtName } from "@/config/site"

// How-to guides. Every claim here comes from Sidecar's README or OpenCode's own docs
// (opencode.ai/docs/providers and /docs/config); keep it that way when editing.

export type GuideBlock =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "steps"; items: readonly string[] }
  | { type: "list"; items: readonly string[] }
  | { type: "code"; label: string; code: string }
  | { type: "note"; text: string }
  | { type: "art"; name: ArtName; caption: string }

export type Guide = {
  slug: string
  title: string
  short: string
  /** A few words for the footer. */
  nav: string
  description: string
  summary: string
  updated: string
  blocks: readonly GuideBlock[]
}

export const guides: readonly Guide[] = [
  {
    slug: "opencode-local-models-vs-code",
    title: "Use OpenCode with local models in VS Code",
    short: "Local models: Ollama and LM Studio",
    nav: "Local models",
    description:
      "Run the OpenCode agent on Ollama or LM Studio and chat with it in VS Code through Sidecar. No account or API key for the model.",
    summary:
      "OpenCode finds Ollama and LM Studio on your machine by itself. Start one, pull a model, and pick it in Sidecar's model menu. The model needs no account or API key.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "What you need" },
      {
        type: "list",
        items: [
          "VS Code 1.95 or newer, or Cursor, Windsurf or VSCodium.",
          "[OpenCode](https://opencode.ai/docs#install) 2.x with its background service.",
          "Sidecar for OpenCode, from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=cadogy.opencode-sidecar) or [Open VSX](https://open-vsx.org/extension/cadogy/opencode-sidecar).",
          "[Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai).",
        ],
      },
      { type: "h2", text: "With Ollama" },
      {
        type: "steps",
        items: [
          "Start Ollama, for example with `ollama serve`.",
          "Pull a model, such as `ollama pull qwen3:8b`.",
          "That's all OpenCode needs. It looks for Ollama at `http://127.0.0.1:11434` and adds its models to the model list without an account connection. Embedding-only models are left out.",
        ],
      },
      {
        type: "code",
        label: "Terminal",
        code: "ollama serve\nollama pull qwen3:8b",
      },
      { type: "h2", text: "With LM Studio" },
      {
        type: "steps",
        items: [
          "Download a model in LM Studio.",
          "Start LM Studio's local server. Its default address is `http://127.0.0.1:1234/v1`.",
          "OpenCode discovers LM Studio's language models from that server.",
        ],
      },
      { type: "h2", text: "Pick the model in Sidecar" },
      {
        type: "art",
        name: "models",
        caption: "Hover: pick a model Ollama serves.",
      },
      {
        type: "steps",
        items: [
          "Click the Sidecar icon in the Activity Bar.",
          "If you started Ollama or LM Studio after Sidecar connected, run **Sidecar: Refresh Connection** from the Command Palette. It checks OpenCode's providers and models again.",
          "Open the model menu in the message box and pick the local model. Models are listed by provider.",
          "To preselect it in new workspaces, set `opencodeSidecar.defaultModel` to its `providerID/modelID`, such as `ollama/qwen3:8b`.",
        ],
      },
      { type: "h2", text: "Ollama or LM Studio on another machine" },
      {
        type: "p",
        text: "Point OpenCode at the server in `opencode.json` with `settings.baseURL`, and include `/v1` at the end. The global file is `~/.config/opencode/opencode.json`; a project can have its own `opencode.json` in its root.",
      },
      {
        type: "code",
        label: "opencode.json",
        code: `{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "ollama": {
      "settings": { "baseURL": "http://gpu-box:11434/v1" }
    },
    "lmstudio": {
      "settings": { "baseURL": "http://gpu-box:1234/v1" }
    }
  }
}`,
      },
      {
        type: "note",
        text: "For another OpenAI-compatible runtime, OpenCode's [provider docs](https://opencode.ai/docs/providers) describe a custom provider where you list its models yourself.",
      },
      {
        type: "p",
        text: "After editing `opencode.json`, choose **Reload config** in Sidecar's Providers panel (**/ → Providers…**) so OpenCode reads it again without a restart.",
      },
      { type: "h2", text: "What's different with a local model" },
      {
        type: "list",
        items: [
          "**Budget Guard counts steps.** If OpenCode reports no cost for a model, only the step limit applies.",
          "**No prompt-cache clock.** It shows only when a step reports prompt-cache tokens, which most local models don't.",
          "**Images.** Sidecar tells you when the model you picked doesn't list image input in OpenCode.",
          "**Tool calls matter.** The agent works by calling tools to read, search, edit and run commands, so pick a model that handles tool calls well.",
          "**Context size matters too.** OpenCode's instructions and tools need about 16k tokens of context, and Ollama's default `num_ctx` is 2048–4096. **Sidecar: Check OpenCode Setup** warns when a local model's context is below 16k and says how to raise it.",
          "**Where requests go.** Sidecar talks only to your local OpenCode service, and OpenCode sends the model's requests to the Ollama or LM Studio server you use.",
        ],
      },
    ],
  },
  {
    slug: "opencode-cursor-windsurf-vscodium",
    title: "OpenCode in Cursor, Windsurf and VSCodium",
    short: "Cursor, Windsurf and VSCodium",
    nav: "Cursor and Windsurf",
    description:
      "Install Sidecar for OpenCode from Open VSX in Cursor, Windsurf or VSCodium, and use the OpenCode agent in a chat panel there.",
    summary:
      "Cursor, Windsurf and VSCodium install extensions from Open VSX, where Sidecar is published as `cadogy.opencode-sidecar`. It works just as it does in VS Code, with the OpenCode service on your machine.",
    updated: "2026-11-24",
    blocks: [
      { type: "h2", text: "Install from the Extensions view" },
      {
        type: "steps",
        items: [
          "Open the Extensions view.",
          "Search for **OpenCode Sidecar**.",
          "Install **Sidecar for OpenCode**, ID `cadogy.opencode-sidecar`. The official OpenCode extension is a different one, `sst-dev.opencode`, which opens OpenCode's terminal UI.",
        ],
      },
      { type: "h2", text: "Or install from a terminal" },
      {
        type: "code",
        label: "Terminal",
        code: `cursor --install-extension cadogy.opencode-sidecar
windsurf --install-extension cadogy.opencode-sidecar
codium --install-extension cadogy.opencode-sidecar`,
      },
      {
        type: "note",
        text: "Each command needs that editor's command-line launcher on your `PATH`.",
      },
      { type: "h2", text: "Offline or behind a firewall" },
      {
        type: "steps",
        items: [
          "Download the `.vsix` file from [GitHub Releases](https://github.com/charlesknapp/opencode-sidecar/releases).",
          "Run **Extensions: Install from VSIX…** from the Command Palette and pick the file.",
        ],
      },
      { type: "h2", text: "Set up OpenCode" },
      {
        type: "art",
        name: "setup",
        caption:
          "Hover: start OpenCode; the checklist fills in and the chat opens.",
      },
      {
        type: "steps",
        items: [
          "Click the Sidecar icon in the Activity Bar.",
          "If something is missing, the setup card helps: **Install OpenCode** opens the official install guide, **Start OpenCode** runs `opencode service start`, and **Sign in to OpenCode** runs OpenCode's own sign-in in a terminal. If you already use OpenCode, you won't see the card.",
          "Pick a model in the model menu and start chatting.",
        ],
      },
      { type: "h2", text: "Good to know" },
      {
        type: "list",
        items: [
          "**Requirements.** An editor based on VS Code 1.95 or newer, a trusted workspace, and OpenCode 2.x.",
          "**Updates.** Your editor updates Sidecar from Open VSX like any other extension.",
          "**Placement.** Drag the Sidecar icon to the Secondary Side Bar, where your editor has one, to keep the chat beside your code. The panel works from about 300 px wide.",
          "**Alongside the editor's own AI.** Sidecar is a panel of its own and doesn't replace your editor's assistant, so you can use both.",
        ],
      },
    ],
  },
  {
    slug: "opencode-permissions-budget-guard",
    title:
      "Keep the OpenCode agent in check: permissions, approval modes and Budget Guard",
    short: "Permissions, approval modes and Budget Guard",
    nav: "Permissions",
    description:
      "Answer OpenCode's permission requests in Sidecar, pick Ask, Balanced or Auto, edit permission rules, and stop a runaway task at a cost or step limit.",
    summary:
      "Sidecar approves nothing on its own. OpenCode's permission requests wait in place of the message box until you answer, an approval mode you choose decides what may run without asking, and Budget Guard stops a task that runs past the cost or steps you allow.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "Answer a permission request" },
      {
        type: "p",
        text: "When OpenCode asks before it runs a command or changes a file, the request takes the place of the message box. It shows what the agent wants to do and, when a subagent asks, which one.",
      },
      {
        type: "art",
        name: "permission",
        caption: "Hover to answer: the choice moves to Yes, always allow.",
      },
      {
        type: "steps",
        items: [
          "**1 Yes** allows it this once.",
          "**2 Yes, always allow**, when OpenCode offers it, makes OpenCode save a rule for the folder so it doesn't ask again.",
          "**3 No** refuses. Type in the box instead to refuse and tell the agent what to do.",
          "Press 1, 2 or 3 to answer, or Esc for No.",
        ],
      },
      {
        type: "p",
        text: "Sensitive paths get a warning. Requests raised inside a subagent come back to you in the chat, a count on Sidecar's icon shows answers that are waiting even with the panel hidden, and a notification says what the agent is asking.",
      },
      { type: "h2", text: "Always allow commands like this" },
      {
        type: "p",
        text: "For a command you run often with small differences, choose **Always allow commands like this…** in the request. Sidecar suggests a pattern you can edit, such as `npm test *` for `npm test -- --grep foo`, says whether it covers the request, and saves it for this session or, when OpenCode offers _always_, for the folder.",
      },
      { type: "h2", text: "Choose an approval mode" },
      {
        type: "art",
        name: "modes",
        caption:
          "Hover: switch to Balanced, and the next edit runs without asking.",
      },
      {
        type: "p",
        text: "The badge in the header shows how much the agent may do without asking, as OpenCode reports it. It is just a shield until you pick a mode. Click it to switch:",
      },
      {
        type: "list",
        items: [
          "**Ask** asks before every edit, command and web request.",
          "**Balanced** lets reads, searches and edits in the folder run, and asks for commands, web requests and files outside the folder.",
          "**Auto** lets everything run and blocks destructive commands such as `rm -rf`, `git push --force`, `git reset --hard`, `Remove-Item -Recurse` and `rmdir /s`. Switching to it asks once first.",
        ],
      },
      {
        type: "p",
        text: "**Apply to** picks this session or the folder, where new sessions start in the mode. Modes are OpenCode's own permission rules on the session, added after the agent's rules, so Plan still never edits. OpenCode's config files are never changed, and a mode set from OpenCode's terminal UI or another window shows on the badge too.",
      },
      {
        type: "note",
        text: "A mode reaches subagents started after you set it; one already running keeps its rules.",
      },
      { type: "h2", text: "Edit the permission rules" },
      {
        type: "p",
        text: "Choose **Permission rules…** in the badge's menu or the **/** palette. It lists the session's rules: the mode's, read-only, and your own, which you can add, edit or remove as an action, a pattern and Allow, Ask or Deny. Below them are the folder's _always allowed_ rules OpenCode saved, which you can edit or remove. In patterns, `*` matches anything, and `npm test *` also matches `npm test`.",
      },
      { type: "h2", text: "Set a Budget Guard limit" },
      {
        type: "p",
        text: "Budget Guard is a local limit on cost and steps for each task. Set it with the slider in the model menu; ←/→ changes the level. The defaults:",
      },
      {
        type: "list",
        items: [
          "**Small:** $0.10 or 20 steps",
          "**Medium:** $0.30 or 50 steps",
          "**Large:** $1.00 or 120 steps",
          "**Custom:** $0.50 or 80 steps",
        ],
      },
      {
        type: "art",
        name: "budget",
        caption: "Hover to run past the limit.",
      },
      {
        type: "steps",
        items: [
          "At 80% of a limit, Sidecar warns you on the timeline.",
          "At the limit, Budget Guard stops the agent through OpenCode's own cancellation. It stops before the step that would go over the cost limit, judged by the task's average step, and never in the middle of an edit: a file being written is finished first.",
          "You choose: **Continue once**, **Increase budget** or **Start new session**.",
        ],
      },
      {
        type: "note",
        text: "If OpenCode reports no cost for a model, only steps count. Click the context ring in the message box to see the session's context, cost, steps and task budget.",
      },
      { type: "h2", text: "When the agent seems stuck" },
      {
        type: "p",
        text: "If the agent repeats the same tool call with the same result three times, goes back and forth between two calls, or sends nothing for 3 minutes while it runs, a card on the timeline names the call and offers **Stop**, **Steer…** (a suggested message in steer mode) and **Dismiss**. It never stops anything by itself. Set the minutes with `opencodeSidecar.stuckMinutes`, or turn it off with `opencodeSidecar.stuckDetection`.",
      },
      { type: "h2", text: "Stop the agent yourself" },
      {
        type: "p",
        text: "Press Esc in the message box or run **Sidecar: Stop** to stop the running task. Each subagent has its own **Stop**, so you can end one and let the rest carry on.",
      },
    ],
  },
  {
    slug: "review-opencode-changes-vs-code",
    title: "Review the OpenCode agent's changes hunk by hunk in VS Code",
    short: "Review changes hunk by hunk",
    nav: "Reviewing changes",
    description:
      "Keep or undo each change the OpenCode agent made, right in the editor, without touching your own edits. Then stage only what you kept.",
    summary:
      "Sidecar marks every change the agent made with **Keep | Undo** in the editor. Undo puts back just that change, your own edits are never touched, and **Stage kept changes** stages exactly what you kept.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "What you need" },
      {
        type: "list",
        items: [
          "Sidecar for OpenCode 0.2.0 or newer, with OpenCode 2.x.",
          "A Git repository. The review knows the agent's changes from OpenCode's session snapshots, which OpenCode only takes in a Git repository.",
        ],
      },
      { type: "h2", text: "Keep or undo one change" },
      {
        type: "art",
        name: "review",
        caption: "Hover to keep one change and undo the other.",
      },
      {
        type: "steps",
        items: [
          "Open a file the agent changed, or use **Review all** in the agent changes strip above the message box to see them all.",
          "Each change has **Keep | Undo** above it. Added lines are shaded, and hovering a change shows the lines it removed.",
          "**Keep** marks the change as reviewed and leaves it in place.",
          "**Undo** puts back exactly what was there before, as an ordinary editor edit. The file is left unsaved for you to save, and Ctrl+Z (Cmd+Z) brings the change back.",
        ],
      },
      {
        type: "p",
        text: "Undo works also after you edited other parts of the file. If you edited the change itself since, it says _You edited this since — compare_ instead of guessing, and changes you made yourself are never touched.",
      },
      { type: "h2", text: "Whole files and the whole task" },
      {
        type: "list",
        items: [
          "**Keep file** and **Undo file** at the top of the editor decide whatever is left in that file. A file the agent created is deleted after asking; a file it deleted is restored.",
          "**Review all** (or **Sidecar: Review Agent Changes**) lists every file with its changes to review, kept and undone, with **Keep all** and **Undo all** (both ask first), **Next change** and **Open all diffs**.",
          "**Alt+]** and **Alt+[** go to the next and previous change while a review is active. VS Code's inline suggestions keep those keys while one shows.",
          "Binary files, incomplete snapshots and very large files are reviewed as a whole file, with the diff editor.",
        ],
      },
      { type: "h2", text: "Stage only what you kept" },
      {
        type: "p",
        text: "**Stage kept changes** (or **Sidecar: Stage Kept Agent Changes**) stages exactly the changes you kept, also when your staged version of the file differs elsewhere. Line endings and Windows paths are handled. A change the staged version already has, or that differs there, is reported rather than forced.",
      },
      {
        type: "p",
        text: "Then commit as usual. **Write commit message with OpenCode**, the sparkle in the Source Control title bar, writes a message for the staged changes into the commit box with the chat's model. It never commits for you.",
      },
      { type: "h2", text: "Your decisions stay" },
      {
        type: "p",
        text: "Keep and Undo are saved per session in the workspace, so switching sessions, reloading the window or restarting VS Code keeps them. When the agent edits a file you already reviewed, only the new changes come up for review.",
      },
      { type: "h2", text: "Undo a whole turn instead" },
      {
        type: "p",
        text: "To go back further, hover a prompt in the chat and click **↺**. _Rewind conversation and code_ removes that prompt and everything after it, and reverts OpenCode's file changes since then. The dialog lists the files that revert, warns when shell commands ran since, and names files that changed outside the agent's steps, which stay as they are.",
      },
      { type: "h2", text: "Good to know" },
      {
        type: "list",
        items: [
          "Edits made between two prompts, yours or a `!` command's, are counted with the agent's, as OpenCode's session diff counts them.",
          "Files outside the open folder are not reviewed.",
          "A change the agent made right next to one you already decided comes back as one new change to review.",
          "**Agent changes** stay apart from **Workspace changes**, the usual HEAD to working tree diff, so edits you already had are not counted as the agent's.",
        ],
      },
    ],
  },
  {
    slug: "roo-code-kilo-code-modes-opencode-agents",
    title: "Move from Roo Code or Kilo Code: modes as OpenCode agents",
    short: "Roo Code and Kilo Code modes as agents",
    nav: "Roo and Kilo modes",
    description:
      "Import your Roo Code or Kilo Code custom modes as OpenCode agents with Sidecar, and create or edit OpenCode agents in a form.",
    summary:
      "Sidecar finds your `.roomodes`, `.kilocodemodes` and global custom modes, previews each as an OpenCode agent, and writes OpenCode's own agent files. Its Agents panel then creates and edits agents in a form.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "Import your modes" },
      {
        type: "art",
        name: "import",
        caption: "Hover: check one more mode to import.",
      },
      {
        type: "steps",
        items: [
          "Open the folder with your `.roomodes` or `.kilocodemodes` file (JSON or YAML) in VS Code.",
          "Run **Sidecar: Import Roo Code Modes as Agents**, or open the Agents panel (**/ → Agents…**) and use its banner. Sidecar also finds the global custom modes of Roo Code and Kilo Code in VS Code, VS Code Insiders, Cursor and VSCodium.",
          "The preview shows each mode as an agent, with what does not carry over exactly. Check the ones you want.",
          "Import. Each becomes a Markdown file in the project's `.opencode/agents/`, and OpenCode picks it up without a restart.",
        ],
      },
      { type: "h2", text: "How a mode becomes an agent" },
      {
        type: "list",
        items: [
          "**Role and instructions** become the agent's prompt, including the files in `.roo/rules-<slug>/`.",
          "**Tool groups** become permissions: a mode without the command group may not run commands, one without the browser group may not fetch or search the web, and so on.",
          "**An edit `fileRegex`** becomes globs where a glob can express it. Otherwise edits ask first.",
          "**An orchestrator** becomes a primary agent that may start the other imported agents as subagents. Other modes can be picked as the main agent or started as subagents.",
          "**A mode named after an agent you have** starts unchecked. One named after a built-in agent warns once checked, since it would override it.",
        ],
      },
      {
        type: "p",
        text: "For example, this mode may read anything and edit only Markdown files:",
      },
      {
        type: "code",
        label: ".roomodes",
        code: `{
  "customModes": [
    {
      "slug": "docs-writer",
      "name": "Docs Writer",
      "roleDefinition": "You write and edit project documentation.",
      "whenToUse": "Writing or updating docs",
      "groups": ["read", ["edit", { "fileRegex": "\\\\.md$" }]]
    }
  ]
}`,
      },
      {
        type: "p",
        text: "Sidecar writes it as this OpenCode agent. What does not carry over exactly is noted at the top of the file:",
      },
      {
        type: "code",
        label: ".opencode/agents/docs-writer.md",
        code: `---
# Imported from the Docs Writer mode (docs-writer) in .roomodes.
# Not carried over exactly:
# - MCP tools are not limited: OpenCode's permissions name each MCP tool, not a group.
description: Writing or updating docs
mode: all
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
  - action: websearch
    resource: "*"
    effect: deny
  - action: edit
    resource: "*.md"
    effect: allow
---

You write and edit project documentation.`,
      },
      { type: "h2", text: "Create or edit an agent" },
      {
        type: "steps",
        items: [
          "Open the Agents panel: **/ → Agents…**, **Manage agents…** under the agent switcher, or **Sidecar: Manage Agents**. It lists the folder's agents: built-in ones read-only, your own with their mode, model and file.",
          "Click **New agent** or **Edit**. Fill in the name, the description, the mode (primary, subagent or both), a model and variant, the temperature, the permission switches (read, edit, commands, web fetch and search, subagents and skills: inherit, allow, ask or deny) and the system prompt.",
          "Save. The file goes in `.opencode/agents/`, or after asking in OpenCode's global config folder. A new primary agent is selected at once, and **Save and open in editor** opens the file itself.",
        ],
      },
      {
        type: "code",
        label: ".opencode/agents/reviewer.md",
        code: `---
description: Reviews changes for bugs and missing tests
mode: subagent
model: anthropic/claude-sonnet-4-5
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: ask
---

You review code changes. Point out bugs, risky edits and missing tests. Do not edit files.`,
      },
      {
        type: "p",
        text: "Editing changes only the fields you changed, so your comments and any frontmatter Sidecar doesn't know stay. **Delete** asks first, and nothing is overwritten without asking.",
      },
      { type: "h2", text: "Override a built-in agent" },
      {
        type: "p",
        text: "Naming an agent `build`, `plan`, `general` or `explore` overrides that built-in agent, after a warning that says what it does. OpenCode applies the file on top of the built-in: the description, mode, model and prompt you set win, and your permissions come after the built-in's rules. The panel then shows the row as **Built-in, overridden by** the file, with **Remove override**.",
      },
      { type: "h2", text: "Project instructions" },
      {
        type: "p",
        text: "Roo Code's rules files have a counterpart in OpenCode's `AGENTS.md`. **/ → Project instructions…** shows which instruction files OpenCode reads for the folder, marked **In use**, **Not used** or **Not created**. You can **Create AGENTS.md** from a short template or **Set up with /init**. **Remember this** under a reply adds a line to it after showing you the change.",
      },
      {
        type: "note",
        text: "OpenCode reads `CLAUDE.md` only while there is no `AGENTS.md` beside it. When you create one, Sidecar offers to copy your `CLAUDE.md` into it so no instruction is lost.",
      },
      { type: "h2", text: "Good to know" },
      {
        type: "list",
        items: [
          "Agent files are read with a YAML subset. A file using anchors, aliases or tags opens in the editor instead of the form.",
          "OpenCode 2.4 stores an agent's temperature but does not send it to the model yet.",
        ],
      },
    ],
  },
  {
    slug: "opencode-providers-setup-check",
    title: "Connect OpenCode providers and fix setup problems in VS Code",
    short: "Providers and fixing setup problems",
    nav: "Providers and setup",
    description:
      "Connect model providers through OpenCode's own sign-in in Sidecar, read each provider's state, and find setup problems with one report.",
    summary:
      "Sidecar's Providers panel connects, signs in again or disconnects a provider through OpenCode's own sign-in, and **Check OpenCode Setup** reports in one place what a working setup needs.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "Open the Providers panel" },
      {
        type: "art",
        name: "providers",
        caption: "Hover: sign in to a provider again.",
      },
      {
        type: "p",
        text: "Type **/** in the message box and choose **Providers…**, or click **Manage providers…** under the model list, or run **Sidecar: Manage Providers**. Each connected provider shows:",
      },
      {
        type: "list",
        items: [
          "Its state: connected, needs sign-in, or the last error in plain English.",
          "How it is connected: OAuth, an API key, an environment variable or OpenCode's config. The secret itself is never shown.",
          "How many models it offers.",
        ],
      },
      { type: "h2", text: "Connect a provider" },
      {
        type: "steps",
        items: [
          "Click **Connect** and search. The list has every provider OpenCode knows, over 300.",
          "Follow OpenCode's own sign-in for it: a browser page, a masked box for an API key, or OpenCode's terminal flow.",
          "The provider's models appear in the model menu once OpenCode has them.",
        ],
      },
      {
        type: "note",
        text: "A key you type goes straight to OpenCode, which stores it. Sidecar does not keep or log it.",
      },
      {
        type: "p",
        text: "**Sign in again** runs a provider's sign-in once more, for example after a key changed or a sign-in expired. **Disconnect** asks first, then removes the stored sign-in.",
      },
      { type: "h2", text: "Custom and OpenAI-compatible endpoints" },
      {
        type: "p",
        text: "OpenCode takes custom providers only from its config. Add the endpoint to `opencode.json` as OpenCode's [provider docs](https://opencode.ai/docs/providers) describe, then click **Reload config** in the panel so OpenCode reads it again without a restart.",
      },
      { type: "h2", text: "When a run fails" },
      {
        type: "p",
        text: "When a run fails because the provider rejected the key, a sign-in expired, the model is gone or the provider isn't set up, the error card offers **Sign in to _Provider_ again** and **Choose another model**. Sidecar goes by OpenCode's error tags, so it works however the provider words its error.",
      },
      {
        type: "p",
        text: "When OpenCode is signed in to an OpenCode workspace, the usage menu (click the context ring) shows the OpenCode Go allowance and Console budgets with when each resets. A small warning chip appears beside the ring once one is 80% used.",
      },
      { type: "h2", text: "Check the whole setup" },
      {
        type: "p",
        text: "Run **Sidecar: Check OpenCode Setup**. It is also in the **/** palette, the Providers panel and the setup card. It opens one Markdown report with **Copy Report**, handy for a bug report. It checks:",
      },
      {
        type: "list",
        items: [
          "Whether the `opencode` program is found, and its version.",
          "The background service: registered, reachable, and the same process and version.",
          "Sign-in, and whether your default model is offered.",
          "Providers that need a sign-in or whose last run failed.",
          "On Windows: whether `opencode` is on `PATH`, and whether the folder's drive letter is sent the way OpenCode records it.",
          "For a local server such as Ollama or LM Studio: a warning when a model's context is under 16k tokens, too small for OpenCode's instructions and tools.",
        ],
      },
      { type: "h2", text: "Common fixes" },
      {
        type: "list",
        items: [
          "**OpenCode isn't running.** Click **Start OpenCode** on the setup card, which runs `opencode service start`, or set `opencodeSidecar.autoStart`.",
          "**`opencode` isn't found.** Sidecar searches `PATH` and the common install locations. Otherwise set `opencodeSidecar.executablePath` to the program.",
          "**A service bound to every interface.** A service registered at `0.0.0.0` is reached at `127.0.0.1`. To use another server, set `opencodeSidecar.serverUrl`, and `opencodeSidecar.allowRemoteServer` if it isn't on this machine.",
          "**Models are missing after you started Ollama or connected a provider elsewhere.** Run **Sidecar: Refresh Connection**.",
        ],
      },
    ],
  },
  {
    slug: "opencode-several-sessions-side-questions",
    title: "Run several OpenCode sessions, side questions and goals in VS Code",
    short: "Several sessions, side questions and goals",
    nav: "Sessions and goals",
    description:
      "Watch several OpenCode sessions at once with Sidecar's session strip, ask side questions with /btw, and follow a /goal from a header.",
    summary:
      "The session strip keeps your open sessions as tabs with their status, and a notification says when one you aren't looking at needs you. Ask quick questions with `/btw` without touching the agent's context, and follow a `/goal` from a header.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "The session strip" },
      {
        type: "art",
        name: "sessions",
        caption:
          "Hover: one session finishes and another asks for your answer.",
      },
      {
        type: "p",
        text: "Under the header, the strip shows up to six sessions you opened lately in the folder, plus any that are working or waiting for you. Each tab has a status dot: working, waiting for your answer, finished, or failed since you last looked. It appears once two or more sessions are on it.",
      },
      {
        type: "list",
        items: [
          "Click a tab to switch, or use ←/→ once a tab has the focus. The strip is one Tab stop.",
          "× (or Delete) only takes a session off the strip. It stays in History.",
          "The strip remembers its tabs per folder. `opencodeSidecar.sessionStrip` hides it.",
        ],
      },
      { type: "h2", text: "Notifications from the background" },
      {
        type: "p",
        text: "When a session you aren't looking at finishes, fails, or asks for a permission or an answer, a notification says so, with **Open** to switch to it. The count on Sidecar's icon and in the Status Bar includes its waiting requests. Notifications follow the `opencodeSidecar.notifications.*` settings.",
      },
      {
        type: "p",
        text: "Sessions started in OpenCode's terminal UI or another window show up too. Side questions and subagents never get a tab of their own: a subagent's request shows on its session's tab.",
      },
      { type: "h2", text: "Ask aside with /btw" },
      {
        type: "art",
        name: "aside",
        caption:
          "Hover: the answer arrives while the agent works, then joins the session.",
      },
      {
        type: "p",
        text: "Type `/btw` and your question, or pick **Ask aside…** in the **/** palette, to ask something without derailing the agent or adding to its context.",
      },
      {
        type: "code",
        label: "Message box",
        code: "/btw what does the retry option in fetchUser do?",
      },
      {
        type: "list",
        items: [
          "The question runs in a hidden copy of the session, so it knows the conversation. It uses the Plan agent, which cannot edit files, and any permission it asks for is declined.",
          "The answer streams into a card above the chat while the main task carries on.",
          "**Ask** follows up in the same side thread.",
          "**Add to session** adds the latest answer to the session as a message, queued while the agent works.",
          "**Close** deletes the copy. The card folds to one line, and does so by itself once the answer is done and you carry on in the session.",
        ],
      },
      {
        type: "p",
        text: "Copies never show in History. One left behind when VS Code closed is deleted at the next start.",
      },
      { type: "h2", text: "Follow a goal" },
      {
        type: "art",
        name: "goal",
        caption: "Hover: the tests pass and the goal is achieved.",
      },
      {
        type: "p",
        text: "OpenCode's `/goal` keeps the agent working toward an objective over several rounds. While a session has one, a one-line header above the conversation shows the objective and whether it is in progress, achieved or stopped.",
      },
      {
        type: "code",
        label: "Message box",
        code: "/goal make every test in test/auth pass",
      },
      {
        type: "list",
        items: [
          "Click the header for OpenCode's reason (such as the free limit or your interrupt) and the round, out of OpenCode's 50.",
          "**Rounds** steps through the goal's notices in the conversation.",
          "**Pause**, **Resume** and **End goal** run OpenCode's own `/goal pause`, `/goal resume` and `/goal clear`. Ending asks first. **Clear** removes an achieved goal.",
          "A goal changed in the terminal UI or another window shows too.",
        ],
      },
      { type: "h2", text: "Steer, queue or stop" },
      {
        type: "p",
        text: "While the agent works, a switch in the message box chooses what Enter does. **Steer** has the agent read your message at its next step; **queue** sends it when the task ends. **Alt+Enter** sends one message the other way. If the agent seems stuck repeating itself, a card offers **Stop**, **Steer…** and **Dismiss**.",
      },
    ],
  },
  {
    slug: "opencode-mcp-servers-vs-code",
    title: "Manage OpenCode MCP servers in VS Code",
    short: "MCP servers",
    nav: "MCP servers",
    description:
      "See each OpenCode MCP server's state in Sidecar, connect, retry or sign in with OAuth, and add a server for one OpenCode run.",
    summary:
      "Sidecar's MCP panel shows the folder's MCP servers as OpenCode reports them, with Connect, Disconnect, Retry and an OAuth sign-in, and adds a server for one OpenCode run without touching OpenCode's config.",
    updated: "2026-11-27",
    blocks: [
      { type: "h2", text: "Open the panel" },
      {
        type: "art",
        name: "mcp",
        caption: "Hover: retry a failed server and sign in to another.",
      },
      {
        type: "p",
        text: "Type **/** in the message box and choose **MCP servers…**. Each server shows its state as OpenCode reports it:",
      },
      {
        type: "list",
        items: [
          "**Connected** or **connecting**.",
          "**Disabled**.",
          "**Failed**, with OpenCode's reason.",
          "**Needs sign-in**, for a remote server that uses OAuth.",
        ],
      },
      {
        type: "p",
        text: "The panel follows OpenCode's MCP events, so a server connecting or failing in another client shows here too.",
      },
      { type: "h2", text: "Connect, disconnect and retry" },
      {
        type: "p",
        text: "**Disconnect**, **Connect** and **Retry** apply until OpenCode restarts. To turn a server off for good, change OpenCode's config.",
      },
      { type: "h2", text: "Sign in to a remote server" },
      {
        type: "steps",
        items: [
          "Click **Sign in** on a server that needs it.",
          "OpenCode returns its sign-in page, which opens in your browser.",
          "Sign in there. Sidecar waits until OpenCode reports the server as connected.",
        ],
      },
      { type: "h2", text: "Add a server for this run" },
      {
        type: "p",
        text: "**Add a server for this OpenCode run** takes a name and either a command line or an `http(s)://` URL. Quotes and Windows paths work in the command line. The server is added through OpenCode's runtime API, labelled _added for this OpenCode run_, and **Remove** asks first.",
      },
      {
        type: "code",
        label: "Command",
        code: "npx -y @modelcontextprotocol/server-filesystem ./docs",
      },
      {
        type: "note",
        text: "OpenCode's config is never changed, so a config reload or a restart drops the server. To keep it, add it to `opencode.json` as OpenCode's [MCP docs](https://opencode.ai/docs/mcp-servers) describe.",
      },
      { type: "h2", text: "After editing opencode.json" },
      {
        type: "p",
        text: "Click **Reload config** in the panel. OpenCode reads `opencode.json`, its MCP servers and its skills again, without a restart.",
      },
      { type: "h2", text: "Good to know" },
      {
        type: "list",
        items: [
          "OpenCode does not report a server's tools, so the panel shows no tool count or context cost.",
          "A server's OAuth sign-in is kept out of the Providers panel, which lists model providers only.",
        ],
      },
    ],
  },
]

export const findGuide = (slug: string) =>
  guides.find((guide) => guide.slug === slug)
