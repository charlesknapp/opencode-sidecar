export const site = {
  name: "Sidecar for OpenCode",
  shortName: "Sidecar",
  url: "https://opencodesidecar.com",
  title: "Sidecar for OpenCode: the OpenCode chat sidebar for VS Code",
  summary:
    "A free, open-source VS Code extension that gives the OpenCode coding agent a chat panel beside your code: every step on one timeline, live subagents you can stop, and permission requests answered where you type.",
  extensionId: "cadogy.opencode-sidecar",
  publisher: "Cadogy",
  editors: ["VS Code", "Cursor", "Windsurf", "VSCodium"],
  links: {
    marketplace:
      "https://marketplace.visualstudio.com/items?itemName=cadogy.opencode-sidecar",
    openVsx: "https://open-vsx.org/extension/cadogy/opencode-sidecar",
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
  image: { src: string; alt: string; anchor: "top" | "bottom" }
}

export const features: readonly Feature[] = [
  {
    title: "Every step on one timeline",
    description:
      "Each prompt gets a timeline of what the agent did: thinking time, every tool call with its input and output, and edits as diffs with your theme's syntax colors. Click an edit to open it in VS Code's own diff editor.",
    image: {
      src: "/screens/tools.png",
      alt: "A read, an edit with its changed lines and a failed shell command",
      anchor: "top",
    },
  },
  {
    title: "Live subagents you can stop",
    description:
      "Each subagent shows its task, its exact prompt, what it is doing right now, and its tool count and time. Stop any of them, or open one into its own conversation. Its report comes back as one line you can expand.",
    image: {
      src: "/screens/subagents.png",
      alt: "Subagent rows and a subagent's permission request",
      anchor: "top",
    },
  },
  {
    title: "Nothing is approved for you",
    description:
      "Permission requests and questions, including those raised deep inside a subagent, wait in place of the message box until you answer. You can also tell the agent what to do instead.",
    image: {
      src: "/screens/question.png",
      alt: "A question in place of the message box, with options",
      anchor: "bottom",
    },
  },
  {
    title: "Budget Guard",
    description:
      "Set a local limit on cost and steps for each task. When a task runs away, Budget Guard stops it, and you decide whether to continue once, raise the budget or start over.",
    image: {
      src: "/screens/budget.png",
      alt: "Budget Guard stopped the task with Continue once and Increase budget",
      anchor: "top",
    },
  },
  {
    title: "Everything at hand in the message box",
    description:
      "Type @ to mention a file, folder, subagent or skill, paste a screenshot, and open / for OpenCode's commands, including your own. Steer a running task or queue the next message, and rewind or fork from any prompt.",
    image: {
      src: "/screens/commands.png",
      alt: "The / action palette with sections and a filter",
      anchor: "bottom",
    },
  },
  {
    title: "One timeline for the whole session",
    description:
      "Prompts stay pinned while you read their turn, answers can be copied or bookmarked, and sessions you start in OpenCode's terminal UI show up here too, because they are OpenCode's own.",
    image: {
      src: "/screens/timeline.png",
      alt: "Two turns with a pinned prompt, tool calls, answers, Copy and Bookmark",
      anchor: "top",
    },
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
      "OpenCode 2.x, with its background service running. OpenCode 1.x is not supported.",
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
      "Sidecar is free and needs no key of its own. It uses the models you have in OpenCode: OpenCode's free models, your OpenCode account, or any provider you connect in OpenCode. Model costs are between you and your provider.",
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
