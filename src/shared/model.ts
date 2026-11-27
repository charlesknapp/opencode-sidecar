// Transport-neutral domain types shared by the extension host and the webview.
// Nothing in here may reference OpenCode wire objects directly; the adapter in
// src/opencode/ maps raw payloads onto these shapes.

import type { ApprovalMode, ApprovalState, PermissionRule } from "./approval";

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "connected"; version: string; url: string }
  | { kind: "not-running"; canStart: boolean; detail: string }
  | { kind: "cli-not-found"; searched: string[] }
  | { kind: "error"; message: string };

/**
 * Account / provider evidence from OpenCode's integration list. Only states and counts:
 * connection labels (which may contain personal data) and credentials are never read.
 */
export interface AccountStatus {
  /** OpenCode Console account (integration `opencode`). */
  opencode: "connected" | "needs-auth" | "none";
  /** Another provider (Anthropic, OpenAI, …) has a connection in OpenCode. */
  otherProviders: boolean;
}

/** First-run / connection state of the sidebar, derived by `deriveOnboarding`. */
export type OnboardingStage =
  | "connecting"
  | "not-installed"
  | "stopped"
  | "error"
  | "no-folder"
  | "loading"
  | "sign-in"
  | "sign-in-expired"
  | "no-models"
  | "catalog-error"
  | "ready";

/** Checklist item state: done, needs action, optional (not required to chat), or not known yet. */
export type CheckState = "done" | "todo" | "optional" | "expired" | "unknown";

export type SignInState = "idle" | "waiting" | "cancelled" | "failed";

export interface OnboardingView {
  stage: OnboardingStage;
  checklist: { installed: CheckState; connected: CheckState; account: CheckState; models: CheckState };
  /** Non-blocking note shown while ready. */
  hint: "sign-in-optional" | "sign-in-expired" | null;
  /** `opencode auth login` in a VS Code terminal: running, or how the last attempt ended. */
  signIn: SignInState;
}

export type RepoKind = "local" | "worktree" | "not-git" | "unknown";

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  /** null when no folder is open. */
  active: WorkspaceFolderInfo | null;
  folders: WorkspaceFolderInfo[];
  branch: string | null;
  /** Short commit when HEAD is detached. */
  detachedAt: string | null;
  repoKind: RepoKind;
  repoRoot: string | null;
  /** For a secondary worktree, the path of the main working tree when known. */
  mainWorktree: string | null;
  /** Uncommitted files reported by the Git extension; null when unavailable. */
  uncommitted: number | null;
}

export interface ModelOption {
  /** `${providerID}/${id}` */
  key: string;
  providerID: string;
  id: string;
  name: string;
  providerName: string;
  contextLimit: number | null;
  /** Variant ids OpenCode exposes for this model (e.g. reasoning effort); empty when none. */
  variants: string[];
  /** The model accepts images (OpenCode's `capabilities.input` lists "image"). */
  images?: boolean;
}

export interface AgentOption {
  id: string;
  name: string;
  /** OpenCode's one-line description of the agent, when it has one. */
  description?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  agent: string | null;
  modelKey: string | null;
  /** Model variant recorded on the session, when any. */
  variant: string | null;
  outcome: "succeeded" | "failed" | "interrupted" | null;
  /** Session cost in USD as reported by OpenCode, when present. */
  cost: number | null;
  /** The session was forked from another one. */
  forked?: boolean;
  /** The session is archived (hidden from the history list). */
  archived?: boolean;
  /** OpenCode is working in the session right now (set for the history list). */
  running?: boolean;
  /**
   * A rewind that has been staged but not committed (for example `/undo` in OpenCode's
   * terminal UI): the messages from `messageID` on are hidden until it is committed or
   * cleared. `files` counts the files it restores.
   */
  revert?: { messageID: string; files: number } | null;
  /** The session's own permission rules (OpenCode `permissions`), checked after the agent's. */
  permissions?: PermissionRule[];
}

/** A session strip tab's state: waiting for you, working, finished or failed since you looked, or quiet. */
export type StripStatus = "waiting" | "running" | "done" | "failed" | "idle";

/** A tab of the session strip (sessions opened lately in the folder, and any that work or wait). */
export interface StripTab {
  id: string;
  title: string;
  status: StripStatus;
  /** The open session. */
  current: boolean;
}

export type ContextAttachment =
  | { kind: "file"; id: string; relPath: string; absPath: string }
  /**
   * An image: pasted or dropped (`uri` is a base64 `data:` URI) or picked from disk
   * (`uri` is a `file://` URI). `thumb` is a small preview for the chip.
   */
  | { kind: "image"; id: string; name: string; uri: string; detail: string; thumb?: string }
  | {
      kind: "selection";
      id: string;
      relPath: string;
      absPath: string;
      startLine: number;
      endLine: number;
      text: string;
      languageId: string;
    }
  /**
   * Errors and warnings from VS Code's Problems, grouped by file. `total` is how many
   * there were before the list was capped, so the prompt can say what was left out.
   */
  | { kind: "problems"; id: string; files: ProblemFile[]; total: number };

/** One diagnostic, with 1-based lines and columns and a few lines of code around it. */
export interface ProblemItem {
  severity: "error" | "warning";
  message: string;
  /** VS Code's diagnostic source (`ts`, `eslint`) and code (`2322`), when set. */
  source?: string;
  code?: string;
  line: number;
  column: number;
  endLine: number;
  /** The lines around the problem, the first being line `start`. */
  excerpt?: { start: number; lines: string[] };
}

export interface ProblemFile {
  /** Relative to the open folder with `/` separators, or the absolute path outside it. */
  relPath: string;
  absPath: string;
  languageId: string;
  problems: ProblemItem[];
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageInfo {
  /** Tokens occupying the context window after the most recent step. */
  contextTokens: number | null;
  contextLimit: number | null;
  /** Session cost in USD as reported by OpenCode. */
  cost: number | null;
  /** Share of the last step's input read from the provider's prompt cache (0–1), when reported. */
  cacheHit?: number | null;
  /** When the last step finished (epoch ms), for the prompt-cache estimate. */
  lastStepAt?: number | null;
  /**
   * The last step reported prompt-cache tokens (read or written), so the provider caches.
   * The clock shows only then: a model without a prompt cache has nothing to count down.
   */
  cached?: boolean;
}

/**
 * One row of the usage menu's cost tables: a model, an agent or a subagent, with what
 * OpenCode reported for its steps. `cost` is null when no step reported one (a free
 * model reports 0).
 */
export interface CostRow {
  /** Model key (`opencode/big-pickle`), agent id, or a subagent's session id. */
  key: string;
  /** Agent name or subagent title; the webview names models from its model list. */
  label: string;
  /** Steps seen; null for a subagent known only from its session record. */
  steps: number | null;
  /** Tokens generated (output and reasoning). */
  tokens: number;
  cost: number | null;
  /** Subagent rows: 1 for one the session started, 2 for its subagents, … */
  depth?: number;
  /** Subagent rows with subagents of their own: the cost with theirs included. */
  total?: number | null;
}

/** The session's costs by model and by agent, its own and with its subagents. */
export interface CostBreakdown {
  byModel: CostRow[];
  byAgent: CostRow[];
  /** Session cost reported by OpenCode (its own steps, titles and compaction), USD. */
  session: number | null;
  /** With every subagent's cost included. */
  total: number | null;
  /** Session cost no step accounts for (title generation, compaction), when there is any. */
  other: number | null;
}

/**
 * What takes up the context window. OpenCode reports the total; the parts Sidecar can
 * see (the messages `GET /api/session/{id}/context` returns) are estimated from their
 * text, and `rest` is what is left: the system prompt, tool definitions (MCP included)
 * and instructions, which OpenCode does not list.
 */
export interface ContextBreakdown {
  /** Tokens in the context after the last step, as OpenCode reported them. */
  total: number | null;
  limit: number | null;
  parts: Array<{
    key: "prompts" | "instructions" | "replies" | "tools" | "files" | "summary" | "rest";
    tokens: number;
  }>;
  /** Images attached in the context (not estimated). */
  images: number;
  /** Messages in the context (after the last compaction). */
  messages: number;
}

/**
 * A provider quota OpenCode reports (`GET /api/experimental/usage/limits`): an OpenCode
 * Go allowance window or an OpenCode Console budget.
 */
export interface QuotaMeter {
  id: string;
  label: string;
  /** 0–100. */
  percent: number;
  /** "$3.20 / $10.00" for a budget; null for a Go window, which reports only a share. */
  used: string | null;
  /** OpenCode reports the limit as reached (requests are refused until it resets). */
  limited: boolean;
  /** Epoch ms; null when not reported. */
  resetsAt: number | null;
}

export interface QuotaView {
  /** The OpenCode Console workspace the meters belong to, when named. */
  workspace: string | null;
  meters: QuotaMeter[];
}

/** Usage over a time range across sessions (`GET /api/experimental/session/stats`). */
export interface UsageStats {
  sessions: number;
  steps: number;
  /** USD. */
  cost: number;
  /** Tokens generated (output and reasoning). */
  tokens: number;
  models: Array<{ modelKey: string; steps: number; cost: number }>;
}

/** An OpenCode slash command (`GET /api/command`). */
export interface CommandInfo {
  name: string;
  description: string | null;
}

/**
 * A rule OpenCode saved when "Yes, always allow" was chosen: it answers matching
 * requests in this project without asking. `resource` is the pattern (e.g. `npm test *`).
 */
export interface SavedPermission {
  id: string;
  action: string;
  resource: string;
  /** When it was saved (epoch ms). */
  created: number;
}

/** The approval mode badge and the rules editor, read back from OpenCode. */
export interface ApprovalView {
  /** The open session's mode; without a session, the mode the next one starts in. */
  mode: ApprovalState;
  /** The mode new sessions in this folder start in (Sidecar's choice), if one was picked. */
  folderMode: ApprovalMode | null;
  /** The session's rules that come from the mode (read-only in the editor). */
  modeRules: PermissionRule[];
  /** The session's other rules, which the editor changes. */
  rules: PermissionRule[];
  /** Actions for the editor's picker: OpenCode's agents' and saved rules', and the usual ones. */
  actions: string[];
  /** A session is open (rules can be changed now, not only for the next session). */
  session: boolean;
  /** A change is being sent to OpenCode. */
  busy: boolean;
  /** Ask before switching to Auto (until "don't ask again"). */
  confirmAuto: boolean;
}

/** An MCP server OpenCode is configured with for the folder, and how it is doing. */
export interface McpServerInfo {
  name: string;
  /** OpenCode's display title, when it has one. */
  title?: string;
  status: "connected" | "pending" | "disabled" | "failed" | "needs_auth";
  /** Why it failed or needs sign-in. */
  error?: string;
}

/**
 * A provider in the Providers panel: how OpenCode reaches it, never its credentials or
 * connection labels. `id` is OpenCode's integration id (a provider id for one set up
 * only in OpenCode's config).
 */
export interface ProviderRow {
  id: string;
  name: string;
  state: "connected" | "needs-auth" | "error";
  /** How it is connected: "OAuth", "API key", "Environment variable OPENAI_API_KEY", … */
  via: string;
  /** The last problem, in plain English: OpenCode's sign-in note or the last failed run. */
  error: string | null;
  models: number;
  /** OpenCode has a sign-in method for it that Sidecar can run again. */
  canReauth: boolean;
  /** It has stored credentials (an environment variable or config cannot be removed here). */
  canDisconnect: boolean;
  /** Its endpoint is on this machine (Ollama, LM Studio, …). */
  local?: boolean;
}

/** A provider OpenCode can connect, for the panel's search. */
export interface ProviderChoice {
  id: string;
  name: string;
  /** Its sign-in methods, e.g. "OAuth · API key". */
  methods: string;
  popular?: boolean;
}

export interface ProvidersView {
  connected: ProviderRow[];
  /** Every provider not connected yet, popular ones first. */
  available: ProviderChoice[];
  /** A connect, re-auth or disconnect in progress, with what it waits for. */
  busy: { id: string; text: string } | null;
}

/** An OpenCode skill, which a prompt can mention as `@id`. */
export interface SkillOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * An `@` mention typed in the message box: a workspace file or folder (path relative
 * to the folder), a subagent (its name) or a skill (its id). `text` is the token as
 * typed, such as `@src/a.ts`, and is found in the prompt when it is sent.
 */
export interface PromptMention {
  kind: "file" | "folder" | "agent" | "skill";
  value: string;
  text: string;
}

/** A large paste shown as a chip; `token` (`[Pasted text #1]`) marks its place in the message. */
export interface PromptPaste {
  token: string;
  text: string;
}

/** A suggestion in the `@` list. */
export interface MentionCandidate {
  kind: PromptMention["kind"];
  value: string;
  /** Shown in the list: a file's name, an agent's or skill's name. */
  label: string;
  /** Muted text on the right: a file's folder, an agent's or skill's description. */
  detail?: string;
}

/** A bookmarked answer, kept per workspace in VS Code storage. */
export interface BookmarkView {
  id: string;
  sessionID: string;
  sessionTitle: string;
  itemId: string;
  excerpt: string;
  created: number;
}

/** Error details as reported by OpenCode (already free of credentials). */
export interface RawError {
  type: string;
  message: string;
  status: number | null;
  body: string | null;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  /** OpenCode only offers "always" when the request carries save patterns. */
  canAlways: boolean;
  /** What "always" would allow (OpenCode's save patterns, e.g. `npm test *`). */
  patterns?: string[];
  message: string | null;
  toolId: string | null;
}

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export interface ToolDetail {
  /** Short key/value facts derived from the tool input (never a raw JSON dump). */
  facts: Array<[string, string]>;
  command: string | null;
  cwd: string | null;
  output: string | null;
  outputTruncated: boolean;
  exitCode: number | null;
  files: FileChange[];
  error: string | null;
  /** For a subagent tool call: the session the subagent runs in, once OpenCode reports it. */
  subagent: string | null;
  /** Path the tool works on, from its input (absolute as OpenCode sends it). */
  path?: string;
  /** Search pattern or query, from the input. */
  pattern?: string;
  /** The model's one-line description of the call, when the tool takes one. */
  description?: string;
  /** For a subagent call: the exact prompt it was given. */
  prompt?: string;
  /** Inline diff per changed file, from the edit tool's patch (capped). */
  diffs?: FileDiff[];
  /** Start of the content a write call wrote, and its total line count. */
  written?: { lines: string[]; total: number };
  /** For the todo tool: the whole list as the agent last wrote it. */
  todos?: TodoEntry[];
  /** For an image or video tool: what it makes and its job state ("started", "completed", …). */
  media?: { kind: "image" | "video"; state: string | null };
}

/** One line of an inline diff; "gap" separates hunks. */
export interface DiffLine {
  t: "add" | "del" | "ctx" | "gap";
  text: string;
}

export interface FileDiff {
  /** As OpenCode reports it (relative to the project), the same key the agent diff uses. */
  path: string;
  lines: DiffLine[];
  /** Lines left out after the cap. */
  more: number;
}

export type TranscriptItem =
  /** `time`: when the prompt was sent (epoch ms); absent in transcripts saved before times existed. */
  | { kind: "user"; id: string; text: string; attachments: string[]; time?: number }
  /** `time`: when the text started (epoch ms). */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; time?: number }
  /** `started`/`ended`: when the model began and finished thinking (epoch ms), for "Thought for Ns". */
  | { kind: "reasoning"; id: string; text: string; streaming: boolean; started?: number; ended?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      title: string;
      category: ToolCategory;
      status: ToolStatus;
      detail: ToolDetail;
    }
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      sensitive: string[];
      status: "pending" | "sending" | PermissionDecision | "expired";
      /** What the user told the agent to do instead, sent with a rejection. */
      feedback?: string;
    }
  | { kind: "turn-summary"; id: string; files: FileChange[] }
  /** A subagent's report handed back to the session that started it. */
  | {
      kind: "handback";
      id: string;
      /** The subagent's session, to open its conversation. */
      childID: string | null;
      agent: string | null;
      /** OpenCode's outcome, e.g. "completed". */
      state: string | null;
      description: string | null;
      report: string;
      time?: number;
    }
  /**
   * Something OpenCode posted into the session on its own: a goal's progress, a
   * background shell's result, or a finished image or video job.
   */
  | {
      kind: "background";
      id: string;
      /** OpenCode's `metadata.source`: "goal", "shell", "generate_image", … */
      source: string;
      state: string | null;
      text: string;
      /** For a background shell: its command. */
      command: string | null;
      /** For a media job: the file it saved. */
      path: string | null;
      time?: number;
    }
  | { kind: "notice"; id: string; level: "error" | "info"; text: string }
  | { kind: "form"; id: string; form: FormRequest; status: FormStatus; answer: FormAnswer | null }
  | {
      kind: "error";
      id: string;
      title: string;
      detail: string;
      actions: ErrorAction[];
      /** With the `reauth` action: the provider to sign in to again. */
      provider?: ErrorProvider;
    }
  /**
   * The models a turn ran on, under its last entry: its steps, the tokens they generated,
   * the generation speed (tokens a second while the model streamed) and the cost.
   */
  | {
      kind: "turn-meta";
      id: string;
      models: string[];
      steps: number;
      tokens: number;
      /** Tokens a second; null when OpenCode reported no stream timing. */
      rate: number | null;
      cost: number | null;
    }
  | {
      kind: "budget";
      id: string;
      state: "warning" | "stopped";
      text: string;
      /** Set once the user picked an action on a stopped card. */
      resolved: "continued" | "increased" | "new-session" | null;
    };

// --------------------------------------------------------------- subagents

export type SubagentStatus = "running" | "waiting" | "completed" | "failed" | "stopped";

/** What a running subagent is doing right now. */
export type SubagentActivity =
  { kind: "tool"; title: string; category: ToolCategory } | { kind: "writing" } | { kind: "thinking" };

/** One question asked aside and its answer, streamed as it arrives. */
export interface AsideTurn {
  question: string;
  answer: string;
  /** A readable error when the model or OpenCode failed this question. */
  error: string | null;
  done: boolean;
  /** Its answer was sent to the main session. */
  sent?: boolean;
}

/**
 * A side question (`/btw`): asked in a hidden copy of the open session, so the main
 * session's context and run are untouched. `error` is set when the copy could not be made.
 */
export interface AsideView {
  status: "starting" | "running" | "idle";
  turns: AsideTurn[];
  error: string | null;
  /** What the side thread is doing while it has no text yet ("Reading files…"). */
  activity: string | null;
}

/** Progress of one subagent session started (directly or through other subagents) by the open session. */
export interface SubagentView {
  sessionID: string;
  /** Session that started it: the open session or another subagent. */
  parentID: string;
  /** 1 for a subagent of the open session, 2 for its subagents, … */
  depth: number;
  agent: string | null;
  title: string;
  status: SubagentStatus;
  activity: SubagentActivity | null;
  /** Tool calls and changed files seen live; null when only known from a reopened session. */
  tools: number | null;
  files: number | null;
  /** Epoch milliseconds. */
  started: number | null;
  ended: number | null;
  cost: number | null;
  /** With the cost of its own subagents; set only when it has some. */
  totalCost?: number | null;
  error: string | null;
}

export type InboxDelivery = "steer" | "queue";

export interface PendingInboxItem {
  id: string;
  text: string;
  /** Exact original text, when known. */
  raw?: string;
  attachments: string[];
  delivery: InboxDelivery;
}

// ------------------------------------------------------------------- forms

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormCondition {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
}

interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: FormCondition[];
}

export type FormField =
  | (FormFieldBase & {
      type: "string";
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
      default?: string;
      options?: FormOption[];
      custom?: boolean;
    })
  | (FormFieldBase & { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number })
  | (FormFieldBase & { type: "boolean"; default?: boolean })
  | (FormFieldBase & {
      type: "multiselect";
      options: FormOption[];
      minItems?: number;
      maxItems?: number;
      custom?: boolean;
      default?: string[];
    })
  | { key: string; type: "external"; url: string; title?: string; description?: string };

export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;

export interface FormRequest {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
  /** Tool call that raised the form, when OpenCode reports it. */
  toolId: string | null;
}

export type FormStatus = "pending" | "sending" | "answered" | "cancelled" | "expired";

// ------------------------------------------------------------------ errors

/** `reauth`: run the provider's sign-in again (the error names the provider). */
export type ErrorAction = "changeModel" | "retry" | "reauth";

/** The provider an error card offers to sign in to again (OpenCode's integration). */
export interface ErrorProvider {
  id: string;
  name: string;
}

// ------------------------------------------------------------------ budget

export type BudgetLevel = "off" | "small" | "medium" | "large" | "custom";

export interface BudgetLimits {
  maxCost: number | null;
  maxSteps: number | null;
}

export interface BudgetView {
  level: BudgetLevel;
  limits: BudgetLimits;
  /** Cost of the current/last task in USD; null when OpenCode reported no cost. */
  taskCost: number | null;
  taskSteps: number;
  active: boolean;
  state: "ok" | "warning" | "exceeded";
  /** Multiplier from "Continue once" overrides (1 = no override). */
  allowance: number;
}

export type ToolCategory =
  "read" | "search" | "shell" | "edit" | "web" | "agent" | "todo" | "media" | "other";

/** A task on the agent's todo list (OpenCode's `todowrite` tool). */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface TodoEntry {
  content: string;
  status: TodoStatus;
}

/**
 * Normalized session events (internal UI event model). Produced from OpenCode
 * events by src/opencode/events.ts and from local actions by the host.
 */
export type UiEvent =
  | {
      type: "user.message";
      id: string;
      text: string;
      attachments: string[];
      /** Exact original prompt (including inline selection snippets); used for Current Task / Copy Prompt. */
      raw?: string;
      /** When it happened (epoch ms): from OpenCode for history, stamped on arrival for live events. */
      time?: number;
    }
  | { type: "assistant.delta"; partId: string; delta: string; time?: number }
  | { type: "assistant.completed"; partId: string; text: string; time?: number }
  | { type: "reasoning.delta"; partId: string; delta: string; time?: number }
  /** `started`: when thinking began, known for history; live, it is the first delta's time. */
  | { type: "reasoning.completed"; partId: string; text: string; time?: number; started?: number }
  /** A subagent's report delivered to its parent (OpenCode synthetic message, source "subagent"). */
  | {
      type: "subagent.report";
      id: string;
      childID: string | null;
      agent: string | null;
      state: string | null;
      description: string | null;
      text: string;
      time?: number;
    }
  /** A background notice OpenCode posted into the session (synthetic message, any source but "subagent"). */
  | {
      type: "background.notice";
      id: string;
      source: string;
      state: string | null;
      text: string;
      command: string | null;
      path: string | null;
      time?: number;
    }
  | { type: "tool.started"; toolId: string; name: string }
  | { type: "tool.input"; toolId: string; name: string | null; input: Record<string, unknown> }
  | { type: "tool.shell"; toolId: string; cwd: string | null; command: string | null }
  | {
      type: "tool.completed";
      toolId: string;
      output: string | null;
      metadata: Record<string, unknown> | null;
    }
  | {
      type: "tool.failed";
      toolId: string;
      error: string;
      output: string | null;
      metadata: Record<string, unknown> | null;
    }
  | { type: "permission.requested"; request: PermissionRequest; sensitive: string[] }
  | { type: "permission.sending"; requestId: string }
  | {
      type: "permission.resolved";
      requestId: string;
      decision: PermissionDecision | "expired";
      /** Sent with a rejection: what to do instead. */
      feedback?: string;
    }
  | { type: "files.changed"; files: string[] }
  | { type: "session.busy" }
  | {
      type: "session.idle";
      outcome: "succeeded" | "failed" | "interrupted";
      /**
       * Session that went idle (live events). Only its own pending requests expire, so a
       * subagent's request outlives the parent's turn. Absent for replayed history.
       */
      sessionID?: string;
    }
  | { type: "session.error"; message: string; error: RawError | null; modelKey: string | null }
  | {
      type: "error";
      id: string;
      title: string;
      detail: string;
      actions: ErrorAction[];
      provider?: ErrorProvider;
    }
  | {
      type: "inbox.enqueued";
      id: string;
      text: string;
      attachments: string[];
      delivery: InboxDelivery;
      raw?: string;
    }
  | { type: "inbox.delivered"; id: string }
  | { type: "inbox.cancelled"; id: string }
  | { type: "inbox.delivery"; id: string; delivery: InboxDelivery }
  | { type: "form.requested"; form: FormRequest }
  | { type: "form.sending"; formId: string }
  | {
      type: "form.resolved";
      formId: string;
      status: "answered" | "cancelled" | "expired" | "pending";
      answer: FormAnswer | null;
    }
  | { type: "budget"; id: string; state: "warning" | "stopped"; text: string }
  | { type: "budget.resolved"; id: string; resolution: "continued" | "increased" | "new-session" }
  | { type: "session.retry"; attempt: number; message: string }
  | { type: "session.renamed"; title: string }
  /** The session was rewound (by any client): its messages changed, reload them. */
  | { type: "session.reverted" }
  /** The agent or model was chosen for the session (by any client). */
  | { type: "session.selection"; agent?: string; modelKey?: string; variant?: string | null }
  /** The session's permission rules were replaced (by any client). */
  | { type: "session.permissions"; rules: PermissionRule[] }
  /** A model step started (live only): the throughput readout starts counting again. */
  | { type: "step.started"; modelKey: string | null; agent: string | null }
  /**
   * `time`: when the step finished (epoch ms); stored for history, arrival time live.
   * `cost`: the step's cost in USD, null when not reported. `streamMs`: from the first
   * token to the end of the model's stream, when OpenCode timed both.
   */
  | {
      type: "usage.step";
      tokens: TokenUsage;
      modelKey: string | null;
      time?: number;
      cost?: number | null;
      agent?: string | null;
      streamMs?: number;
    }
  | { type: "usage.session"; cost: number; tokens: TokenUsage }
  | { type: "notice"; level: "error" | "info"; text: string };
