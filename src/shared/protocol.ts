// Message schema between the extension host and the sidebar webview.
// Webview -> host messages are untrusted input and are validated strictly by
// `parseWebviewMessage` before the host acts on them.

import { isRule, type PermissionRule } from "./approval";
import type {
  AgentDraft,
  AgentOption,
  AgentsView,
  ApprovalView,
  AsideView,
  BookmarkView,
  BudgetLevel,
  BudgetLimits,
  BudgetView,
  CommandInfo,
  ConnectionStatus,
  ContextBreakdown,
  CostBreakdown,
  FileChange,
  ReviewView,
  RewindPreview,
  FormAnswer,
  GoalView,
  ImportPreview,
  InboxDelivery,
  InstructionsView,
  McpBusy,
  McpServerInfo,
  MentionCandidate,
  SavedPermission,
  ModelOption,
  StripTab,
  OnboardingView,
  PendingInboxItem,
  PermissionDecision,
  PromptMention,
  PromptPaste,
  ProvidersView,
  QuotaView,
  SessionSummary,
  SkillOption,
  SubagentView,
  TranscriptItem,
  UiEvent,
  UsageInfo,
  UsageStats,
  WorkspaceInfo,
} from "./model";

export interface AttachmentChip {
  id: string;
  label: string;
  detail: string;
  /** Images show a small preview (`thumb`, a data: URI) or an image icon; problems a warning icon. */
  kind?: "image" | "problems";
  thumb?: string;
  /** The editor's selection or file, following the editor (`opencodeSidecar.autoContext`). */
  auto?: boolean;
}

export interface ViewState {
  connection: ConnectionStatus;
  workspace: WorkspaceInfo;
  /** null = could not be loaded (shown as unavailable). */
  models: ModelOption[] | null;
  agents: AgentOption[] | null;
  selectedModel: string | null;
  selectedAgent: string | null;
  sessions: SessionSummary[];
  currentSession: { id: string; title: string } | null;
  busy: boolean;
  stopping: boolean;
  attachments: AttachmentChip[];
  /** Changes attributed to the agent by OpenCode's session snapshots. */
  agentChanges:
    { status: "none" } | { status: "ok"; files: FileChange[] } | { status: "unavailable"; reason: string };
  /** Keep / Undo review of the agent's changes (counts per file); null when there is nothing to review. */
  review?: ReviewView | null;
  /** Uncommitted workspace changes (Git, HEAD ↔ working tree); null when Git is unavailable. */
  workspaceChanges: { count: number } | null;
  /** null when usage display is disabled or no figures are available. */
  usage: UsageInfo | null;
  /** The session's costs by model and agent; null when usage display is off or nothing is known. */
  costs: CostBreakdown | null;
  /** Provider limits OpenCode reports (OpenCode Go, Console budgets); null when it reports none. */
  quota: QuotaView | null;
  /** Completed agent steps in the current session. */
  steps: number;
  selectedVariant: string | null;
  budget: BudgetView;
  budgetPresets: Record<Exclude<BudgetLevel, "off">, BudgetLimits>;
  pending: PendingInboxItem[];
  locale: "en" | "ar";
  /** One-time tip about moving the view to the Secondary Side Bar. */
  showPlacementHint: boolean;
  /** First-run / connection guidance; `stage: "ready"` hides it. */
  onboarding: OnboardingView;
  /** Subagents of the open session (parents before their own subagents). */
  subagents: SubagentView[];
  /** The subagent conversation shown instead of the main one; its items arrive as `subagentTranscript`. */
  viewingSubagent: { id: string; loading: boolean } | null;
  /** Display preferences from the settings. */
  prefs: {
    stickyPrompt: boolean;
    cacheWarmMinutes: number;
    activity: "detailed" | "grouped";
    /** A playful word per run in the Working line (default on). */
    statusWords?: boolean;
    /** The session strip above the conversation (default on). */
    sessionStrip?: boolean;
    /** The editor's selection or file follows the editor as a chip (default off). */
    autoContext?: boolean;
  };
  /** OpenCode's slash commands for this folder (empty when unavailable). */
  commands: CommandInfo[];
  /** Bookmarked answers in this workspace, newest first. */
  bookmarks: BookmarkView[];
  /** Subagents a prompt can mention as `@name`. */
  mentionAgents: AgentOption[];
  /** OpenCode's skills for this folder, mentioned as `@id`. */
  skills: SkillOption[];
  /** The open session's goal (`/goal`), for the header above the conversation; null when it has none. */
  goal?: GoalView | null;
  /** A rewind staged in another client and not yet committed, for the open session. */
  revert: { messageID: string; files: number } | null;
  /** Archived sessions of this folder, once the history's Archived view asked for them. */
  archivedSessions: SessionSummary[] | null;
  /** The session strip's tabs, most recent first (the open session among them). */
  strip: StripTab[];
  /** The approval mode badge and the permission rules editor. */
  approval: ApprovalView;
}

/** Official OpenCode pages the webview may ask the host to open (keys, never URLs). */
export type OfficialLink = "install" | "account" | "providers" | "go" | "setupGuide";
const OFFICIAL_LINKS: OfficialLink[] = ["install", "account", "providers", "go", "setupGuide"];

export type HostMessage =
  | { type: "state"; state: ViewState }
  | { type: "transcript"; items: TranscriptItem[] }
  | { type: "events"; events: UiEvent[] }
  | { type: "focusInput" }
  /** Open the History popover (the "Show History" command). */
  | { type: "showHistory" }
  | { type: "copyResult"; requestId: string; ok: boolean }
  | { type: "restoreInput"; text: string }
  /** What a rewind with code would revert (null: OpenCode could not tell), for the open dialog. */
  | { type: "rewindPreview"; messageID: string; preview: RewindPreview | null }
  /** Text for an empty message box (such as "Fix these problems."); typed text is kept. */
  | { type: "suggestInput"; text: string }
  | { type: "formError"; formId: string; error: string }
  | { type: "focusModel" }
  | { type: "subagentTranscript"; sessionID: string; items: TranscriptItem[] }
  | { type: "subagentEvents"; sessionID: string; events: UiEvent[] }
  /** Scroll to an item (after opening a bookmark). */
  | { type: "revealItem"; itemId: string }
  /** Suggestions for an `@` typed in the message box. */
  | { type: "mentionResults"; requestId: string; items: MentionCandidate[] }
  /** The open folder's "always allow" rules; null with `error` when OpenCode could not list them. */
  | { type: "savedPermissions"; items: SavedPermission[] | null; error?: string }
  /** The folder's MCP servers; null with `error` when OpenCode could not list them. */
  | { type: "mcpServers"; items: McpServerInfo[] | null; error?: string; busy?: McpBusy | null }
  /** The Project instructions panel; null with `error` when it could not be worked out. */
  | { type: "instructions"; view: InstructionsView | null; error?: string }
  /** How adding an MCP server for this OpenCode run went (the panel's form). */
  | { type: "mcpAddResult"; ok: boolean; error?: string }
  /** Open the Providers panel (the Manage Providers command). */
  | { type: "showProviders" }
  /** The Providers panel; null with `error` when OpenCode could not list them. */
  | { type: "providers"; view: ProvidersView | null; error?: string }
  /** Open the Agents panel (Manage Agents), or its import preview (Import Roo Code Modes). */
  | { type: "showAgents"; import?: boolean }
  /** The Agents panel; null with `error` when OpenCode could not list them. */
  | { type: "agents"; view: AgentsView | null; error?: string }
  /** How a save, delete or import ended: `error` for the form; `id` of the agent saved. */
  | { type: "agentResult"; ok: boolean; id?: string; error?: string }
  /** The Roo Code / Kilo Code modes found; null with `error` when none could be read. */
  | { type: "agentImport"; preview: ImportPreview | null; error?: string }
  /** For the usage menu: what fills the context, and today's usage in the folder's project. */
  | { type: "usageDetails"; context: ContextBreakdown | null; today: UsageStats | null }
  /** The side question (`/btw`) card; null when it is closed. */
  | { type: "aside"; aside: AsideView | null };

export type WebviewMessage =
  | { type: "ready" }
  /**
   * `mentions`: the `@` suggestions picked while typing; the host checks each one.
   * `pastes`: large pastes held as chips, put in at their token by the host.
   */
  | {
      type: "send";
      text: string;
      delivery?: InboxDelivery;
      mentions?: PromptMention[];
      pastes?: PromptPaste[];
    }
  /** `@` suggestions for `query` (files and folders, subagents, skills). */
  | { type: "findMentions"; query: string; requestId: string }
  /** A pasted or dropped image as a base64 data: URI, with a small preview. */
  | { type: "attachImage"; name: string; dataUrl: string; thumb?: string; width?: number; height?: number }
  /** Pick image files from disk. */
  | { type: "pickImage" }
  /** Fork the session into a new one: before `messageID`, or the whole conversation. */
  | { type: "forkSession"; messageID?: string }
  | { type: "archiveSession"; id: string; archived: boolean }
  /** Load the archived sessions for the history's Archived view. */
  | { type: "loadArchived" }
  | { type: "loadSavedPermissions" }
  | { type: "deleteSession"; id: string }
  | { type: "exportSession" }
  | { type: "loadMcpServers" }
  /** Connect an MCP server (also Retry for one that failed), or disconnect it, for this OpenCode run. */
  | { type: "mcpConnect"; name: string }
  | { type: "mcpDisconnect"; name: string }
  /** Sign in to an MCP server that needs it, through OpenCode's OAuth. */
  | { type: "mcpAuth"; name: string }
  /** Add an MCP server for this OpenCode run: `target` is a command line or an http(s) URL. */
  | { type: "mcpAdd"; name: string; target: string }
  /** Leave an MCP server out until OpenCode restarts or reloads its config (the webview asked first). */
  | { type: "mcpRemove"; name: string }
  /** Have OpenCode reload its config from the MCP panel. */
  | { type: "reloadMcp" }
  /** The Project instructions panel opened (or wants a fresh list). */
  | { type: "loadInstructions" }
  /** Open one of the instruction files the panel lists. */
  | { type: "openInstruction"; path: string }
  /** Create the project's AGENTS.md, or (after the host asks) the global one. */
  | { type: "createInstructions"; scope: "project" | "global" }
  /** Pause, resume or end the open session's goal (OpenCode's `/goal pause|resume|clear`). */
  | { type: "goalAction"; action: "pause" | "resume" | "clear" }
  /** "Remember this": add a line to the project's AGENTS.md (the host shows the change and asks). */
  | { type: "remember"; text: string }
  /** The Providers panel opened (or wants a fresh list). */
  | { type: "loadProviders" }
  /** Connect a provider through OpenCode's sign-in (`id`: OpenCode's integration). */
  | { type: "providerConnect"; id: string }
  /** Sign in to a connected provider again (from the panel or an error card). */
  | { type: "providerReauth"; id: string }
  /** Remove a provider's stored credentials (the webview has asked for confirmation). */
  | { type: "providerDisconnect"; id: string }
  /** Have OpenCode reload its config (`POST /api/location/reload`). */
  | { type: "reloadProviders" }
  /** Run "Check OpenCode setup". */
  | { type: "checkSetup" }
  /** The usage menu opened: send what fills the context and today's usage. */
  | { type: "loadUsageDetails" }
  /** The Agents panel opened (or wants a fresh list). */
  | { type: "loadAgents" }
  /**
   * Save the form: a new agent (`editing` null) or the custom agent `editing`. The host
   * asks before it replaces a file or writes outside the folder. `open`: then open the file.
   */
  | { type: "saveAgent"; draft: AgentDraft; editing: string | null; open?: boolean }
  /** Delete a custom agent's file (the webview has asked for confirmation). */
  | { type: "deleteAgent"; id: string }
  /** Open an agent's file in the editor. */
  | { type: "openAgentFile"; id: string }
  /** Look for Roo Code and Kilo Code modes to import. */
  | { type: "previewImport" }
  /** Import the checked modes of the last preview as agents. */
  | { type: "importModes"; keys: string[]; scope: "project" | "global" }
  /** A finished code block: insert it at the cursor of the last editor, or open it in a new one. */
  | { type: "insertCode"; text: string }
  | { type: "openCode"; text: string; lang: string }
  | { type: "removeSavedPermission"; id: string }
  /** Change a saved "always allow" rule's action and pattern. */
  | { type: "updateSavedPermission"; id: string; action: string; resource: string }
  /**
   * Switch the approval mode for the open session (or the next one), or with "folder" also
   * for new sessions in the folder. `dontAskAgain`: stop confirming Auto.
   */
  | {
      type: "setApprovalMode";
      mode: "ask" | "balanced" | "auto" | "default";
      scope: "session" | "folder";
      dontAskAgain?: boolean;
    }
  /** Replace the open session's own rules (the ones after its mode's). */
  | { type: "setSessionRules"; rules: PermissionRule[] }
  /** Allow a request once and add allow rules for patterns like it ("Always allow … like this"). */
  | { type: "allowLike"; requestId: string; patterns: string[]; scope: "session" | "folder" }
  /** A rewind staged in another client: restore the messages, or apply it. */
  | { type: "resolveRevert"; action: "restore" | "apply" }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "selectSession"; id: string }
  /** Takes a session off the session strip (it stays in History). */
  | { type: "closeStripTab"; id: string }
  | { type: "refreshSessions" }
  | { type: "selectModel"; key: string }
  | { type: "selectAgent"; id: string }
  | { type: "selectRoot"; path: string }
  | { type: "addCurrentFile" }
  | { type: "addSelection" }
  /** Search the workspace for a file to attach (the + menu's last entry). */
  | { type: "searchFiles" }
  /** Attach the errors and warnings of the editor's file, or of the whole open folder. */
  | { type: "fixProblems"; scope: "file" | "workspace" }
  /** Write a commit message for the staged (or the agent's) changes into the Git commit box. */
  | { type: "writeCommitMessage" }
  /** Open a tool call's command, output or subagent prompt in a read-only editor tab. */
  | { type: "openToolText"; itemId: string; part: "in" | "out" | "prompt" }
  /** Sidecar settings flipped from the / menu. */
  | { type: "setPref"; key: "stickyPrompt" | "statusWords" | "autoContext"; value: boolean }
  | { type: "setPref"; key: "activity"; value: "detailed" | "grouped" }
  | { type: "openSettings" }
  /** The / menu opened: reload OpenCode's commands. */
  | { type: "refreshCommands" }
  | { type: "removeAttachment"; id: string }
  /** `message` (with "reject" only): what the agent should do instead. */
  | { type: "respondPermission"; requestId: string; decision: PermissionDecision; message?: string }
  | { type: "openFile"; path: string }
  | { type: "copy"; text: string; requestId: string }
  | { type: "copyMessage"; itemId: string; requestId: string }
  | { type: "selectVariant"; variant: string }
  | { type: "selectBudget"; level: BudgetLevel }
  | { type: "budgetAction"; itemId: string; action: "continue" | "increase" | "newSession" }
  | { type: "answerForm"; formId: string; answer: FormAnswer }
  | { type: "cancelForm"; formId: string }
  | { type: "editPending"; id: string }
  | { type: "removePending"; id: string }
  | { type: "setDelivery"; id: string; delivery: InboxDelivery }
  | { type: "openAgentDiff"; path: string }
  | { type: "openAgentDiffAll" }
  /** The Review changes picker (Keep / Undo per hunk in the editor). */
  | { type: "reviewChanges" }
  /** Asks what a rewind with code to before this prompt would revert. */
  | { type: "rewindPreview"; messageID: string }
  | { type: "openWorkspaceDiffAll" }
  | { type: "retryLast" }
  | { type: "focusModelPicker" }
  | { type: "dismissHint" }
  | { type: "openLink"; href: string }
  | { type: "startOpenCode" }
  | { type: "retry" }
  | { type: "configurePath" }
  | { type: "showLogs" }
  | { type: "signIn" }
  | { type: "connectProvider" }
  | { type: "refreshConnection" }
  | { type: "openFolder" }
  | { type: "openOfficial"; link: OfficialLink }
  | { type: "dismissSignInHint" }
  | { type: "openSubagent"; sessionID: string }
  | { type: "closeSubagent" }
  | { type: "stopSubagent"; sessionID: string }
  /**
   * Rewind the session to just before this prompt (OpenCode revert), after the view's
   * confirmation; `files` also undoes the file changes made since.
   */
  | { type: "rewind"; messageID: string; files: boolean }
  | { type: "renameSession"; title: string }
  | { type: "runCommand"; name: string; text: string; delivery?: InboxDelivery }
  | { type: "compact" }
  | { type: "shellCommand"; command: string }
  /** Ask a side question (`/btw`), or follow up in the open side thread. */
  | { type: "askAside"; text: string }
  /** Close the side question; its session is deleted. */
  | { type: "closeAside" }
  /** Send the latest side answer to the main session (queued while the agent works). */
  | { type: "asideToMain" }
  | { type: "toggleBookmark"; itemId: string }
  | { type: "openBookmark"; id: string }
  | { type: "removeBookmark"; id: string };

const MAX_TEXT = 200_000;
/** Code blocks copied from very long reports can be large; still bounded. */
const MAX_COPY = 5_000_000;
const BUDGET_LEVELS = ["off", "small", "medium", "large", "custom"];

/** Validates a form answer: plain values only, bounded sizes. Field-level rules are checked by the host. */
function isAnswer(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 100) return false;
  return entries.every(([k, x]) => {
    if (k.length === 0 || k.length > 200 || k === "__proto__" || k === "constructor" || k === "prototype")
      return false;
    if (typeof x === "string") return x.length <= 20_000;
    if (typeof x === "number") return Number.isFinite(x);
    if (typeof x === "boolean") return true;
    return Array.isArray(x) && x.length <= 200 && x.every((y) => typeof y === "string" && y.length <= 2000);
  });
}
const MAX_ID = 512;

type Validator = (msg: Record<string, unknown>) => boolean;

const isStr = (v: unknown, max = MAX_ID): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

const MENTION_KINDS = ["file", "folder", "agent", "skill"];
const isMention = (v: unknown): boolean => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    Object.keys(m).every((k) => k === "kind" || k === "value" || k === "text") &&
    typeof m.kind === "string" &&
    MENTION_KINDS.includes(m.kind) &&
    isStr(m.value, 4096) &&
    isStr(m.text, 4100) &&
    (m.text as string).startsWith("@")
  );
};
/** Large pastes: a few per message, each up to 500,000 characters, 2,000,000 in all. */
const PASTE_TOKEN = /^\[Pasted text #\d{1,4}\]$/;
const MAX_PASTE = 500_000;
const arePastes = (v: unknown): boolean => {
  if (!Array.isArray(v) || v.length > 20) return false;
  let total = 0;
  return v.every((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    const r = p as Record<string, unknown>;
    if (!Object.keys(r).every((k) => k === "token" || k === "text")) return false;
    if (typeof r.token !== "string" || !PASTE_TOKEN.test(r.token)) return false;
    if (typeof r.text !== "string" || r.text.length === 0 || r.text.length > MAX_PASTE) return false;
    total += r.text.length;
    return total <= 2_000_000;
  });
};
/** Pasted images: PNG, JPEG, GIF or WebP, base64, up to about 5 MB decoded. */
const MAX_IMAGE_URI = 7_000_000;
const isImageUri = (v: unknown, max: number): boolean =>
  typeof v === "string" &&
  v.length <= max &&
  /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
const isDim = (v: unknown): boolean =>
  v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100_000);

/** An agent id OpenCode listed: a file name under `agents/`, perhaps in a subfolder (`team/review`). */
const isAgentId = (v: unknown): boolean =>
  isStr(v, 200) &&
  !/(^|\/)\.\.?(\/|$)|\\|^\//.test(v as string) &&
  ![...(v as string)].some((c) => c.charCodeAt(0) < 32);

const EFFECTS = ["allow", "ask", "deny"];
const ACTIONS = ["read", "edit", "shell", "webfetch", "websearch", "subagent", "skill"];
const DRAFT_KEYS = [
  "name",
  "description",
  "mode",
  "model",
  "variant",
  "temperature",
  "permissions",
  "prompt",
  "scope",
];
const optStr = (v: unknown, max: number): boolean => v === null || (typeof v === "string" && v.length <= max);
/** The agent form: bounded strings, a known mode and scope, and switches for known actions only. */
const isDraft = (v: unknown): boolean => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  const perms = d.permissions as Record<string, unknown>;
  return (
    Object.keys(d).every((k) => DRAFT_KEYS.includes(k)) &&
    isStr(d.name, 200) &&
    typeof d.description === "string" &&
    d.description.length <= 2000 &&
    (d.mode === "primary" || d.mode === "subagent" || d.mode === "all") &&
    optStr(d.model, 400) &&
    optStr(d.variant, 100) &&
    (d.temperature === null ||
      (typeof d.temperature === "number" &&
        Number.isFinite(d.temperature) &&
        d.temperature >= 0 &&
        d.temperature <= 2)) &&
    !!perms &&
    typeof perms === "object" &&
    !Array.isArray(perms) &&
    Object.entries(perms).every(([k, e]) => ACTIONS.includes(k) && EFFECTS.includes(e as string)) &&
    typeof d.prompt === "string" &&
    d.prompt.length <= 200_000 &&
    (d.scope === "project" || d.scope === "global")
  );
};

/** OpenCode's integration and provider ids: `anthropic`, `302ai`, `amazon-bedrock`, … */
const isProviderId = (v: unknown): boolean => isStr(v, 200) && /^[\w.:@/-]+$/.test(v as string);

const VALIDATORS: Record<WebviewMessage["type"], Validator> = {
  ready: () => true,
  send: (m) =>
    typeof m.text === "string" &&
    m.text.length <= MAX_TEXT &&
    (m.delivery === undefined || m.delivery === "steer" || m.delivery === "queue") &&
    (m.mentions === undefined ||
      (Array.isArray(m.mentions) && m.mentions.length <= 50 && m.mentions.every(isMention))) &&
    (m.pastes === undefined || arePastes(m.pastes)),
  findMentions: (m) => typeof m.query === "string" && m.query.length <= 500 && isStr(m.requestId, 64),
  attachImage: (m) =>
    isStr(m.name, 200) &&
    isImageUri(m.dataUrl, MAX_IMAGE_URI) &&
    (m.thumb === undefined || isImageUri(m.thumb, 100_000)) &&
    isDim(m.width) &&
    isDim(m.height),
  pickImage: () => true,
  forkSession: (m) => m.messageID === undefined || isStr(m.messageID),
  archiveSession: (m) => isStr(m.id) && typeof m.archived === "boolean",
  loadArchived: () => true,
  loadSavedPermissions: () => true,
  deleteSession: (m) => isStr(m.id),
  exportSession: () => true,
  loadMcpServers: () => true,
  mcpConnect: (m) => isStr(m.name, 200),
  mcpDisconnect: (m) => isStr(m.name, 200),
  mcpAuth: (m) => isStr(m.name, 200),
  mcpAdd: (m) => isStr(m.name, 200) && isStr(m.target, 4000),
  mcpRemove: (m) => isStr(m.name, 200),
  reloadMcp: () => true,
  loadInstructions: () => true,
  openInstruction: (m) => isStr(m.path, 4096),
  createInstructions: (m) => m.scope === "project" || m.scope === "global",
  goalAction: (m) => m.action === "pause" || m.action === "resume" || m.action === "clear",
  remember: (m) => typeof m.text === "string" && m.text.length <= 20_000,
  loadProviders: () => true,
  providerConnect: (m) => isProviderId(m.id),
  providerReauth: (m) => isProviderId(m.id),
  providerDisconnect: (m) => isProviderId(m.id),
  reloadProviders: () => true,
  checkSetup: () => true,
  loadUsageDetails: () => true,
  loadAgents: () => true,
  saveAgent: (m) =>
    isDraft(m.draft) &&
    (m.editing === null || isAgentId(m.editing)) &&
    (m.open === undefined || typeof m.open === "boolean"),
  deleteAgent: (m) => isAgentId(m.id),
  openAgentFile: (m) => isAgentId(m.id),
  previewImport: () => true,
  importModes: (m) =>
    Array.isArray(m.keys) &&
    m.keys.length <= 500 &&
    m.keys.every((k) => isStr(k, 300)) &&
    (m.scope === "project" || m.scope === "global"),
  insertCode: (m) => typeof m.text === "string" && m.text.length <= MAX_COPY,
  openCode: (m) =>
    typeof m.text === "string" &&
    m.text.length <= MAX_COPY &&
    typeof m.lang === "string" &&
    m.lang.length <= 40,
  removeSavedPermission: (m) => isStr(m.id, 200),
  updateSavedPermission: (m) =>
    isStr(m.id, 200) && isRule({ action: m.action, resource: m.resource, effect: "allow" }),
  setApprovalMode: (m) =>
    (m.mode === "ask" || m.mode === "balanced" || m.mode === "auto" || m.mode === "default") &&
    (m.scope === "session" || m.scope === "folder") &&
    (m.dontAskAgain === undefined || typeof m.dontAskAgain === "boolean"),
  setSessionRules: (m) => Array.isArray(m.rules) && m.rules.length <= 200 && m.rules.every(isRule),
  allowLike: (m) =>
    isStr(m.requestId) &&
    Array.isArray(m.patterns) &&
    m.patterns.length > 0 &&
    m.patterns.length <= 20 &&
    m.patterns.every((p) => typeof p === "string" && p.trim().length > 0 && p.length <= 2000) &&
    (m.scope === "session" || m.scope === "folder"),
  resolveRevert: (m) => m.action === "restore" || m.action === "apply",
  stop: () => true,
  newSession: () => true,
  selectSession: (m) => isStr(m.id),
  closeStripTab: (m) => isStr(m.id),
  refreshSessions: () => true,
  selectModel: (m) => isStr(m.key),
  selectAgent: (m) => isStr(m.id),
  selectRoot: (m) => isStr(m.path, 4096),
  addCurrentFile: () => true,
  addSelection: () => true,
  searchFiles: () => true,
  fixProblems: (m) => m.scope === "file" || m.scope === "workspace",
  writeCommitMessage: () => true,
  openToolText: (m) => isStr(m.itemId) && (m.part === "in" || m.part === "out" || m.part === "prompt"),
  setPref: (m) =>
    ((m.key === "stickyPrompt" || m.key === "statusWords" || m.key === "autoContext") &&
      typeof m.value === "boolean") ||
    (m.key === "activity" && (m.value === "detailed" || m.value === "grouped")),
  openSettings: () => true,
  refreshCommands: () => true,
  removeAttachment: (m) => isStr(m.id),
  respondPermission: (m) =>
    isStr(m.requestId) &&
    (m.decision === "once" || m.decision === "always" || m.decision === "reject") &&
    (m.message === undefined ||
      (m.decision === "reject" &&
        typeof m.message === "string" &&
        m.message.trim().length > 0 &&
        m.message.length <= 20_000)),
  openFile: (m) => isStr(m.path, 4096),
  copy: (m) => typeof m.text === "string" && m.text.length <= MAX_COPY && isStr(m.requestId, 64),
  copyMessage: (m) => isStr(m.itemId) && isStr(m.requestId, 64),
  selectVariant: (m) => typeof m.variant === "string" && m.variant.length <= 100,
  selectBudget: (m) => typeof m.level === "string" && BUDGET_LEVELS.includes(m.level),
  budgetAction: (m) =>
    isStr(m.itemId) && (m.action === "continue" || m.action === "increase" || m.action === "newSession"),
  answerForm: (m) => isStr(m.formId) && isAnswer(m.answer),
  cancelForm: (m) => isStr(m.formId),
  editPending: (m) => isStr(m.id),
  removePending: (m) => isStr(m.id),
  setDelivery: (m) => isStr(m.id) && (m.delivery === "steer" || m.delivery === "queue"),
  openAgentDiff: (m) => isStr(m.path, 4096),
  openAgentDiffAll: () => true,
  reviewChanges: () => true,
  rewindPreview: (m) => isStr(m.messageID),
  openWorkspaceDiffAll: () => true,
  retryLast: () => true,
  focusModelPicker: () => true,
  dismissHint: () => true,
  openLink: (m) => isStr(m.href, 4096),
  startOpenCode: () => true,
  retry: () => true,
  configurePath: () => true,
  showLogs: () => true,
  signIn: () => true,
  connectProvider: () => true,
  refreshConnection: () => true,
  openFolder: () => true,
  openOfficial: (m) => typeof m.link === "string" && (OFFICIAL_LINKS as string[]).includes(m.link),
  dismissSignInHint: () => true,
  openSubagent: (m) => isStr(m.sessionID),
  closeSubagent: () => true,
  stopSubagent: (m) => isStr(m.sessionID),
  rewind: (m) => isStr(m.messageID) && typeof m.files === "boolean",
  renameSession: (m) => typeof m.title === "string" && m.title.trim().length > 0 && m.title.length <= 200,
  runCommand: (m) =>
    isStr(m.name, 200) &&
    /^[\w.:/-]+$/.test(m.name as string) &&
    typeof m.text === "string" &&
    m.text.length <= MAX_TEXT &&
    (m.delivery === undefined || m.delivery === "steer" || m.delivery === "queue"),
  compact: () => true,
  shellCommand: (m) =>
    typeof m.command === "string" && m.command.trim().length > 0 && m.command.length <= 20_000,
  askAside: (m) => typeof m.text === "string" && m.text.trim().length > 0 && m.text.length <= MAX_TEXT,
  closeAside: () => true,
  asideToMain: () => true,
  toggleBookmark: (m) => isStr(m.itemId),
  openBookmark: (m) => isStr(m.id),
  removeBookmark: (m) => isStr(m.id),
};

const ALLOWED_KEYS: Partial<Record<WebviewMessage["type"], string[]>> = {
  send: ["text", "delivery", "mentions", "pastes"],
  findMentions: ["query", "requestId"],
  attachImage: ["name", "dataUrl", "thumb", "width", "height"],
  forkSession: ["messageID"],
  archiveSession: ["id", "archived"],
  removeSavedPermission: ["id"],
  updateSavedPermission: ["id", "action", "resource"],
  setApprovalMode: ["mode", "scope", "dontAskAgain"],
  setSessionRules: ["rules"],
  allowLike: ["requestId", "patterns", "scope"],
  deleteSession: ["id"],
  mcpConnect: ["name"],
  mcpDisconnect: ["name"],
  mcpAuth: ["name"],
  mcpAdd: ["name", "target"],
  mcpRemove: ["name"],
  openInstruction: ["path"],
  createInstructions: ["scope"],
  remember: ["text"],
  goalAction: ["action"],
  providerConnect: ["id"],
  providerReauth: ["id"],
  providerDisconnect: ["id"],
  saveAgent: ["draft", "editing", "open"],
  deleteAgent: ["id"],
  openAgentFile: ["id"],
  importModes: ["keys", "scope"],
  insertCode: ["text"],
  openCode: ["text", "lang"],
  resolveRevert: ["action"],
  selectSession: ["id"],
  closeStripTab: ["id"],
  selectModel: ["key"],
  selectAgent: ["id"],
  selectRoot: ["path"],
  removeAttachment: ["id"],
  fixProblems: ["scope"],
  respondPermission: ["requestId", "decision", "message"],
  openFile: ["path"],
  copy: ["text", "requestId"],
  copyMessage: ["itemId", "requestId"],
  selectVariant: ["variant"],
  selectBudget: ["level"],
  budgetAction: ["itemId", "action"],
  answerForm: ["formId", "answer"],
  cancelForm: ["formId"],
  editPending: ["id"],
  removePending: ["id"],
  setDelivery: ["id", "delivery"],
  openAgentDiff: ["path"],
  openLink: ["href"],
  openOfficial: ["link"],
  openSubagent: ["sessionID"],
  stopSubagent: ["sessionID"],
  rewind: ["messageID", "files"],
  rewindPreview: ["messageID"],
  openToolText: ["itemId", "part"],
  setPref: ["key", "value"],
  renameSession: ["title"],
  runCommand: ["name", "text", "delivery"],
  shellCommand: ["command"],
  askAside: ["text"],
  toggleBookmark: ["itemId"],
  openBookmark: ["id"],
  removeBookmark: ["id"],
};

/** Returns a typed message, or undefined if the payload does not match the schema exactly. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const msg = raw as Record<string, unknown>;
  const type = msg.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(VALIDATORS, type)) return undefined;
  const key = type as WebviewMessage["type"];
  const allowed = new Set(["type", ...(ALLOWED_KEYS[key] ?? [])]);
  for (const k of Object.keys(msg)) if (!allowed.has(k)) return undefined;
  if (!VALIDATORS[key](msg)) return undefined;
  return msg as unknown as WebviewMessage;
}
