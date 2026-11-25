// Transport-neutral domain types shared by the extension host and the webview.
// Nothing in here may reference OpenCode wire objects directly; the adapter in
// src/opencode/ maps raw payloads onto these shapes.

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
  /**
   * A rewind that has been staged but not committed (for example `/undo` in OpenCode's
   * terminal UI): the messages from `messageID` on are hidden until it is committed or
   * cleared. `files` counts the files it restores.
   */
  revert?: { messageID: string; files: number } | null;
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
    };

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

/** An MCP server OpenCode is configured with for the folder, and how it is doing. */
export interface McpServerInfo {
  name: string;
  /** OpenCode's display title, when it has one. */
  title?: string;
  status: "connected" | "pending" | "disabled" | "failed" | "needs_auth";
  /** Why it failed or needs sign-in. */
  error?: string;
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
  | { kind: "error"; id: string; title: string; detail: string; actions: ErrorAction[] }
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

export type ErrorAction = "changeModel" | "retry";

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
  | { type: "error"; id: string; title: string; detail: string; actions: ErrorAction[] }
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
  /** `time`: when the step finished (epoch ms); stored for history, arrival time live. */
  | { type: "usage.step"; tokens: TokenUsage; modelKey: string | null; time?: number }
  | { type: "usage.session"; cost: number; tokens: TokenUsage }
  | { type: "notice"; level: "error" | "info"; text: string };
