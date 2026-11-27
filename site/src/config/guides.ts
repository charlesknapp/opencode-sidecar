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
]

export const findGuide = (slug: string) =>
  guides.find((guide) => guide.slug === slug)
