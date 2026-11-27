export const site = {
  name: "Sidecar for OpenCode",
  shortName: "Sidecar",
  url: "https://www.opencodesidecar.com",
  title: "Sidecar for OpenCode: the OpenCode chat sidebar for VS Code",
  summary:
    "A free, open-source VS Code extension that gives the OpenCode coding agent a chat panel beside your code: every step on one timeline, live subagents you can stop, Keep or Undo for each change the agent made, approval modes, and permission requests answered where you type.",
  /** The hero's one line; `summary` stays the fuller description for search and llms.txt. */
  lead: "A free, open-source chat panel for the OpenCode coding agent, right beside your code.",
  extensionId: "cadogy.opencode-sidecar",
  publisher: "Cadogy",
  editors: ["VS Code", "Cursor", "Windsurf", "VSCodium"],
  links: {
    marketplace:
      "https://marketplace.visualstudio.com/items?itemName=cadogy.opencode-sidecar",
    openVsx: "https://open-vsx.org/extension/cadogy/opencode-sidecar",
    openInVsCode: "vscode:extension/cadogy.opencode-sidecar",
    source: "https://github.com/charlesknapp/opencode-sidecar",
    video: "https://www.youtube.com/watch?v=_KMBRo7zrMw",
    issues: "https://github.com/charlesknapp/opencode-sidecar/issues",
    rate: "https://marketplace.visualstudio.com/items?itemName=cadogy.opencode-sidecar&ssr=false#review-details",
    opencode: "https://opencode.ai",
    opencodeInstall: "https://opencode.ai/docs#install",
  },
} as const

export type Site = typeof site

export type Feature = {
  title: string
  description: string
  art: { name: ArtName; anchor: "top" | "bottom" }
}

export type ArtName =
  | "timeline"
  | "subagents"
  | "permission"
  | "budget"
  | "composer"
  | "session"
  | "review"
  | "modes"
  | "sessions"

export const features: readonly Feature[] = [
  {
    title: "Every step on one timeline",
    description:
      "Thinking, every tool call with its input and output, the todo list, and edits as diffs. Click an edit for VS Code's diff editor.",
    art: { name: "timeline", anchor: "top" },
  },
  {
    title: "Keep or undo each change",
    description:
      "Every change the agent made gets Keep | Undo right in the editor. Undo puts back just that change, your own edits stay, and you can stage only what you kept.",
    art: { name: "review", anchor: "top" },
  },
  {
    title: "Live subagents you can stop",
    description:
      "Each shows its task, prompt and live activity while it works in the background. Stop it, open its conversation, or expand its report.",
    art: { name: "subagents", anchor: "top" },
  },
  {
    title: "Answer where you type",
    description:
      "Permission requests and questions, even from subagents, wait in place of the message box. Allow once, always allow a pattern like npm test *, or redirect the agent.",
    art: { name: "permission", anchor: "bottom" },
  },
  {
    title: "Ask, Balanced or Auto",
    description:
      "Choose how much the agent may do without asking, per session or folder. Modes are OpenCode's own rules, and Auto still blocks destructive commands.",
    art: { name: "modes", anchor: "top" },
  },
  {
    title: "Several sessions at once",
    description:
      "Open sessions sit as tabs with their status. When one in the background finishes, fails or needs you, a notification takes you there.",
    art: { name: "sessions", anchor: "top" },
  },
  {
    title: "Budget Guard",
    description:
      "A cost and step limit per task that never stops mid-edit, and a card when the agent seems stuck in a loop. Continue once, raise the budget or start over.",
    art: { name: "budget", anchor: "top" },
  },
  {
    title: "Everything in the message box",
    description:
      "Type @ to mention files, subagents or skills and / for commands, /goal included. Ask a side question with /btw, steer, queue, rewind or fork.",
    art: { name: "composer", anchor: "bottom" },
  },
  {
    title: "One timeline for the whole session",
    description:
      "Prompts stay pinned while you read, answers can be copied or bookmarked, and terminal UI sessions show up here too.",
    art: { name: "session", anchor: "top" },
  },
]

export type ComparisonRow = { topic: string; official: string; sidecar: string }

export const comparison: readonly ComparisonRow[] = [
  {
    topic: "Interface",
    official: "OpenCode's terminal UI in a split terminal (Ctrl+Esc / Cmd+Esc)",
    sidecar:
      "A chat panel in the side bar, secondary side bar or an editor tab",
  },
  {
    topic: "Context from the editor",
    official:
      "Shares your selection or tab; inserts file references like @File#L37-42",
    sidecar:
      "@ mentions of files, folders, subagents and skills; the selection, files and images from +",
  },
  {
    topic: "The agent's work",
    official: "In the terminal UI",
    sidecar:
      "A timeline per prompt with every tool call, diffs in VS Code's diff editor, live subagents, and permission requests in place of the message box",
  },
  {
    topic: "Reviewing changes",
    official: "In the terminal UI and your Git tools",
    sidecar:
      "Keep or Undo each change in the editor, kept apart from your edits; stage only what you kept",
  },
  {
    topic: "Setup and panels",
    official: "OpenCode's terminal UI and config files",
    sidecar:
      "Panels for providers, custom agents, MCP servers, project instructions and permission rules, and a setup check",
  },
  {
    topic: "Editors",
    official: "VS Code and VS Code-based editors",
    sidecar: "VS Code, and Cursor, Windsurf and VSCodium via Open VSX",
  },
]

export const steps: readonly string[] = [
  "Install Sidecar for OpenCode: search “OpenCode Sidecar” in the Extensions view, or use the Marketplace or Open VSX link above.",
  "Click the Sidecar icon in the Activity Bar.",
  "If OpenCode isn't ready yet, the setup card helps you install it, start it and sign in. If you already use OpenCode, you won't see it.",
  "Pick a model and start chatting.",
]

export type FaqEntry = { question: string; answer: string }

export const faq: readonly FaqEntry[] = [
  {
    question: "What is Sidecar for OpenCode?",
    answer:
      "A free, open-source VS Code extension that gives the OpenCode coding agent a full chat interface inside the editor. It works with the OpenCode 2 service already on your machine.",
  },
  {
    question: "Is there an OpenCode GUI or chat sidebar for VS Code?",
    answer:
      "Yes: Sidecar is one. Install it from the Extensions view (search “OpenCode Sidecar”), click the Sidecar icon, and chat with OpenCode in a panel beside your code. It needs the OpenCode 2 service on your machine; the setup card helps install and start it.",
  },
  {
    question: "Does it work in Cursor, Windsurf or VSCodium?",
    answer:
      "Yes. Those editors install extensions from Open VSX, where Sidecar is published as cadogy.opencode-sidecar.",
  },
  {
    question: "Which OpenCode versions does it support?",
    answer:
      "OpenCode 2.x, with its background service running. Sidecar is tested against OpenCode 2.4.2, including goals, todo lists and background subagents. OpenCode 1.x is not supported.",
  },
  {
    question: "Can I use local models, such as Ollama or LM Studio?",
    answer:
      "Yes, if they are set up as a provider in OpenCode. Sidecar uses whatever models OpenCode offers, so any provider OpenCode supports works here too.",
  },
  {
    question: "Is it official?",
    answer:
      "No. It is an independent community project and is not affiliated with OpenCode. The official OpenCode extension is sst-dev.opencode.",
  },
  {
    question: "Do I need an API key, and what does it cost?",
    answer:
      "Sidecar is free and needs no key of its own. It uses the models you have in OpenCode: OpenCode's free models, your OpenCode account, or any provider you connect in OpenCode. Its Providers panel connects one through OpenCode's own sign-in, and a key you type there goes straight to OpenCode. Model costs are between you and your provider.",
  },
  {
    question: "Can I undo what the agent changed?",
    answer:
      "Yes. Every change the agent made shows Keep | Undo in the editor. Undo puts back just that change with an ordinary edit (Ctrl+Z brings it back), never touches your own edits, and Stage kept changes stages only what you kept. You can also rewind the conversation and its code to before any prompt.",
  },
  {
    question: "Can the agent run without asking every time?",
    answer:
      "If you choose. The badge in the header switches between Ask, Balanced (edits in the folder run, commands ask) and Auto (everything runs; destructive commands such as rm -rf or force pushes are blocked), for one session or the folder. Modes are OpenCode's own permission rules, and OpenCode's config is never changed.",
  },
  {
    question: "Does it work with my existing OpenCode sessions?",
    answer:
      "Yes. Sessions are OpenCode's, so the ones you started in the terminal UI appear in History, and changes made in either place show up in the other.",
  },
  {
    question: "Does my code leave my machine?",
    answer:
      "Sidecar sends your prompts and the files you attach only to your local OpenCode service, and it collects no telemetry. What OpenCode then sends to a model provider is decided by OpenCode and your configuration.",
  },
  {
    question: "Which platforms does it run on?",
    answer:
      "Wherever VS Code 1.95+ and OpenCode 2.x run: Windows, macOS and Linux. It needs a trusted workspace.",
  },
]
