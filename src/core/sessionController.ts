// Session-level behaviour (sessions, model/agent/variant selection, prompting,
// steering/queueing, streaming, permissions, forms, cancellation, budget guard,
// agent changes, usage) on top of the OpenCodeClient adapter. Free of VS Code
// APIs so it can be unit-tested.

import { BudgetTracker, nextLevel, type BudgetSettings } from "./budget";
import { buildPrompt, type PastedText, type PromptPayload, type ResolvedMention } from "./context";
import {
  CONTINUE_TEXT,
  deriveTaskFromHistory,
  oneLine,
  permissionDetail,
  summarizeTask,
  type TaskNotice,
  type TaskRecord,
  type TaskStatus,
} from "./currentTask";
import { classifyError, describeForLog, type FriendlyError } from "./errors";
import { connectIntegration, type ConnectOutcome, type ConnectUi } from "./providerConnect";
import { mcpNameError, parseMcpTarget } from "../shared/mcp";
import { deriveProviders, integrationOf, type IntegrationInfo, type ProviderEntry } from "./providers";
import type { AgentDetail, ConfigSources } from "./agents";
import { sessionMarkdown } from "./exportMarkdown";
import { summarizeAnswer, validateAnswer } from "./forms";
import { reconstructSides, type FileSides } from "./patch";
import { rewindPreview, stepFiles } from "./review";
import {
  SessionWatch,
  STRIP_MAX,
  type BackgroundNotice,
  type StripEntry,
  type WatchContext,
} from "./sessionWatch";
import { MAX_SUBAGENTS, SubagentTracker } from "./subagents";
import { displayTitle, isUsableTitle } from "./titles";
import { contextBreakdown, CostLedger, costBreakdown } from "./usage";
import { OpenCodeHttpError, sameDirectory, type FoundFile, type OpenCodeClient } from "../opencode/client";
import {
  describeSensitive,
  EventNormalizer,
  historyToEvents,
  type NormalizedEnvelope,
} from "../opencode/events";
import type {
  CommandInfo,
  AccountStatus,
  AgentOption,
  ApprovalView,
  AsideView,
  BudgetLevel,
  BudgetView,
  ContextAttachment,
  ContextBreakdown,
  CostBreakdown,
  FileChange,
  RewindPreview,
  FormAnswer,
  GoalState,
  GoalView,
  InboxDelivery,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  McpServerInfo,
  ProvidersView,
  QuotaView,
  SavedPermission,
  SessionSummary,
  SkillOption,
  StripStatus,
  StripTab,
  SubagentView,
  TokenUsage,
  TranscriptItem,
  UiEvent,
  UsageInfo,
  UsageStats,
} from "../shared/model";
import { stampTime, Transcript } from "../shared/transcript";
import {
  APPROVAL_MODES,
  classifyRules,
  KNOWN_ACTIONS,
  presetRules,
  sameRule,
  sameRules,
  type ApprovalMode,
  type PermissionRule,
} from "../shared/approval";

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface ControllerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface ControllerSink {
  onEvents(events: UiEvent[]): void;
  onTranscriptReset(items: TranscriptItem[]): void;
  onStateChanged(): void;
  /** Live task milestones (never emitted for replayed history). */
  onTaskNotice?(notice: TaskNotice): void;
  /** Full transcript of the subagent conversation the user opened (empty while it loads). */
  onSubagentTranscript?(sessionID: string, items: TranscriptItem[]): void;
  /** Live events of the subagent conversation the user opened. */
  onSubagentEvents?(sessionID: string, events: UiEvent[]): void;
  /** The side question (`/btw`) changed: opened, streamed, answered or closed (null). */
  onAsideChanged?(aside: AsideView | null): void;
  /** An MCP server of the open folder connected, failed or needs a sign-in (from any client). */
  onMcpChanged?(): void;
}

/** What the sidebar shows for the Current / Last Task. */
export interface TaskView {
  id: string;
  label: "current" | "last";
  summary: string;
  status: TaskStatus | "waiting" | null;
  steer: string | null;
  next: { summary: string; more: number } | null;
  chars: number;
  lines: number;
}

export interface ControllerDefaults {
  model: string;
  agent: string;
  /** Budget level used when the workspace has no remembered choice. */
  budgetLevel?: BudgetLevel;
  budget?: BudgetSettings;
  /** Warn when the context window is this full (0–100; 0 disables). */
  contextWarnPercent?: number;
  /** Localized UI strings for controller-generated messages. */
  strings?: Partial<ControllerStrings>;
}

export interface ControllerStrings {
  budgetWarning: string;
  budgetStopped: string;
  /** The limit is reached while a file is being written: the agent stops once it is. */
  budgetStopping: (file: string) => string;
  budgetStoppedAfter: (file: string) => string;
  contextWarning: (percent: number) => string;
}

const EN_STRINGS: ControllerStrings = {
  budgetWarning: "Task budget is nearly exhausted.",
  budgetStopped: "Task budget reached. The agent was stopped.",
  budgetStopping: (f) => `Task budget reached. Stopping once ${f} is written.`,
  budgetStoppedAfter: (f) => `Task budget reached. Stopped after finishing ${f}.`,
  contextWarning: (p) => `The context window is ${p}% full. Consider starting a new session.`,
};

/** Agent-attributed changes from OpenCode's session snapshots. */
export type AgentChanges =
  { status: "none" } | { status: "ok"; files: FileChange[] } | { status: "unavailable"; reason: string };

export const HISTORY_LIMIT = 400;
/** Workspace-state key of the side-question sessions not deleted yet. */
export const ASIDES_KEY = "opencodeSidecar.asides";
/** Messages read back to find what a rewind would revert (the history's tail). */
const MAX_REWIND_MESSAGES = 2000;
/** What a side question asks the model, around the question itself. */
export const ASIDE_PREFIX =
  "Side question, asked while you work. Answer it briefly from what you already know about this conversation and the code. Do not change files, run commands or continue the task.\n\n";
/** Sent back when a side question's agent asks for a permission. */
const ASIDE_REJECT = "This is a side question: answer without running tools or changing files.";
const ASIDE_MAX_ANSWER = 20_000;
const SESSION_LIST_LIMIT = 30;

export function contextTokens(t: TokenUsage): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

export function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof OpenCodeHttpError) {
    if (e.status === 401) return "OpenCode rejected the connection credentials.";
    if (e.status === 404) return `${fallback} (not found).`;
    return `${fallback}: ${e.message}`;
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
    return `${fallback}: OpenCode did not respond in time.`;
  if (e instanceof TypeError) return `${fallback}: could not reach OpenCode.`;
  return fallback + ".";
}

export class SessionController {
  readonly transcript = new Transcript();
  directory: string | null = null;
  models: ModelOption[] | null = null;
  agents: AgentOption[] | null = null;
  /** Account / provider connection evidence; null = not checked yet or could not be checked. */
  account: AccountStatus | null = null;
  /** OpenCode's active providers (which integration holds each one's sign-in); null = unknown. */
  providers: ProviderEntry[] | null = null;
  /**
   * The last failed run's message by integration id, for errors a new sign-in or another
   * model fixes. Kept until the provider is connected again.
   */
  readonly providerErrors = new Map<string, string>();
  /** True while the model/agent catalog for the current folder is loading. */
  catalogLoading = false;
  /** The catalog for the current folder has been published at least once. */
  catalogLoaded = false;
  selectedModel: string | null = null;
  selectedAgent: string | null = null;
  /** Selected variant for the selected model; null = model default. */
  selectedVariant: string | null = null;
  sessions: SessionSummary[] = [];
  current: SessionSummary | null = null;
  busy = false;
  stopping = false;
  /** Agent changes for the whole session (snapshot attribution). */
  agentChanges: AgentChanges = { status: "none" };
  /** Steering/queued messages OpenCode has accepted but not yet delivered. */
  pending: PendingInboxItem[] = [];
  /** Completed agent steps in this session. */
  steps = 0;
  readonly budget: BudgetTracker;
  private patches = new Map<string, { patch: string; status: FileChange["status"] }>();
  /** Bumped whenever the agent's patches change, so the review recomputes its hunks only then. */
  changesVersion = 0;
  private lastStep: { tokens: TokenUsage; modelKey: string | null; at: number | null } | null = null;
  /** OpenCode's slash commands for the open folder. */
  commands: CommandInfo[] = [];
  /** Sessions with an execution in progress, from OpenCode's active list and the event stream. */
  private running = new Set<string>();
  /** Subagents and skills a prompt can mention with `@`. */
  mentionAgents: AgentOption[] = [];
  skills: SkillOption[] = [];
  /** Archived sessions, loaded when the history's Archived view opens; null until then. */
  archivedSessions: SessionSummary[] | null = null;
  private sessionCost: number | null = null;
  /** The open session's steps by model and agent. */
  private ledger = new CostLedger();
  /** OpenCode Go and Console limits; null when OpenCode reports none. */
  quota: QuotaView | null = null;
  private quotaAt = 0;
  /**
   * A Budget Guard stop held back while the agent writes files: the card it updates, the
   * edit calls it waits for and the files they write. The run is interrupted once they finish.
   */
  private budgetDrain: {
    id: string;
    tools: Set<string>;
    file: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private contextWarned = false;
  private lastPayload: PromptPayload | null = null;
  private deliveredEarly = new Set<string>();
  /**
   * Subagent sessions started (directly or through other subagents) by the open session.
   * Their progress is summarized for the subagent cards; their permission requests and
   * questions block the open session's run, so they are shown in its conversation.
   */
  private readonly subagents: SubagentTracker;
  /** Subagent conversation the user opened, kept in its own transcript. */
  private viewer: { id: string; transcript: Transcript; loading: boolean } | null = null;
  private viewerToken = 0;
  private titleCache = new Map<string, string | null>();
  private firstUserText: string | null = null;
  private readonly normalizer = new EventNormalizer();
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private changesTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads the open session after a rewind made elsewhere. */
  private revertTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sidecar's own rewind is running (it reloads by itself). */
  private rewinding = false;
  /** Retries the command list while a fresh OpenCode instance is still starting. */
  private commandsTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private errorSeq = 0;
  private budgetSeq = 0;
  private disposed = false;
  /** Current / last task (see src/core/currentTask.ts). */
  task: TaskRecord | null = null;
  /** True between session.execution.started and its idle marker (from OpenCode events). */
  private execActive = false;
  private execSeq = 0;
  private taskStopReason: "budget" | null = null;
  /** Whether a pending inbox item will start a new task when delivered. */
  private pendingStartsTask = new Map<string, boolean>();
  private notified = new Set<string>();
  /** Folder whose catalog is currently being loaded (guards against duplicate reloads). */
  private loadingDirectory: string | null = null;
  private catalogGeneration = 0;
  /** Bumped by every user selection, so a catalog load that raced with it keeps the choice. */
  private selectionVersion = 0;
  private catalogTimer: ReturnType<typeof setTimeout> | undefined;
  private catalogRefresh: Promise<void> | null = null;
  private catalogRefreshAgain = false;
  /** Controller-generated events (budget/context) raised while applying a batch; flushed after it. */
  private deferred: UiEvent[] = [];
  /**
   * The side question (`/btw`): a copy of the open session (or a new one) that only the
   * aside card shows. `parts` holds the current answer's text parts in order; `main` is
   * the session it was asked from (null for a new session not created yet).
   */
  private aside:
    | (AsideView & { id: string | null; main: string | null; token: number; parts: Map<string, string> })
    | null = null;
  private asideToken = 0;
  /** Side-question sessions (and their subagents) not deleted yet: never listed in History. */
  private readonly asideIds = new Set<string>();
  /** The session strip and the sessions working in the background (see src/core/sessionWatch.ts). */
  private readonly watch = new SessionWatch();
  /** Strip sessions missing from the listed ones (older than the list goes back); null while loading. */
  private stripSessions = new Map<string, SessionSummary | null>();
  /** Background sessions whose pending requests were read during their current run. */
  private scanned = new Set<string>();
  /** Every agent's permission rules for the folder (approval modes are fitted to them); null until loaded. */
  agentRules: Record<string, PermissionRule[]> | null = null;
  /** The approval mode picked for the next session while none is open ("this session" scope). */
  private nextMode: ApprovalMode | "default" | null = null;
  /** The mode Sidecar last applied per session: on Plan, Ask and Balanced are the same rules. */
  private modeHints = new Map<string, ApprovalMode>();
  private approvalBusy = false;
  /** Actions of the folder's saved rules, for the rule editor's picker. */
  private savedActions: string[] = [];
  /**
   * The open session's goal: OpenCode's goal plugin's (`live`), or, while its RPC cannot be
   * reached, the objective and rounds read from the goal's notices in the history.
   */
  private goal: { state: GoalState; live: boolean } | null = null;
  private goalToken = 0;
  /** MCP servers added from Sidecar for this OpenCode run, by folder. */
  private readonly mcpAdded = new Map<string, Set<string>>();

  constructor(
    private readonly client: OpenCodeClient,
    private readonly store: KeyValueStore,
    private readonly sink: ControllerSink,
    private readonly log: ControllerLog,
    private readonly defaults: () => ControllerDefaults,
    private readonly timing: {
      debounceMs: number;
      stopCheckMs: number;
      modelRetryMs: number;
      catalogDebounceMs?: number;
      /** How long a Budget Guard stop waits for running edits to finish. */
      budgetDrainMs?: number;
      /** How long a saved agent file may take to show in OpenCode's list, and how often to look. */
      agentWaitMs?: number;
      agentPollMs?: number;
      /** How long to wait before asking OpenCode's goal plugin again. */
      goalRetryMs?: number;
      /** How often an MCP server's state is read while it connects after a sign-in. */
      mcpPollMs?: number;
      /** Clock for subagent timing (tests). */
      now?: () => number;
    } = { debounceMs: 400, stopCheckMs: 15_000, modelRetryMs: 1500 },
  ) {
    this.subagents = new SubagentTracker(timing.now ?? Date.now);
    this.budget = new BudgetTracker(() => {
      const d = this.defaults();
      return (
        d.budget ?? {
          presets: {
            small: { maxCost: 0.1, maxSteps: 20 },
            medium: { maxCost: 0.3, maxSteps: 50 },
            large: { maxCost: 1, maxSteps: 120 },
            custom: { maxCost: 0.5, maxSteps: 80 },
          },
          warnAt: 0.8,
        }
      );
    });
    this.budget.level = this.defaults().budgetLevel ?? "off";
    for (const id of this.store.get<string[]>(ASIDES_KEY) ?? []) this.asideIds.add(id);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.sessionsTimer);
    clearTimeout(this.changesTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.catalogTimer);
    clearTimeout(this.revertTimer);
    clearTimeout(this.commandsTimer);
  }

  /**
   * Reloads OpenCode's commands for the folder. A fresh OpenCode instance answers
   * with an empty list until it has started, so an empty answer is retried twice.
   */
  async refreshCommands(attempt = 0): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    clearTimeout(this.commandsTimer);
    const list = await this.client.listCommands(dir).catch(() => null);
    if (this.disposed || dir !== this.directory) return;
    if (list && JSON.stringify(list) !== JSON.stringify(this.commands)) {
      this.commands = list;
      this.sink.onStateChanged();
    }
    if ((!list || list.length === 0) && attempt < 2)
      this.commandsTimer = setTimeout(() => void this.refreshCommands(attempt + 1), 2000 * (attempt + 1));
  }

  private strings(): ControllerStrings {
    return { ...EN_STRINGS, ...(this.defaults().strings ?? {}) };
  }

  usage(contextLimitFallback = true): UsageInfo | null {
    const step = this.lastStep;
    const tokens = step ? contextTokens(step.tokens) : null;
    const modelKey = step?.modelKey ?? (contextLimitFallback ? this.selectedModel : null);
    const limit = this.models?.find((m) => m.key === modelKey)?.contextLimit ?? null;
    if (tokens === null && this.sessionCost === null) return null;
    const t = step?.tokens;
    const fed = t ? t.input + t.cacheRead + t.cacheWrite : 0;
    return {
      contextTokens: tokens,
      contextLimit: tokens === null ? null : limit,
      cost: this.sessionCost,
      cacheHit: t && fed > 0 ? t.cacheRead / fed : null,
      lastStepAt: step?.at ?? null,
      cached: !!t && t.cacheRead + t.cacheWrite > 0,
    };
  }

  budgetView(): BudgetView {
    return this.budget.view();
  }

  /** The open session's costs by model and by agent, subagents included. */
  costs(): CostBreakdown | null {
    return costBreakdown(this.ledger, this.sessionCost, this.subagents.costs());
  }

  /** What fills the open session's context, from the messages OpenCode builds it from. */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.current) return null;
    const messages = await this.client.sessionContext(this.current.id);
    const u = this.usage();
    return contextBreakdown(messages, u?.contextTokens ?? null, u?.contextLimit ?? null);
  }

  /** Usage in the open folder's project since local midnight. */
  async usageToday(now = new Date()): Promise<UsageStats | null> {
    if (!this.directory) return null;
    const project = await this.client.projectId(this.directory).catch(() => null);
    if (!project) return null;
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return this.client.usageStats({ from: midnight, projectID: project });
  }

  /** Reads the usage limits again after a task, at most once a minute. */
  private async refreshQuota(): Promise<void> {
    const dir = this.directory;
    if (!dir || Date.now() - this.quotaAt < 60_000) return;
    this.quotaAt = Date.now();
    try {
      const quota = await this.client.usageLimits(dir);
      if (dir !== this.directory) return;
      if (JSON.stringify(quota) !== JSON.stringify(this.quota)) {
        this.quota = quota;
        this.sink.onStateChanged();
      }
    } catch (e) {
      this.log.warn(`Reading usage limits failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Title shown for the current session (OpenCode's when usable, else a local fallback). */
  currentTitle(): string | null {
    if (!this.current) return null;
    return displayTitle(this.current.title, this.firstUserText ?? this.firstTranscriptUserText());
  }

  private firstTranscriptUserText(): string | null {
    const u = this.transcript.items.find((i) => i.kind === "user");
    return u?.kind === "user" ? u.text : null;
  }

  /** Session list with cleaned-up titles. Bad titles get a fallback fetched lazily. */
  displaySessions(): SessionSummary[] {
    return this.sessions.map((session) => {
      const working = this.running.has(session.id) || (session.id === this.current?.id && this.busy);
      const s = working ? { ...session, running: true } : session;
      if (isUsableTitle(s.title)) return s;
      if (s.id === this.current?.id) return { ...s, title: this.currentTitle() ?? "Untitled session" };
      if (!this.titleCache.has(s.id)) {
        this.titleCache.set(s.id, null);
        this.client
          .firstUserText(s.id)
          .then((t) => {
            this.titleCache.set(s.id, t);
            this.sink.onStateChanged();
          })
          .catch(() => undefined);
      }
      return { ...s, title: displayTitle(s.title, this.titleCache.get(s.id)) };
    });
  }

  // ---------------------------------------------------------------- catalog

  /** Switches to a workspace directory: loads models, agents and sessions for it. */
  async setDirectory(directory: string | null): Promise<void> {
    // Same folder: nothing to do if its catalog is loaded or still loading.
    if (this.directory === directory && (this.models !== null || this.loadingDirectory === directory)) return;
    // A side question belongs to the folder it was asked in.
    if (this.aside) void this.closeAside();
    this.directory = directory;
    this.loadingDirectory = directory;
    this.clearSession();
    this.sessions = [];
    this.models = null;
    this.agents = null;
    this.account = null;
    this.providers = null;
    this.archivedSessions = null;
    this.catalogLoaded = false;
    this.watch.reset(this.store.get<StripEntry[]>(this.key("strip")));
    this.stripSessions.clear();
    this.scanned.clear();
    this.agentRules = null;
    this.nextMode = null;
    this.savedActions = [];
    const remembered = this.store.get<BudgetLevel>(this.key("budget"));
    this.budget.setLevel(remembered ?? this.defaults().budgetLevel ?? "off");
    this.sink.onStateChanged();
    if (!directory) {
      this.loadingDirectory = null;
      return;
    }
    try {
      await Promise.all([this.loadCatalog(), this.refreshSessions()]);
    } finally {
      if (this.loadingDirectory === directory) this.loadingDirectory = null;
    }
    const rememberedSession = this.store.get<string>(this.key("session"));
    if (rememberedSession && this.sessions.some((s) => s.id === rememberedSession))
      await this.openSession(rememberedSession);
  }

  private key(kind: "model" | "agent" | "session" | "budget" | "strip" | "approval"): string {
    return `opencodeSidecar.${kind}:${this.directory ?? ""}`;
  }

  private variantKey(modelKey: string): string {
    return `opencodeSidecar.variant:${this.directory ?? ""}:${modelKey}`;
  }

  /**
   * Loads models, agents and account status for the current folder. With `keepSelection`
   * (a refresh), the current model, variant and agent stay selected while they still exist.
   */
  async loadCatalog(options: { keepSelection?: boolean } = {}): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const generation = ++this.catalogGeneration;
    const selection = this.selectionVersion;
    this.catalogLoading = true;
    this.sink.onStateChanged();
    try {
      const accountP = this.client.accountStatus(dir).catch((e: unknown) => {
        this.log.error("Checking OpenCode connections failed", e);
        return null;
      });
      let models: ModelOption[] | null;
      try {
        models = await this.client.listModels(dir);
        // A location that OpenCode has not loaded yet briefly reports no models. Refreshes
        // (after the first load) report what OpenCode lists right away.
        const retries = options.keepSelection ? 0 : 2;
        for (let i = 0; i < retries && models.length === 0; i++) {
          await delay(this.timing.modelRetryMs);
          models = await this.client.listModels(dir);
        }
      } catch (e) {
        this.log.error("Loading models failed", e);
        models = null;
      }
      let agents: AgentOption[] | null;
      try {
        agents = await this.client.listAgents(dir);
      } catch (e) {
        this.log.error("Loading agents failed", e);
        agents = null;
      }
      const [commands, mentionAgents, skills, agentRules, providers] = await Promise.all([
        this.client.listCommands(dir).catch((e: unknown) => {
          this.log.warn(`Loading commands failed: ${e instanceof Error ? e.message : String(e)}`);
          return [] as CommandInfo[];
        }),
        this.client.listSubagents(dir).catch(() => [] as AgentOption[]),
        this.client.listSkills(dir).catch(() => [] as SkillOption[]),
        this.client.agentRules(dir).catch((e: unknown) => {
          this.log.warn(
            `Loading agent permission rules failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          return null;
        }),
        this.client.listProviders(dir).catch(() => null),
      ]);
      const account = await accountP;
      const quota = await this.client.usageLimits(dir).catch((e: unknown) => {
        this.log.warn(`Reading usage limits failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      const picked = await this.pickDefaults(dir, models ?? [], agents ?? []);
      if (dir !== this.directory || generation !== this.catalogGeneration || this.disposed) return;
      // Publish the catalog and the defaults together, so a selection made by the user can
      // never be overwritten by defaults that were still being resolved.
      const keep = options.keepSelection || selection !== this.selectionVersion;
      const prevModel = keep && models?.some((m) => m.key === this.selectedModel) ? this.selectedModel : null;
      const prevAgent = keep && agents?.some((a) => a.id === this.selectedAgent) ? this.selectedAgent : null;
      const prevVariant = this.selectedVariant;
      this.models = models;
      this.agents = agents;
      this.commands = commands;
      this.mentionAgents = mentionAgents;
      this.skills = skills;
      // A folder OpenCode has not loaded yet lists no agents: keep what is known.
      if (agentRules && Object.keys(agentRules).length) this.agentRules = agentRules;
      if (!commands.length) this.commandsTimer = setTimeout(() => void this.refreshCommands(1), 2000);
      this.account = account;
      if (providers) this.providers = providers;
      this.quota = quota;
      this.quotaAt = Date.now();
      this.catalogLoaded = true;
      this.selectedModel = prevModel ?? picked.model;
      const variants = models?.find((m) => m.key === this.selectedModel)?.variants ?? [];
      this.selectedVariant =
        prevModel && (prevVariant === null || variants.includes(prevVariant))
          ? prevVariant
          : this.rememberedVariant(this.selectedModel);
      this.selectedAgent = prevAgent ?? picked.agent;
    } finally {
      if (generation === this.catalogGeneration) this.catalogLoading = false;
      this.sink.onStateChanged();
    }
  }

  /** Re-checks models, agents and account status without touching the open session. */
  async refreshCatalog(): Promise<void> {
    clearTimeout(this.catalogTimer);
    if (!this.directory) return;
    // Refreshes requested while one is running are coalesced into one more run, so frequent
    // triggers (events, the sign-in poll) can never keep superseding each other.
    if (this.catalogRefresh) {
      this.catalogRefreshAgain = true;
      return this.catalogRefresh;
    }
    this.catalogRefresh = (async () => {
      try {
        do {
          this.catalogRefreshAgain = false;
          await this.loadCatalog({ keepSelection: true });
        } while (this.catalogRefreshAgain && !this.disposed);
      } finally {
        this.catalogRefresh = null;
      }
    })();
    return this.catalogRefresh;
  }

  /** OpenCode reports provider / model / integration changes, e.g. after `opencode auth login`. */
  private scheduleCatalogRefresh(): void {
    clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => void this.refreshCatalog(), this.timing.catalogDebounceMs ?? 1000);
  }

  private async pickDefaults(
    dir: string,
    models: ModelOption[],
    agents: AgentOption[],
  ): Promise<{ model: string | null; agent: string | null }> {
    const d = this.defaults();
    const has = (k: string | null | undefined): k is string => !!k && models.some((m) => m.key === k);
    let model: string | null = this.store.get<string>(this.key("model")) ?? null;
    if (!has(model)) model = has(d.model) ? d.model : null;
    if (!model) {
      try {
        const def = await this.client.defaultModel(dir);
        if (has(def)) model = def;
      } catch {
        // fall through
      }
    }
    if (!model && models.length) model = models[0].key;

    const hasAgent = (a: string | null | undefined): a is string => !!a && agents.some((x) => x.id === a);
    let agent: string | null = this.store.get<string>(this.key("agent")) ?? null;
    if (!hasAgent(agent))
      agent = hasAgent(d.agent) ? d.agent : hasAgent("build") ? "build" : (agents[0]?.id ?? null);
    return { model, agent };
  }

  /** Last valid variant remembered for this workspace + model, or null (model default). */
  private rememberedVariant(modelKey: string | null): string | null {
    if (!modelKey) return null;
    const model = this.models?.find((m) => m.key === modelKey);
    const v = this.store.get<string>(this.variantKey(modelKey));
    return v && model?.variants.includes(v) ? v : null;
  }

  async refreshSessions(): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    try {
      const [sessions, active] = await Promise.all([
        this.client.listSessions(dir, SESSION_LIST_LIMIT),
        this.client.activeSessions().catch(() => null),
      ]);
      if (dir !== this.directory) return;
      // A side question's session is a fork, which OpenCode lists like any other.
      this.sessions = sessions.filter((s) => !this.asideIds.has(s.id));
      if (active) this.running = active;
      if (this.current) {
        const fresh = sessions.find((s) => s.id === this.current?.id);
        if (fresh) this.current = { ...fresh, cost: fresh.cost ?? this.current.cost };
      }
      if (this.archivedSessions) this.archivedSessions = await this.listArchived(dir);
      this.sink.onStateChanged();
      void this.scanBackground();
    } catch (e) {
      this.log.error("Listing sessions failed", e);
    }
  }

  private async listArchived(dir: string): Promise<SessionSummary[]> {
    return this.client.listSessions(dir, SESSION_LIST_LIMIT, true).catch((e: unknown) => {
      this.log.error("Listing archived sessions failed", e);
      return [];
    });
  }

  /** Loads this folder's archived sessions for the history's Archived view. */
  /** The MCP servers OpenCode has for the open folder. */
  async mcpServers(): Promise<McpServerInfo[]> {
    const dir = this.directory;
    if (!dir) return [];
    const list = await this.client.listMcpServers(dir);
    const added = this.mcpAdded.get(dir);
    // A server Sidecar added that OpenCode no longer lists (a reload, a restart) is forgotten.
    if (added) for (const n of added) if (!list.some((m) => m.name === n)) added.delete(n);
    return list.map((m) => (added?.has(m.name) ? { ...m, runtime: true } : m));
  }

  /** Connects (or retries) an MCP server for this OpenCode run. */
  async connectMcp(name: string): Promise<void> {
    if (!this.directory) return;
    await this.client.connectMcp(this.directory, name);
    this.log.info(`Connected MCP server ${name}`);
  }

  /** Disconnects an MCP server until it is connected again. */
  async disconnectMcp(name: string): Promise<void> {
    if (!this.directory) return;
    await this.client.disconnectMcp(this.directory, name);
    this.log.info(`Disconnected MCP server ${name}`);
  }

  /** Adds an MCP server for this OpenCode run only (nothing is written to OpenCode's config). */
  async addMcp(name: string, target: string): Promise<void> {
    const dir = this.directory;
    if (!dir) throw new Error("Open a folder first.");
    const parsed = parseMcpTarget(target);
    if (!parsed.ok) throw new Error(parsed.error);
    const taken = (await this.client.listMcpServers(dir)).map((m) => m.name);
    const bad = mcpNameError(name, taken);
    if (bad) throw new Error(bad);
    await this.client.addMcp(dir, name, parsed.config);
    let added = this.mcpAdded.get(dir);
    if (!added) this.mcpAdded.set(dir, (added = new Set()));
    added.add(name);
    this.log.info(`Added MCP server ${name} for this OpenCode run (${parsed.config.type})`);
  }

  /** Leaves an MCP server out until OpenCode restarts or reloads its config. */
  async removeMcp(name: string): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    await this.client.removeMcp(dir, name);
    this.mcpAdded.get(dir)?.delete(name);
    this.log.info(`Removed MCP server ${name} for this OpenCode run`);
  }

  /**
   * Signs in to an MCP server that needs it: OpenCode lists the server with the integration
   * it signs in through, so this is the providers' OAuth flow (open the page OpenCode
   * returns, poll until done). Then the server is connected again and its state polled
   * until it settles. `failed` when the server has no sign-in OpenCode offers.
   */
  async authenticateMcp(name: string, ui: ConnectUi): Promise<ConnectOutcome> {
    const dir = this.directory;
    if (!dir) return { kind: "failed", message: "Open a folder first." };
    const server = (await this.client.listMcpServers(dir)).find((m) => m.name === name);
    if (!server) return { kind: "failed", message: `OpenCode no longer lists ${name}.` };
    if (!server.integrationID) return { kind: "failed", message: `OpenCode offers no sign-in for ${name}.` };
    let integration: IntegrationInfo;
    try {
      integration = await this.client.getIntegration(dir, server.integrationID);
    } catch (e) {
      return { kind: "failed", message: friendlyError(e, "OpenCode could not start the sign-in") };
    }
    const outcome = await connectIntegration(this.client, dir, integration, ui);
    if (outcome.kind !== "connected") return outcome;
    try {
      await this.client.connectMcp(dir, name);
    } catch (e) {
      this.log.warn(
        `Connecting ${name} after its sign-in failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const every = this.timing.mcpPollMs ?? 500;
    let status: McpServerInfo["status"] | undefined;
    for (let i = 0; i < 20 && !this.disposed; i++) {
      const now = (await this.client.listMcpServers(dir).catch(() => [])).find((m) => m.name === name);
      status = now?.status;
      if (status === "connected") break;
      if (status === "failed") return { kind: "failed", message: now?.error ?? "It could not connect." };
      await delay(every);
    }
    if (status === "needs_auth")
      return { kind: "failed", message: "OpenCode still reports that it needs a sign-in." };
    this.log.info(`Signed in to MCP server ${name}`);
    return outcome;
  }

  /** OpenCode's integrations for the open folder (every provider it can connect). */
  async integrations(): Promise<IntegrationInfo[]> {
    if (!this.directory) throw new Error("Open a folder first.");
    return this.client.listIntegrations(this.directory);
  }

  /** The Providers panel: connected providers with their state, and the ones to connect. */
  async providersView(busy: ProvidersView["busy"] = null): Promise<ProvidersView> {
    const dir = this.directory;
    if (!dir) throw new Error("Open a folder first.");
    const [integrations, providers] = await Promise.all([
      this.client.listIntegrations(dir),
      this.client.listProviders(dir).catch(() => this.providers),
    ]);
    if (providers) this.providers = providers;
    return deriveProviders({
      integrations,
      providers,
      models: this.models,
      errors: this.providerErrors,
      busy,
    });
  }

  /**
   * Connects a provider, or signs in to it again (`reauth`), through OpenCode's own flow.
   * A success forgets its last error and reloads the catalog. `onName` hears the provider's name.
   */
  async connectProvider(
    id: string,
    ui: ConnectUi,
    reauth = false,
    onName?: (name: string) => void,
  ): Promise<ConnectOutcome> {
    const dir = this.directory;
    if (!dir) return { kind: "failed", message: "Open a folder first." };
    let integration: IntegrationInfo;
    try {
      integration = await this.client.getIntegration(dir, id);
    } catch (e) {
      return { kind: "failed", message: friendlyError(e, "OpenCode could not find this provider") };
    }
    onName?.(integration.name);
    const now = integration.connections.find((c) => !c.needsAuth) ?? integration.connections[0];
    const prefer = reauth && now && now.method !== "env" ? now.method : undefined;
    const outcome = await connectIntegration(this.client, dir, integration, ui, prefer);
    if (outcome.kind === "connected") {
      this.providerErrors.delete(id);
      this.log.info(`Connected ${id} through OpenCode`);
      await this.refreshCatalog();
    } else if (outcome.kind === "failed") this.log.warn(`Connecting ${id} failed: ${outcome.message}`);
    return outcome;
  }

  /** Removes a provider's stored credentials; returns how many were removed. */
  async disconnectProvider(id: string): Promise<number> {
    const dir = this.directory;
    if (!dir) return 0;
    const integration = await this.client.getIntegration(dir, id);
    let n = 0;
    for (const c of integration.connections) {
      if (c.kind !== "credential" || !c.credentialID) continue;
      await this.client.removeCredential(c.credentialID);
      n++;
    }
    this.providerErrors.delete(id);
    this.log.info(`Disconnected ${id} (${n} credential${n === 1 ? "" : "s"} removed)`);
    await this.refreshCatalog();
    return n;
  }

  /** Has OpenCode reload its config (a provider added to opencode.json), then the catalog. */
  async reloadConfig(): Promise<void> {
    await this.client.reloadConfig();
    // A rebuilt folder briefly lists no models, as on its first load.
    const dir = this.directory;
    for (let i = 0; dir && i < 10; i++) {
      if ((await this.client.listModels(dir).catch(() => [])).length) break;
      await delay(this.timing.modelRetryMs);
    }
    await this.refreshCatalog();
  }

  /** Every agent OpenCode has for the open folder (hidden ones too), for the Agents panel. */
  async agentDetails(): Promise<AgentDetail[]> {
    if (!this.directory) throw new Error("Open a folder first.");
    return this.client.listAgentDetails(this.directory);
  }

  /** OpenCode's config folders for the open folder, and the agents its config documents define. */
  async configSources(): Promise<ConfigSources> {
    if (!this.directory) throw new Error("Open a folder first.");
    return this.client.configSources(this.directory);
  }

  /** OpenCode's project folder for the open folder (where its AGENTS.md lives); null when unknown. */
  async projectDirectory(): Promise<string | null> {
    if (!this.directory) throw new Error("Open a folder first.");
    return this.client.projectDirectory(this.directory).catch(() => null);
  }

  /**
   * Waits for OpenCode's agent list to show a change to an agent file (`ready`). OpenCode
   * 2.4 watches its config folders (a `.opencode/agents` created later too) and lists a
   * changed file within a second or two; when it has not after `agentWaitMs`, OpenCode
   * reloads its config and the list is checked again. The catalog is refreshed either way.
   * Returns whether the list got there.
   */
  async awaitAgents(ready: (list: AgentDetail[]) => boolean): Promise<boolean> {
    const dir = this.directory;
    if (!dir) return false;
    const wait = this.timing.agentWaitMs ?? 6000;
    const every = this.timing.agentPollMs ?? 300;
    const poll = async () => {
      for (const end = Date.now() + wait; ;) {
        const list = await this.client.listAgentDetails(dir).catch(() => null);
        if (list && ready(list)) return true;
        if (Date.now() >= end || this.disposed) return false;
        await delay(every);
      }
    };
    let ok = await poll();
    if (!ok && !this.disposed) {
      this.log.info("OpenCode has not picked up the agent file yet; reloading its config");
      try {
        await this.client.reloadConfig();
        ok = await poll();
      } catch (e) {
        this.log.warn(`Reloading OpenCode's config failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.refreshCatalog();
    return ok;
  }

  /** OpenCode's version and process id (`GET /api/info`). */
  serverInfo(): Promise<{ version: string; pid: number | null }> {
    return this.client.info();
  }

  /** What the setup check needs from OpenCode for the open folder; each part null on failure. */
  async setupFacts(): Promise<{
    integrations: IntegrationInfo[] | null;
    defaultModel: string | null;
    projectID: string | null | undefined;
  }> {
    const dir = this.directory;
    if (!dir) return { integrations: null, defaultModel: null, projectID: undefined };
    const [integrations, defaultModel, projectID] = await Promise.all([
      this.client.listIntegrations(dir).catch(() => null),
      this.client.defaultModel(dir).catch(() => null),
      this.client.projectId(dir).catch(() => undefined),
    ]);
    return { integrations, defaultModel, projectID };
  }

  /** The open folder's "always allow" rules, newest first. */
  async savedPermissions(): Promise<SavedPermission[]> {
    const dir = this.directory;
    if (!dir) return [];
    const project = await this.client.projectId(dir);
    const list = project ? await this.client.listSavedPermissions(project) : [];
    this.savedActions = [...new Set(list.map((r) => r.action).filter(Boolean))];
    return list;
  }

  /** Changes a saved rule's action or pattern (OpenCode refuses one the folder already has). */
  async updateSavedPermission(id: string, change: { action?: string; resource?: string }): Promise<void> {
    await this.client.updateSavedPermission(id, change);
    this.log.info(`Changed a saved permission (${id})`);
  }

  /** Stops always allowing a rule: OpenCode asks again next time. */
  async removeSavedPermission(id: string): Promise<void> {
    await this.client.removeSavedPermission(id);
    this.log.info(`Removed a saved permission (${id})`);
  }

  async loadArchived(): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const list = await this.listArchived(dir);
    if (dir !== this.directory) return;
    this.archivedSessions = list;
    this.sink.onStateChanged();
  }

  /**
   * Archives a session (OpenCode keeps it, but leaves it out of the history) or restores
   * it. Archiving the open session starts a new one.
   */
  async setArchived(id: string, archived: boolean): Promise<void> {
    try {
      await this.client.setArchived(id, archived);
      this.log.info(`${archived ? "Archived" : "Restored"} session ${id}`);
    } catch (e) {
      this.log.error("Archiving failed", e);
      const what = archived ? "archive" : "restore";
      this.emit([
        { type: "notice", level: "error", text: friendlyError(e, `Could not ${what} the session`) },
      ]);
      return;
    }
    if (archived) this.dropFromStrip(id);
    if (archived && this.current?.id === id) await this.newSession();
    await this.refreshSessions();
  }

  /** The open session as Markdown, or null when there is nothing to export. */
  exportMarkdown(): string | null {
    if (!this.current || !this.transcript.items.length) return null;
    return sessionMarkdown(this.transcript.items, {
      title: this.currentTitle() ?? "Untitled session",
      exported: Date.now(),
      model: this.selectedModel,
      directory: this.directory,
    });
  }

  /** Deletes a session from OpenCode for good; deleting the open one starts a new session. */
  async deleteSession(id: string): Promise<void> {
    try {
      await this.client.deleteSession(id);
      this.log.info(`Deleted session ${id}`);
    } catch (e) {
      this.log.error("Deleting failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not delete the session") }]);
      return;
    }
    this.dropFromStrip(id);
    if (this.current?.id === id) await this.newSession();
    await this.refreshSessions();
  }

  private scheduleSessionsRefresh(): void {
    clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => void this.refreshSessions(), this.timing.debounceMs);
  }

  // --------------------------------------------------------------- sessions

  private clearSession(): void {
    this.current = null;
    this.busy = false;
    this.stopping = false;
    this.agentChanges = { status: "none" };
    this.patches.clear();
    this.changesVersion++;
    this.pending = [];
    this.steps = 0;
    this.lastStep = null;
    this.sessionCost = null;
    this.ledger.reset();
    this.clearDrain();
    this.contextWarned = false;
    this.lastPayload = null;
    this.firstUserText = null;
    this.deliveredEarly.clear();
    this.subagents.reset();
    this.viewer = null;
    this.viewerToken++;
    this.task = null;
    this.execActive = false;
    this.taskStopReason = null;
    this.pendingStartsTask.clear();
    this.budget.reset();
    clearTimeout(this.stopTimer);
    this.goal = null;
    this.goalToken++;
    this.transcript.reset();
    this.sink.onTranscriptReset([]);
  }

  /** Starts a fresh conversation. The OpenCode session is created lazily on first send. */
  async newSession(): Promise<void> {
    this.loadToken++;
    this.nextMode = null;
    this.leaveSession();
    this.clearSession();
    if (this.directory) await this.store.update(this.key("session"), undefined);
    this.sink.onStateChanged();
  }

  /** Continues an existing OpenCode session: replays history, pending permissions, forms and queue. */
  async openSession(id: string): Promise<boolean> {
    const token = ++this.loadToken;
    const selection = this.selectionVersion;
    try {
      const [summary, messages, rootPermissions, rootForms, inbox, active, subagents] = await Promise.all([
        this.client.getSession(id),
        this.client.listMessages(id, HISTORY_LIMIT),
        this.client.listPermissions(id).catch(() => []),
        this.client.listForms(id).catch(() => []),
        this.client.listInbox(id).catch(() => []),
        this.client.activeSessions().catch(() => new Set<string>()),
        this.listSubagents(id),
      ]);
      // Only a running subagent can be waiting for an answer.
      const waiting = await Promise.all(
        subagents
          .map((s) => s.summary.id)
          .filter((s) => active.has(s))
          .map((s) =>
            Promise.all([
              this.client.listPermissions(s).catch(() => []),
              this.client.listForms(s).catch(() => []),
            ]),
          ),
      );
      const permissions = [...rootPermissions, ...waiting.flatMap(([p]) => p)];
      const forms = [...rootForms, ...waiting.flatMap(([, f]) => f)];
      if (token !== this.loadToken) return false;
      if (this.current?.id !== id) this.leaveSession();
      this.clearSession();
      this.subagents.restore(subagents, active);
      for (const s of subagents) this.watch.link(s.summary.id, s.parentID);
      for (const request of permissions)
        this.subagents.apply(request.sessionID, [{ type: "permission.requested", request, sensitive: [] }]);
      for (const form of forms) this.subagents.apply(form.sessionID, [{ type: "form.requested", form }]);
      this.current = summary;
      this.sessionCost = summary.cost;
      this.busy = active.has(id);
      for (const ev of historyToEvents(messages)) this.applyLocal(ev, true);
      // Pending requests are restored silently: reopening never replays notifications.
      for (const request of permissions) {
        this.applyLocal(
          { type: "permission.requested", request, sensitive: describeSensitive(request.resources) },
          true,
        );
      }
      for (const form of forms) this.applyLocal({ type: "form.requested", form }, true);
      this.pending = inbox;
      this.execActive = this.busy;
      this.task = deriveTaskFromHistory(messages, this.busy);
      for (const item of inbox) this.pendingStartsTask.set(item.id, item.delivery === "queue");
      if (this.busy) this.budget.startTask(this.sessionCost);
      if (selection !== this.selectionVersion) {
        // A model, variant or agent chosen while the session loaded (a reload after the event
        // stream reconnected, say) is the user's latest choice: it goes to the session instead.
        void this.pushSelection(summary);
      } else {
        if (summary.modelKey && this.models?.some((m) => m.key === summary.modelKey)) {
          this.selectedModel = summary.modelKey;
          const model = this.models.find((m) => m.key === summary.modelKey);
          this.selectedVariant =
            summary.variant && model?.variants.includes(summary.variant) ? summary.variant : null;
        }
        if (summary.agent && this.agents?.some((a) => a.id === summary.agent))
          this.selectedAgent = summary.agent;
      }
      if (this.directory) await this.store.update(this.key("session"), id);
      this.watch.opened(id, this.watchContext());
      this.stripSessions.delete(id);
      void this.saveStrip();
      this.sink.onTranscriptReset(this.transcript.items);
      this.sink.onStateChanged();
      void this.refreshChanges();
      void this.loadGoal(id);
      return true;
    } catch (e) {
      this.log.error(`Opening session ${id} failed`, e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not open the session") }]);
      return false;
    }
  }

  /** Sends the selected model, variant and agent to the open session where they differ from `summary`. */
  private async pushSelection(summary: SessionSummary): Promise<void> {
    const variant = (v: string | null) => (v && v !== "default" ? v : null);
    if (summary.modelKey !== this.selectedModel || variant(summary.variant) !== this.selectedVariant)
      await this.pushModel("Model unavailable");
    if (this.selectedAgent && summary.agent !== this.selectedAgent && this.current) {
      const echo = SessionController.echoKey(this.current.id, { agent: this.selectedAgent });
      this.expectEcho(echo);
      try {
        await this.client.switchAgent(this.current.id, this.selectedAgent);
      } catch (e) {
        this.dropEcho(echo);
        this.log.error("Switching agent failed", e);
      }
    }
  }

  /** All subagent sessions below `root`, breadth-first (parents first), bounded by MAX_SUBAGENTS. */
  private async listSubagents(root: string): Promise<Array<{ summary: SessionSummary; parentID: string }>> {
    const found = new Map<string, { summary: SessionSummary; parentID: string }>();
    let level = [root];
    while (level.length > 0 && found.size < MAX_SUBAGENTS) {
      const children = await Promise.all(
        level.map(async (parentID) => ({
          parentID,
          list: await this.client.listChildSessions(parentID).catch(() => []),
        })),
      );
      level = [];
      for (const { parentID, list } of children) {
        for (const summary of list) {
          if (summary.id === root || found.has(summary.id) || found.size >= MAX_SUBAGENTS) continue;
          found.set(summary.id, { summary, parentID });
          level.push(summary.id);
        }
      }
    }
    return [...found.values()];
  }

  // ---------------------------------------------------------- session strip
  //
  // Sessions opened lately in the folder, and any that work or wait, as tabs above the
  // conversation. Sessions other than the open one are followed from the global event
  // stream (their history is never loaded); one that finishes, fails or starts waiting
  // is notified once. Side questions, subagents and other folders' sessions never are.

  private watchContext(): WatchContext {
    return {
      current: this.current?.id ?? null,
      known: (id) =>
        !this.asideIds.has(id) &&
        (id === this.current?.id || this.watch.has(id) || this.sessions.some((s) => s.id === id)),
      running: (id) => this.running.has(id),
    };
  }

  private async saveStrip(): Promise<void> {
    if (!this.directory) return;
    const saved = this.watch.saved();
    await this.store.update(this.key("strip"), saved.length ? saved : undefined);
  }

  /** The conversation being left: what it still waits on stays on its strip tab. */
  private leaveSession(): void {
    const id = this.current?.id;
    if (!id) return;
    this.watch.seedWaiting(
      id,
      this.transcript.items.flatMap((i) =>
        i.kind === "permission" && i.status === "pending"
          ? [{ id: i.request.id, sessionID: i.request.sessionID }]
          : i.kind === "form" && i.status === "pending"
            ? [{ id: i.form.id, sessionID: i.form.sessionID }]
            : [],
      ),
    );
  }

  private dropFromStrip(id: string): void {
    this.stripSessions.delete(id);
    if (this.watch.remove(id)) void this.saveStrip();
  }

  /** Takes a session off the strip; it stays in History. The open session stays. */
  closeStripTab(id: string): void {
    if (id === this.current?.id) return;
    this.dropFromStrip(id);
    this.sink.onStateChanged();
  }

  /** True for a session of the open folder (listed, or on the strip). */
  inFolder(id: string): boolean {
    return this.watchContext().known(id);
  }

  /** Requests waiting for an answer in sessions other than the open one. */
  backgroundWaitingCount(): number {
    return this.watch.backgroundWaiting(this.current?.id ?? null);
  }

  /** The strip's tabs, most recent first. */
  stripView(): StripTab[] {
    const ctx = this.watchContext();
    const listed = new Map(this.displaySessions().map((s) => [s.id, s]));
    const tabs: StripTab[] = [];
    for (const id of this.watch.ids()) {
      if (this.asideIds.has(id)) continue;
      const current = id === ctx.current;
      const summary = listed.get(id) ?? this.stripSessions.get(id);
      if (!current && !summary) {
        // Older than the listed sessions: shown once OpenCode has described it.
        this.loadStripSession(id);
        continue;
      }
      const title = current
        ? (this.currentTitle() ?? "Untitled session")
        : displayTitle(summary!.title, this.titleCache.get(id));
      let status: StripStatus;
      if (current)
        status =
          this.pendingRequestCount() > 0
            ? "waiting"
            : this.busy || this.subagentsActive()
              ? "running"
              : "idle";
      else status = this.watch.status(id, ctx);
      tabs.push({ id, title, status, current });
    }
    return tabs;
  }

  private loadStripSession(id: string): void {
    if (this.stripSessions.has(id)) return;
    this.stripSessions.set(id, null);
    const dir = this.directory;
    this.client
      .getSession(id)
      .then((s) => {
        if (dir !== this.directory) return;
        if (s.archived) this.dropFromStrip(id);
        else this.stripSessions.set(id, s);
        this.sink.onStateChanged();
      })
      .catch((e: unknown) => {
        if (dir !== this.directory) return;
        if (e instanceof OpenCodeHttpError && e.status === 404) {
          this.dropFromStrip(id);
          this.sink.onStateChanged();
        } else
          this.log.warn(`Loading strip session ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** A session's title for a notice. */
  private titleOf(id: string): string {
    if (id === this.current?.id) return this.currentTitle() ?? "Untitled session";
    const s = this.sessions.find((x) => x.id === id) ?? this.stripSessions.get(id);
    return displayTitle(s?.title, this.titleCache.get(id));
  }

  /** Live events of any session, for the strip and the background notices. */
  private watchEvents(raw: unknown, env: NormalizedEnvelope): void {
    const id = env.sessionID!;
    if (env.parentID && env.created) this.watch.link(id, env.parentID);
    if (isRemovalEvent(raw)) {
      if (this.watch.has(id) && id !== this.current?.id) {
        this.dropFromStrip(id);
        this.sink.onStateChanged();
      }
      return;
    }
    if (!env.events.length) return;
    const ctx = this.watchContext();
    const root = this.watch.rootOf(id);
    // A later run is read again if Sidecar reconnects during it.
    if (id === root && env.events.some((ev) => ev.type === "session.idle")) this.scanned.delete(root);
    const { changed, save, notices } = this.watch.apply(id, env.events, ctx);
    if (save) void this.saveStrip();
    if (changed && root !== ctx.current) this.sink.onStateChanged();
    for (const n of notices) this.noticeBackground(n);
  }

  private noticeBackground(n: BackgroundNotice): void {
    const title = this.titleOf(n.sessionID);
    this.log.info(`Background session ${n.sessionID}: ${n.kind}`);
    this.sink.onTaskNotice?.({
      kind: n.kind,
      key: n.key,
      summary: title,
      sessionTitle: title,
      sessionID: n.sessionID,
      ...(n.detail ? { detail: n.detail } : {}),
    });
  }

  /**
   * Reads what the folder's working background sessions wait on (OpenCode's pending
   * lists, theirs and their running subagents'), once per run, so a request raised before
   * Sidecar connected shows on the strip too. Never notifies.
   */
  private async scanBackground(): Promise<void> {
    const dir = this.directory;
    const roots = this.sessions
      .filter((s) => this.running.has(s.id) && s.id !== this.current?.id && !this.scanned.has(s.id))
      .slice(0, STRIP_MAX)
      .map((s) => s.id);
    for (const root of roots) {
      this.scanned.add(root);
      try {
        const subagents = await this.listSubagents(root);
        for (const s of subagents) this.watch.link(s.summary.id, s.parentID);
        const ids = [root, ...subagents.map((s) => s.summary.id).filter((s) => this.running.has(s))];
        const lists = await Promise.all(
          ids.map((s) => Promise.all([this.client.listPermissions(s), this.client.listForms(s)])),
        );
        if (dir !== this.directory || this.disposed || root === this.current?.id) continue;
        this.watch.seedWaiting(
          root,
          lists.flatMap(([permissions, forms]) => [
            ...permissions.map((p) => ({ id: p.id, sessionID: p.sessionID })),
            ...forms.map((f) => ({ id: f.id, sessionID: f.sessionID })),
          ]),
        );
        if (this.watch.show(root, this.watchContext())) void this.saveStrip();
        this.sink.onStateChanged();
      } catch (e) {
        this.log.warn(`Checking session ${root} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // -------------------------------------------------------------- subagents

  /** Progress of the open session's subagents, parents before their own subagents. */
  subagentViews(): SubagentView[] {
    return this.subagents.views();
  }

  /** The subagent conversation the user opened, if any. */
  viewingSubagent(): { id: string; loading: boolean } | null {
    return this.viewer ? { id: this.viewer.id, loading: this.viewer.loading } : null;
  }

  subagentItems(): TranscriptItem[] {
    return this.viewer?.transcript.items ?? [];
  }

  /** Opens a subagent's conversation: its history, then its live events. */
  async openSubagent(id: string): Promise<boolean> {
    if (!this.current || !this.subagents.has(id)) return false;
    const token = ++this.viewerToken;
    this.viewer = { id, transcript: new Transcript(), loading: true };
    this.sink.onSubagentTranscript?.(id, []);
    this.sink.onStateChanged();
    try {
      const messages = await this.client.listMessages(id, HISTORY_LIMIT);
      if (token !== this.viewerToken || !this.viewer) return false;
      const t = this.viewer.transcript;
      t.reset();
      for (const ev of historyToEvents(messages)) t.apply(ev);
      // Requests the subagent is waiting on are already in the conversation; show them here too.
      for (const item of this.transcript.items) {
        if (item.kind === "permission" && item.request.sessionID === id) t.upsert(item);
        else if (item.kind === "form" && item.form.sessionID === id) t.upsert(item);
      }
      this.viewer.loading = false;
      this.sink.onSubagentTranscript?.(id, t.items);
      this.sink.onStateChanged();
      return true;
    } catch (e) {
      if (token !== this.viewerToken) return false;
      this.log.error(`Opening subagent ${id} failed`, e);
      this.closeSubagent();
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not open the subagent") }]);
      return false;
    }
  }

  closeSubagent(): void {
    if (!this.viewer) return;
    this.viewerToken++;
    this.viewer = null;
    this.sink.onStateChanged();
  }

  /** Stops one subagent (OpenCode interrupt on its session); the rest of the task continues. */
  async stopSubagent(id: string): Promise<void> {
    if (!this.subagents.has(id)) return;
    try {
      await this.client.interrupt(id);
      this.log.info(`Subagent ${id} interrupted`);
    } catch (e) {
      this.log.error(`Stopping subagent ${id} failed`, e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not stop the subagent") }]);
    }
  }

  /** True while a subagent of the open session is still working. */
  private subagentsActive(): boolean {
    return this.subagents.views().some((v) => v.status === "running" || v.status === "waiting");
  }

  private modelRef(): { providerID: string; id: string; variant?: string } | undefined {
    const model = this.models?.find((m) => m.key === this.selectedModel);
    if (!model) return undefined;
    return {
      providerID: model.providerID,
      id: model.id,
      ...(this.selectedVariant ? { variant: this.selectedVariant } : {}),
    };
  }

  async selectModel(key: string): Promise<void> {
    const model = this.models?.find((m) => m.key === key);
    if (!model) return;
    this.selectionVersion++;
    this.selectedModel = key;
    // Restore this model's last valid variant for the workspace.
    this.selectedVariant = this.rememberedVariant(key);
    if (this.directory) await this.store.update(this.key("model"), key);
    this.sink.onStateChanged();
    await this.pushModel("Model unavailable");
  }

  /** Selects a model variant (null = model default). Only variants OpenCode lists are accepted. */
  async selectVariant(variant: string | null): Promise<void> {
    const model = this.models?.find((m) => m.key === this.selectedModel);
    if (!model) return;
    if (variant !== null && !model.variants.includes(variant)) return;
    this.selectionVersion++;
    this.selectedVariant = variant;
    if (this.directory) await this.store.update(this.variantKey(model.key), variant ?? undefined);
    this.sink.onStateChanged();
    await this.pushModel("Could not switch the model variant");
  }

  /**
   * Selections Sidecar sent that OpenCode has not echoed back yet (`session.model.selected`,
   * `session.agent.selected`). An echo can arrive after a newer local choice; it must not undo it.
   */
  private selectionEchoes: string[] = [];
  /** The last selection Sidecar sent, per session and kind (model or agent). */
  private latestSelection = new Map<string, string>();

  private static echoKey(
    sessionID: string,
    sel: { agent?: string; modelKey?: string; variant?: string | null },
  ): string {
    // OpenCode records "no variant" as `default`.
    if (sel.agent) return `${sessionID} agent ${sel.agent}`;
    const variant = sel.variant && sel.variant !== "default" ? sel.variant : "";
    return `${sessionID} model ${sel.modelKey ?? ""}#${variant}`;
  }

  private static echoKind(key: string): string {
    return key.slice(0, key.indexOf(" ", key.indexOf(" ") + 1));
  }

  private expectEcho(key: string): void {
    this.selectionEchoes.push(key);
    this.latestSelection.set(SessionController.echoKind(key), key);
    // Echoes lost with a dropped event stream must not pile up.
    if (this.selectionEchoes.length > 20) this.selectionEchoes.shift();
  }

  /** Forgets a selection OpenCode refused (it will not be echoed). */
  private dropEcho(key: string): void {
    const at = this.selectionEchoes.lastIndexOf(key);
    if (at >= 0) this.selectionEchoes.splice(at, 1);
  }

  /**
   * Whether a selection event only echoes a change Sidecar made before its latest one.
   * Echoes can arrive in any order, so the latest choice is kept apart from the list.
   */
  private staleEcho(sessionID: string, sel: { agent?: string; modelKey?: string; variant?: string | null }) {
    const key = SessionController.echoKey(sessionID, sel);
    const at = this.selectionEchoes.indexOf(key);
    if (at < 0) return false;
    this.selectionEchoes.splice(at, 1);
    return this.latestSelection.get(SessionController.echoKind(key)) !== key;
  }

  private async pushModel(failure: string): Promise<void> {
    const ref = this.modelRef();
    if (!this.current || !ref) return;
    const echo = SessionController.echoKey(this.current.id, {
      modelKey: `${ref.providerID}/${ref.id}`,
      variant: ref.variant,
    });
    // Recorded before the request: OpenCode can publish the event before it answers.
    this.expectEcho(echo);
    try {
      await this.client.switchModel(this.current.id, ref);
    } catch (e) {
      this.dropEcho(echo);
      this.log.error("Switching model failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, failure) }]);
    }
  }

  async selectAgent(id: string): Promise<void> {
    if (!this.agents?.some((a) => a.id === id)) return;
    this.selectionVersion++;
    this.selectedAgent = id;
    if (this.directory) await this.store.update(this.key("agent"), id);
    this.sink.onStateChanged();
    if (this.current) {
      const echo = SessionController.echoKey(this.current.id, { agent: id });
      this.expectEcho(echo);
      try {
        await this.client.switchAgent(this.current.id, id);
      } catch (e) {
        this.dropEcho(echo);
        this.log.error("Switching agent failed", e);
        this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not switch agent") }]);
        return;
      }
      await this.refitMode();
    }
  }

  async selectBudget(level: BudgetLevel): Promise<void> {
    this.budget.setLevel(level);
    if (this.directory) await this.store.update(this.key("budget"), level);
    this.sink.onStateChanged();
    this.checkBudget(this.budget.evaluate());
    this.flushDeferred();
  }

  private flushDeferred(): void {
    const d = this.deferred.splice(0);
    if (d.length) this.emit(d);
  }

  // ---------------------------------------------------------------- prompts

  /**
   * Sends a prompt. While the agent is running, `delivery` decides how OpenCode
   * handles it: "steer" (injected at the next step) or "queue" (after the task).
   * Returns false when nothing was sent (caller may restore the input).
   */
  async send(
    text: string,
    attachments: readonly ContextAttachment[],
    delivery?: InboxDelivery,
    mentions: readonly ResolvedMention[] = [],
    pastes: readonly PastedText[] = [],
  ): Promise<boolean> {
    if (!this.directory) {
      this.emit([{ type: "notice", level: "error", text: "Open a folder to start an OpenCode session." }]);
      return false;
    }
    if (this.busy && (!delivery || !this.current)) return false;
    const payload = buildPrompt(text, attachments, mentions, pastes);
    if (!payload.text) {
      if (payload.files.length) {
        this.emit([
          { type: "notice", level: "info", text: "Type a message to send with the attached files." },
        ]);
      }
      return false;
    }
    return this.dispatch(payload, this.busy ? delivery : undefined);
  }

  /** The open session, created on first use (like the first prompt does). */
  private async ensureSession(): Promise<SessionSummary> {
    if (this.current) return this.current;
    // The approval mode picked for it, or the folder's, is set as the session is created.
    const mode = this.nextMode ?? this.folderMode();
    const permissions =
      mode && mode !== "default" ? presetRules(mode, this.rulesOf(this.selectedAgent)) : undefined;
    const created = await this.client.createSession({
      directory: this.directory!,
      agent: this.selectedAgent ?? undefined,
      model: this.modelRef(),
      ...(permissions?.length ? { permissions } : {}),
    });
    this.nextMode = null;
    if (mode && mode !== "default") this.modeHints.set(created.id, mode);
    this.current = created;
    this.sessionCost = created.cost ?? 0;
    this.loadToken++;
    await this.store.update(this.key("session"), created.id);
    this.watch.opened(created.id, this.watchContext());
    this.stripSessions.set(created.id, created);
    void this.saveStrip();
    this.log.info(`Created session ${created.id}`);
    this.scheduleSessionsRefresh();
    return created;
  }

  /** Runs an OpenCode slash command; its arguments go as the command's text. */
  async runCommand(name: string, text: string, delivery?: InboxDelivery): Promise<void> {
    if (!this.directory) return;
    if (!this.commands.some((c) => c.name === name)) {
      this.emit([{ type: "notice", level: "error", text: `Unknown command /${name}.` }]);
      return;
    }
    try {
      const s = await this.ensureSession();
      await this.client.runCommand(s.id, name, text, this.busy ? delivery : undefined);
      this.log.info(`Command /${name} sent to ${s.id}`);
    } catch (e) {
      this.log.error(`Command /${name} failed`, e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, `Could not run /${name}`) }]);
    }
  }

  /** Asks OpenCode to summarize the conversation so far (it runs at the next step boundary). */
  async compact(): Promise<void> {
    if (!this.current) {
      this.emit([{ type: "notice", level: "info", text: "Nothing to compact yet." }]);
      return;
    }
    try {
      await this.client.compact(this.current.id);
      this.log.info(`Compaction requested for ${this.current.id}`);
    } catch (e) {
      this.log.error("Compaction request failed", e);
      this.emit([
        { type: "notice", level: "error", text: friendlyError(e, "Could not compact the conversation") },
      ]);
    }
  }

  /** Runs `!command` in the session's working directory; output shows as a shell row. */
  async runShell(command: string): Promise<void> {
    if (!this.directory || !command.trim()) return;
    if (this.busy) {
      this.emit([
        {
          type: "notice",
          level: "info",
          text: "Wait for the agent to finish before running a shell command.",
        },
      ]);
      return;
    }
    try {
      const s = await this.ensureSession();
      await this.client.runShell(s.id, command.trim());
      this.log.info(`Shell command sent to ${s.id} (${command.length} chars)`);
    } catch (e) {
      this.log.error("Shell command failed", e);
      this.emit([
        { type: "notice", level: "error", text: friendlyError(e, "Could not run the shell command") },
      ]);
    }
  }

  private async dispatch(payload: PromptPayload, delivery?: InboxDelivery): Promise<boolean> {
    const wasBusy = this.busy;
    if (!wasBusy) {
      this.busy = true;
      this.sink.onStateChanged();
    }
    try {
      const session = await this.ensureSession();
      const res = await this.client.prompt(session.id, {
        ...payload,
        ...(delivery ? { delivery } : {}),
      });
      this.lastPayload = payload;
      this.log.info(
        `Prompt sent to ${session.id} (${payload.text.length} chars, ${payload.files.length} file attachment(s)${delivery ? `, ${delivery}` : ""})`,
      );
      // The server echoes the message as session.inbox.enqueued/delivered; this covers missed events.
      if (res.id && !this.transcript.has(`user:${res.id}`) && !this.pending.some((p) => p.id === res.id)) {
        const [ev] = historyToEvents([
          { type: "user", id: res.id, text: payload.text, files: payload.files },
        ]);
        if (ev?.type === "user.message") {
          if (this.deliveredEarly.has(res.id) || !wasBusy) {
            this.deliveredEarly.delete(res.id);
            this.trackUserMessage(res.id, payload.text, !wasBusy || delivery === "queue");
            this.emit([{ ...ev, raw: payload.text }]);
          } else
            this.emit([
              {
                type: "inbox.enqueued",
                id: ev.id,
                text: ev.text,
                attachments: ev.attachments,
                delivery: delivery ?? "steer",
              },
            ]);
        }
      }
      return true;
    } catch (e) {
      if (!wasBusy) this.busy = false;
      this.log.error("Sending prompt failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Session failed") }]);
      this.sink.onStateChanged();
      return false;
    }
  }

  /** Re-sends the last prompt after a failure (explicit user action). */
  async retry(): Promise<boolean> {
    if (this.busy || !this.lastPayload || !this.directory) return false;
    return this.dispatch(this.lastPayload);
  }

  /** Switches a waiting message between steer (next step) and queue (after the task). */
  async setPendingDelivery(id: string, delivery: InboxDelivery): Promise<void> {
    const item = this.pending.find((p) => p.id === id);
    if (!this.current || !item || item.delivery === delivery) return;
    try {
      await this.client.setInboxDelivery(this.current.id, id, delivery);
      this.applyInbox({ type: "inbox.delivery", id, delivery });
      this.sink.onStateChanged();
    } catch (e) {
      this.log.warn(`Changing a waiting message failed: ${e instanceof Error ? e.message : String(e)}`);
      this.emit([
        { type: "notice", level: "info", text: "That message was already delivered to the agent." },
      ]);
    }
  }

  /** Removes a pending steering/queued message before OpenCode delivers it. Returns its text. */
  async cancelPending(id: string): Promise<string | null> {
    const item = this.pending.find((p) => p.id === id);
    if (!this.current || !item) return null;
    try {
      await this.client.cancelInbox(this.current.id, id);
      this.applyInbox({ type: "inbox.cancelled", id });
      this.sink.onStateChanged();
      return item.text;
    } catch (e) {
      this.log.warn(`Cancelling queued message failed: ${e instanceof Error ? e.message : String(e)}`);
      this.emit([
        { type: "notice", level: "info", text: "That message was already delivered to the agent." },
      ]);
      return null;
    }
  }

  /** Cancels the active execution through OpenCode's interrupt API. */
  async stop(): Promise<void> {
    if (!this.current || !this.busy) return;
    const id = this.current.id;
    this.stopping = true;
    this.sink.onStateChanged();
    try {
      const interrupted = await this.client.interrupt(id);
      this.log.info(`Interrupt ${id}: ${interrupted ? "accepted" : "nothing running"}`);
      if (!interrupted) {
        this.busy = false;
        this.stopping = false;
        this.budget.endTask();
        this.sink.onStateChanged();
        return;
      }
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => void this.verifyStopped(id), this.timing.stopCheckMs);
    } catch (e) {
      this.stopping = false;
      this.log.error("Interrupt failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not stop the session") }]);
      this.sink.onStateChanged();
    }
  }

  private async verifyStopped(id: string): Promise<void> {
    if (this.current?.id !== id || !this.stopping) return;
    try {
      const active = await this.client.activeSessions();
      if (!active.has(id)) {
        this.busy = false;
        this.stopping = false;
        this.budget.endTask();
        this.sink.onStateChanged();
      }
    } catch {
      // keep current state; the event stream will settle it
    }
  }

  /** Renames the open session; the title shows in the header and the history list. */
  async renameSession(title: string): Promise<void> {
    const t = title.trim().slice(0, 200);
    if (!this.current || !t) return;
    try {
      await this.client.renameSession(this.current.id, t);
      this.current = { ...this.current, title: t };
      this.sink.onStateChanged();
      void this.refreshSessions();
    } catch (e) {
      this.log.error("Rename failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not rename the session") }]);
    }
  }

  /**
   * Forks the open session into a new one and opens it: the conversation before one of
   * its prompts (`messageID`), or all of it. The original session is left as it was.
   * Returns the prompt's text, so it can go into the message box, or "" for a full fork;
   * null when nothing was forked.
   */
  async fork(messageID?: string): Promise<string | null> {
    const item = messageID ? this.transcript.get(`user:${messageID}`) : undefined;
    if (!this.current || (messageID && item?.kind !== "user")) return null;
    const from = this.current.id;
    let forked: SessionSummary;
    try {
      forked = await this.client.forkSession(from, messageID);
      this.log.info(`Forked ${from}${messageID ? ` before ${messageID}` : ""} into ${forked.id}`);
    } catch (e) {
      this.log.error("Fork failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not fork the session") }]);
      return null;
    }
    await this.refreshSessions();
    if (!this.sessions.some((s) => s.id === forked.id)) this.sessions = [forked, ...this.sessions];
    if (!(await this.openSession(forked.id))) return null;
    return item?.kind === "user" ? item.text : "";
  }

  // ------------------------------------------------------------ side questions
  //
  // `/btw <question>` asks in a copy of the open session (OpenCode's fork), so the
  // answer can use the conversation while the main session's context, run, queue and
  // requests stay as they are. The copy runs the Plan agent when OpenCode lists it (it
  // cannot edit files), and is deleted when the aside closes.

  /** The side question for the view, or null. */
  asideView(): AsideView | null {
    const a = this.aside;
    if (!a) return null;
    return {
      status: a.status,
      turns: a.turns.map((t) => ({ ...t })),
      error: a.error,
      activity: a.activity,
    };
  }

  private asideChanged(): void {
    this.sink.onAsideChanged?.(this.asideView());
  }

  /** Remembers a side-question session until it is deleted (cleaned up at the next start). */
  private async trackAside(id: string, keep: boolean): Promise<void> {
    if (keep) this.asideIds.add(id);
    else this.asideIds.delete(id);
    const saved = new Set(this.store.get<string[]>(ASIDES_KEY) ?? []);
    if (keep) saved.add(id);
    else saved.delete(id);
    await this.store.update(ASIDES_KEY, saved.size ? [...saved] : undefined);
  }

  /**
   * Asks a side question: the first one makes the side thread, later ones follow up in
   * it. Does nothing while the side thread is still answering.
   */
  async askAside(question: string): Promise<void> {
    const q = question.trim();
    if (!q || !this.directory) return;
    let a = this.aside;
    if (a && a.status !== "idle") return;
    if (!a || !a.id) {
      a = {
        id: null,
        main: this.current?.id ?? null,
        token: ++this.asideToken,
        status: "starting",
        turns: [],
        error: null,
        activity: null,
        parts: new Map(),
      };
      this.aside = a;
    }
    a.turns.push({ question: q, answer: "", error: null, done: false });
    a.parts = new Map();
    a.status = a.id ? "running" : "starting";
    a.error = null;
    a.activity = null;
    this.asideChanged();
    const turn = a.turns[a.turns.length - 1];
    const token = a.token;
    try {
      if (!a.id) {
        const id = await this.openAsideSession();
        if (this.aside?.token !== token) {
          // Closed while the copy was being made.
          await this.dropAsideSession(id, false);
          return;
        }
        a.id = id;
        a.status = "running";
      }
      await this.client.prompt(a.id, { text: ASIDE_PREFIX + q, files: [] });
      this.log.info(`Side question sent to ${a.id} (${q.length} chars)`);
    } catch (e) {
      if (this.aside?.token !== token) return;
      this.log.error("Side question failed", e);
      const msg = friendlyError(
        e,
        a.id ? "Could not ask the side question" : "Could not start the side thread",
      );
      if (a.id) turn.error = msg;
      else a.error = msg;
      turn.done = true;
      a.status = "idle";
    }
    this.asideChanged();
  }

  /**
   * A copy of the open session for a side question, with the main session's model and
   * the Plan agent. With nothing to copy yet (OpenCode cannot fork an empty session),
   * a new session in the folder.
   */
  private async openAsideSession(): Promise<string> {
    const agent = this.agents?.some((x) => x.id === "plan") ? "plan" : (this.selectedAgent ?? undefined);
    const model = this.modelRef();
    const from = this.current;
    const fresh = async () => {
      const s = await this.client.createSession({ directory: this.directory!, agent, model });
      await this.trackAside(s.id, true);
      this.log.info(`Side thread ${s.id} started in a new session`);
      return s.id;
    };
    if (!from || !this.transcript.items.length) return fresh();
    let s: SessionSummary;
    try {
      s = await this.client.forkSession(from.id);
    } catch (e) {
      // "Cannot fork empty session": a session with no messages yet.
      if (e instanceof OpenCodeHttpError && e.status === 400 && /empty/i.test(e.message)) return fresh();
      throw e;
    }
    await this.trackAside(s.id, true);
    this.log.info(`Side thread ${s.id} forked from ${from.id}`);
    // The copy keeps the session's own model and agent; the ones picked now win.
    const variant = (v: string | null) => (v && v !== "default" ? v : null);
    if (model && (s.modelKey !== this.selectedModel || variant(s.variant) !== this.selectedVariant))
      await this.client.switchModel(s.id, model);
    if (agent && s.agent !== agent) await this.client.switchAgent(s.id, agent);
    return s.id;
  }

  /** Stops (when running) and deletes a side-question session; kept for later cleanup if that fails. */
  private async dropAsideSession(id: string, running: boolean): Promise<void> {
    if (running) await this.client.interrupt(id).catch(() => false);
    try {
      await this.client.deleteSession(id);
      await this.trackAside(id, false);
      this.log.info(`Deleted side thread ${id}`);
    } catch (e) {
      // A session that is already gone is as good as deleted.
      if (e instanceof OpenCodeHttpError && e.status === 404) await this.trackAside(id, false);
      else this.log.warn(`Deleting side thread ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Closes the side question and deletes its session: it was only ever a scratch copy,
   * and archiving would keep a full copy of the conversation in the Archived list.
   */
  async closeAside(): Promise<void> {
    const a = this.aside;
    if (!a) return;
    this.aside = null;
    this.asideChanged();
    if (a.id) await this.dropAsideSession(a.id, a.status !== "idle");
  }

  /**
   * Sends the latest side answer to the session it was asked from, as a short note: queued
   * while the agent works, so its task is not steered off course. That session may no
   * longer be the open one. Returns false when nothing was sent.
   */
  async asideToMain(): Promise<boolean> {
    const a = this.aside;
    const turn = [...(a?.turns ?? [])].reverse().find((t) => t.done && t.answer.trim());
    if (!a || !turn) return false;
    const answer =
      turn.answer.length > ASIDE_MAX_ANSWER ? `${turn.answer.slice(0, ASIDE_MAX_ANSWER)}…` : turn.answer;
    const text = `For context, I asked a side question.\n\nQuestion: ${turn.question}\n\nAnswer:\n${answer.trim()}`;
    let sent: boolean;
    if (!a.main || a.main === this.current?.id)
      sent = await this.send(text, [], this.busy ? "queue" : undefined);
    else {
      const main = a.main;
      try {
        await this.client.prompt(main, {
          text,
          files: [],
          ...(this.running.has(main) ? { delivery: "queue" as const } : {}),
        });
        this.log.info(`Side answer sent to ${main} (${text.length} chars)`);
        sent = true;
      } catch (e) {
        this.log.error("Sending the side answer failed", e);
        a.error =
          e instanceof OpenCodeHttpError && e.status === 404
            ? "The session this side question was asked from was deleted."
            : friendlyError(e, "Could not send the answer");
        sent = false;
      }
    }
    if (sent) {
      turn.sent = true;
      a.error = null;
    }
    this.asideChanged();
    return sent;
  }

  /** Deletes side-question sessions left by an earlier run (VS Code closed with one open). */
  async cleanupAsides(): Promise<void> {
    const open = this.aside?.id;
    for (const id of this.store.get<string[]>(ASIDES_KEY) ?? [])
      if (id !== open) await this.dropAsideSession(id, true);
  }

  /** Events of the side question's session (and its subagents) go to the aside card only. */
  private applyAside(sessionID: string, events: readonly UiEvent[]): void {
    const a = this.aside;
    const turn = a?.turns[a.turns.length - 1];
    let changed = false;
    for (const ev of events) {
      // Nothing may wait on an answer nobody sees: the side thread gets no tools that ask.
      if (ev.type === "permission.requested") {
        void this.client
          .replyPermission(ev.request.sessionID, ev.request.id, "reject", ASIDE_REJECT)
          .catch(() => undefined);
        continue;
      }
      if (ev.type === "form.requested") {
        void this.client.cancelForm(ev.form.sessionID, ev.form.id).catch(() => undefined);
        continue;
      }
      if (!a || !turn || sessionID !== a.id) continue;
      switch (ev.type) {
        case "assistant.delta":
          a.parts.set(ev.partId, (a.parts.get(ev.partId) ?? "") + ev.delta);
          break;
        case "assistant.completed":
          a.parts.set(ev.partId, ev.text);
          break;
        case "tool.started":
          a.activity = `Using ${ev.name}…`;
          changed = true;
          continue;
        case "session.busy":
          a.status = "running";
          changed = true;
          continue;
        case "session.error": {
          const model = this.models?.find((m) => m.key === ev.modelKey);
          const raw = ev.error ?? { type: "unknown", message: ev.message, status: null, body: null };
          const f = classifyError(raw, {
            modelName: model?.name ?? null,
            providerName: model?.providerName ?? null,
          });
          turn.error = f.detail && f.detail !== f.title ? `${f.title} ${f.detail}` : f.title;
          changed = true;
          continue;
        }
        case "session.idle":
          a.status = "idle";
          a.activity = null;
          turn.done = true;
          if (ev.outcome === "failed" && !turn.error && !turn.answer)
            turn.error = "The side question failed.";
          changed = true;
          continue;
        default:
          continue;
      }
      turn.answer = [...a.parts.values()].filter((t) => t.trim()).join("\n\n");
      a.activity = null;
      changed = true;
    }
    if (changed) this.asideChanged();
  }

  /** Files and folders of the open folder matching `query`, ranked by OpenCode. */
  async findFiles(query: string, limit: number): Promise<FoundFile[]> {
    if (!this.directory || !query) return [];
    return this.client.findFiles(this.directory, query, limit).catch((e: unknown) => {
      this.log.warn(`File search failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
  }

  /** A rewind staged in another client and not yet committed, for the open session. */
  // ------------------------------------------------------------------- goal

  /**
   * Reads the session's goal from OpenCode's goal plugin. Its RPC is briefly unavailable
   * while a folder loads, so it is tried again once; if it still cannot be reached, the
   * objective and rounds come from the goal's notices in the history (without a status).
   */
  private async loadGoal(id: string): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const token = ++this.goalToken;
    let state: GoalState | null | undefined;
    for (let i = 0; i < 2 && state === undefined; i++) {
      try {
        state = await this.client.getGoal(dir, id);
      } catch (e) {
        if (i === 0) await delay(this.timing.goalRetryMs ?? 1000);
        else this.log.warn(`Reading the goal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (token !== this.goalToken || this.current?.id !== id) return;
    this.goal = state ? { state, live: true } : state === null ? null : this.goalFromHistory();
    this.sink.onStateChanged();
  }

  /** The last goal set in the history, and the rounds noted since. */
  private goalFromHistory(): { state: GoalState; live: boolean } | null {
    const notes = this.transcript.items.filter(
      (i): i is Extract<TranscriptItem, { kind: "background" }> =>
        i.kind === "background" && i.source === "goal",
    );
    let set = notes.length - 1;
    while (set >= 0 && notes[set].state !== "set") set--;
    if (set < 0) return null;
    const objective = notes[set].text.split("\n")[0].trim();
    if (!objective) return null;
    return {
      state: {
        id: "",
        objective,
        status: "active",
        reason: null,
        rounds: notes.length - set - 1,
        maxRounds: null,
      },
      live: false,
    };
  }

  /** The goal header's view; null when the open session has no goal. */
  goalView(): GoalView | null {
    const g = this.goal;
    if (!g || !this.current) return null;
    return {
      objective: g.state.objective,
      status: g.live ? g.state.status : null,
      reason: g.state.reason,
      rounds: g.state.rounds,
      maxRounds: g.state.maxRounds,
    };
  }

  /** Pauses, resumes or ends (`clear`) the goal with OpenCode's own `/goal` command. */
  async goalCommand(action: "pause" | "resume" | "clear"): Promise<void> {
    const id = this.current?.id;
    if (!id) return;
    await this.runCommand("goal", action);
    // OpenCode sends the change as an event; read it back too, in case the stream missed it.
    void this.loadGoal(id);
  }

  stagedRevert(): { messageID: string; files: number } | null {
    return this.current?.revert ?? null;
  }

  /**
   * Resolves a rewind staged in another client: `apply` commits it (the hidden messages
   * are removed), `restore` clears it (they come back, and OpenCode may carry on with
   * anything still queued for the session).
   */
  async resolveRevert(action: "apply" | "restore"): Promise<void> {
    if (!this.current?.revert) return;
    const id = this.current.id;
    this.rewinding = true;
    try {
      await this.client.resolveRevert(id, action === "apply" ? "commit" : "clear");
      this.log.info(`${action === "apply" ? "Applied" : "Restored"} the staged rewind of ${id}`);
    } catch (e) {
      this.log.error("Resolving the rewind failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not change the rewind") }]);
      this.rewinding = false;
      return;
    }
    try {
      await this.openSession(id);
    } finally {
      this.rewinding = false;
    }
  }

  /**
   * Rewinds the open session to just before one of its prompts (OpenCode revert),
   * optionally restoring the files changed since, then reloads the conversation.
   * Returns the prompt's text so it can go back into the message box, or null.
   */
  async rewind(messageID: string, files: boolean): Promise<string | null> {
    const item = this.transcript.get(`user:${messageID}`);
    if (!this.current || this.busy || item?.kind !== "user") return null;
    const id = this.current.id;
    this.rewinding = true;
    try {
      await this.client.revert(id, messageID, files);
      this.log.info(`Rewound ${id} to before ${messageID}${files ? " (files restored)" : ""}`);
    } catch (e) {
      this.log.error("Rewind failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not rewind the session") }]);
      this.rewinding = false;
      return null;
    }
    try {
      await this.openSession(id);
    } finally {
      this.rewinding = false;
    }
    return item.text;
  }

  async respondPermission(requestId: string, decision: PermissionDecision, message?: string): Promise<void> {
    const item = this.transcript.get(`perm:${requestId}`);
    if (!this.current || item?.kind !== "permission" || item.status !== "pending") return;
    if (decision === "always" && !item.request.canAlways) return;
    this.emit([{ type: "permission.sending", requestId }]);
    try {
      // Reply to the session that asked: a subagent's request belongs to its own session.
      const feedback = decision === "reject" ? message?.trim() || undefined : undefined;
      await this.client.replyPermission(item.request.sessionID, requestId, decision, feedback);
      this.log.info(
        `Permission ${requestId} (${item.request.action}) answered: ${decision}${feedback ? " with instructions" : ""}`,
      );
      this.emit([{ type: "permission.resolved", requestId, decision, ...(feedback ? { feedback } : {}) }]);
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.status === 404) {
        this.emit([
          { type: "permission.resolved", requestId, decision: "expired" },
          { type: "notice", level: "info", text: "Permission request expired." },
        ]);
      } else {
        this.log.error("Permission reply failed", e);
        // Re-open the card so the user can try again.
        this.emit([
          { type: "permission.requested", request: item.request, sensitive: item.sensitive },
          {
            type: "notice",
            level: "error",
            text: friendlyError(e, "Could not answer the permission request"),
          },
        ]);
      }
    }
  }

  // -------------------------------------------------------------- approval
  //
  // Approval modes are sets of session rules (see src/shared/approval.ts). OpenCode keeps
  // them on the session; Sidecar reads them back after every change and follows
  // `session.permissions`, so the badge shows what OpenCode will actually do. The folder
  // scope is Sidecar's: the mode new sessions in the folder start in. OpenCode's config
  // files are never written.

  /** The mode new sessions in this folder start in, when one was picked for the folder. */
  folderMode(): ApprovalMode | null {
    const m = this.store.get<string>(this.key("approval"));
    return APPROVAL_MODES.find((x) => x === m) ?? null;
  }

  private rulesOf(agent: string | null | undefined): PermissionRule[] | null {
    return agent && this.agentRules ? (this.agentRules[agent] ?? null) : null;
  }

  /** The open session's rules split into its mode and the user's own rules. */
  private classified() {
    const rules = this.current?.permissions ?? [];
    const agent = this.selectedAgent ?? this.current?.agent ?? null;
    const prefer = (this.current && this.modeHints.get(this.current.id)) || this.folderMode();
    return classifyRules(rules, [this.rulesOf(agent), ...Object.values(this.agentRules ?? {})], prefer);
  }

  approvalView(): Omit<ApprovalView, "confirmAuto"> {
    const actions = new Set<string>(KNOWN_ACTIONS);
    for (const rules of Object.values(this.agentRules ?? {}))
      for (const r of rules) if (!/[*?]/.test(r.action)) actions.add(r.action);
    for (const a of this.savedActions) actions.add(a);
    const common = { folderMode: this.folderMode(), actions: [...actions].sort(), busy: this.approvalBusy };
    if (!this.current) {
      const mode = this.nextMode ?? this.folderMode() ?? "default";
      const modeRules = mode === "default" ? [] : presetRules(mode, this.rulesOf(this.selectedAgent));
      return { ...common, mode, modeRules, rules: [], session: false };
    }
    const c = this.classified();
    return { ...common, mode: c.mode, modeRules: c.modeRules, rules: c.custom, session: true };
  }

  /**
   * Switches the approval mode: the session's rules become the mode's (fitted to its
   * agent) followed by the user's own. "folder" also makes it the folder's mode for new
   * sessions. Without a session, the next one starts in it.
   */
  async setApprovalMode(mode: ApprovalMode | "default", scope: "session" | "folder"): Promise<void> {
    if (!this.directory) return;
    if (scope === "folder")
      await this.store.update(this.key("approval"), mode === "default" ? undefined : mode);
    if (!this.current) {
      this.nextMode = scope === "folder" ? null : mode;
      this.sink.onStateChanged();
      return;
    }
    const custom = this.classified().custom;
    const agent = this.selectedAgent ?? this.current.agent;
    const rules = mode === "default" ? custom : [...presetRules(mode, this.rulesOf(agent)), ...custom];
    if (mode === "default") this.modeHints.delete(this.current.id);
    else this.modeHints.set(this.current.id, mode);
    await this.writeRules(this.current.id, rules, `approval mode ${mode}`);
  }

  /** Replaces the open session's own rules (those after its mode's). */
  async setSessionRules(rules: PermissionRule[]): Promise<void> {
    if (!this.current) return;
    await this.writeRules(this.current.id, [...this.classified().modeRules, ...rules], "session rules");
  }

  /** After an agent switch, fits the session's mode to the new agent (Plan keeps not editing). */
  private async refitMode(): Promise<void> {
    if (!this.current || !this.agentRules) return;
    const c = this.classified();
    if (c.mode === "default" || c.mode === "custom") return;
    const next = [...presetRules(c.mode, this.rulesOf(this.selectedAgent)), ...c.custom];
    if (!sameRules(next, this.current.permissions ?? []))
      await this.writeRules(this.current.id, next, `approval mode ${c.mode} for ${this.selectedAgent}`);
  }

  /** Sends a session's rules and reads back what OpenCode stored. */
  private async writeRules(sessionID: string, rules: PermissionRule[], what: string): Promise<boolean> {
    this.approvalBusy = true;
    this.sink.onStateChanged();
    try {
      await this.client.setSessionPermissions(sessionID, rules);
      const stored = (await this.client.getSession(sessionID)).permissions ?? [];
      if (this.current?.id === sessionID) this.current = { ...this.current, permissions: stored };
      if (!sameRules(stored, rules)) this.log.warn(`OpenCode stored other rules than were sent (${what})`);
      this.log.info(`Set ${what} on session ${sessionID} (${stored.length} rules)`);
      return true;
    } catch (e) {
      this.log.error(`Setting ${what} failed`, e);
      this.emit([
        { type: "notice", level: "error", text: friendlyError(e, "Could not change the permission rules") },
      ]);
      return false;
    } finally {
      this.approvalBusy = false;
      this.sink.onStateChanged();
    }
  }

  /**
   * "Always allow commands like this": allows the request once and adds allow rules for
   * `patterns`. "session": on the asking session (and the open one, whose next subagents
   * inherit them). "folder": OpenCode's "always" reply saves its own patterns for the
   * folder, which are then changed to `patterns`.
   */
  async allowLike(requestId: string, patterns: string[], scope: "session" | "folder"): Promise<void> {
    const item = this.transcript.get(`perm:${requestId}`);
    if (!this.current || item?.kind !== "permission" || item.status !== "pending") return;
    const r = item.request;
    const wanted = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
    if (!wanted.length) return;
    if (scope === "folder") return this.allowLikeInFolder(requestId, r, wanted);
    const add = wanted.map((resource): PermissionRule => ({ action: r.action, resource, effect: "allow" }));
    for (const id of new Set([r.sessionID, this.current.id])) {
      const base =
        id === this.current.id
          ? (this.current.permissions ?? [])
          : await this.client
              .getSession(id)
              .then((s) => s.permissions ?? [])
              .catch(() => null);
      if (base === null) continue;
      const next = [...base, ...add.filter((a) => !base.some((b) => sameRule(a, b)))];
      if (!(await this.writeRules(id, next, `allow rules for ${r.action}`))) return;
    }
    await this.respondPermission(requestId, "once");
  }

  private async allowLikeInFolder(
    requestId: string,
    r: Extract<TranscriptItem, { kind: "permission" }>["request"],
    wanted: string[],
  ): Promise<void> {
    if (!r.canAlways || !this.directory) return;
    let project: string | null;
    let before = new Set<string>();
    try {
      project = await this.client.projectId(this.directory);
      if (project) before = new Set((await this.client.listSavedPermissions(project)).map((x) => x.id));
    } catch (e) {
      this.log.error("Listing saved permissions failed", e);
      project = null;
    }
    await this.respondPermission(requestId, "always");
    const done = this.transcript.get(`perm:${requestId}`);
    if (!project || done?.kind !== "permission" || done.status !== "always") return;
    try {
      const added = (await this.client.listSavedPermissions(project)).filter(
        (x) => !before.has(x.id) && x.action === r.action,
      );
      // OpenCode saves one rule per save pattern; each takes the pattern typed for it, in order.
      const order = r.patterns ?? [];
      added.sort((a, b) => order.indexOf(a.resource) - order.indexOf(b.resource));
      for (let i = 0; i < added.length && i < wanted.length; i++) {
        if (added[i].resource === wanted[i]) continue;
        try {
          await this.client.updateSavedPermission(added[i].id, { resource: wanted[i] });
        } catch (e) {
          // The folder already allows that pattern: the narrower copy is not needed.
          if (e instanceof OpenCodeHttpError && e.status === 409)
            await this.client.removeSavedPermission(added[i].id);
          else throw e;
        }
      }
      this.log.info(`Saved ${Math.min(added.length, wanted.length)} folder rule(s) for ${r.action}`);
    } catch (e) {
      this.log.error("Changing the saved rule failed", e);
      this.emit([
        {
          type: "notice",
          level: "error",
          text: friendlyError(e, "Allowed always, but could not change the saved pattern"),
        },
      ]);
    }
  }

  // ------------------------------------------------------------------ forms

  /** Validates and submits an answer to an OpenCode form/question. Returns an error message on failure. */
  async answerForm(formId: string, answer: FormAnswer): Promise<string | null> {
    const item = this.transcript.get(`form:${formId}`);
    if (!this.current || item?.kind !== "form" || item.status !== "pending")
      return "This question is no longer pending.";
    const checked = validateAnswer(item.form, answer);
    if (!checked.ok) return checked.error;
    this.emit([{ type: "form.sending", formId }]);
    try {
      await this.client.replyForm(item.form.sessionID, formId, checked.answer);
      this.log.info(`Form ${formId} answered (${Object.keys(checked.answer).length} field(s))`);
      this.emit([{ type: "form.resolved", formId, status: "answered", answer: checked.answer }]);
      return null;
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.status === 404) {
        this.emit([
          { type: "form.resolved", formId, status: "expired", answer: null },
          { type: "notice", level: "info", text: "This question expired before it was answered." },
        ]);
        return null;
      }
      this.log.error("Form reply failed", e);
      this.emit([{ type: "form.resolved", formId, status: "pending", answer: null }]);
      return friendlyError(e, "Could not send the answer");
    }
  }

  async cancelForm(formId: string): Promise<void> {
    const item = this.transcript.get(`form:${formId}`);
    if (!this.current || item?.kind !== "form" || item.status !== "pending") return;
    this.emit([{ type: "form.sending", formId }]);
    try {
      await this.client.cancelForm(item.form.sessionID, formId);
      this.emit([{ type: "form.resolved", formId, status: "cancelled", answer: null }]);
    } catch (e) {
      const expired = e instanceof OpenCodeHttpError && e.status === 404;
      if (!expired) this.log.error("Form cancel failed", e);
      this.emit([{ type: "form.resolved", formId, status: expired ? "expired" : "pending", answer: null }]);
    }
  }

  // ----------------------------------------------------------------- budget

  /** "Continue once": one explicit override for the current task; the workspace budget is unchanged. */
  async budgetContinueOnce(budgetItemId: string): Promise<boolean> {
    if (this.busy || !this.current) return false;
    this.budget.continueOnce();
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "continued" }]);
    this.log.info("Budget: continue once (one-time override)");
    return this.dispatch({ text: CONTINUE_TEXT, files: [] });
  }

  /** Raises the workspace budget one level and continues the task. */
  async budgetIncrease(budgetItemId: string): Promise<boolean> {
    if (this.busy || !this.current) return false;
    const level = nextLevel(this.budget.level);
    if (level === this.budget.level) {
      // Already at the largest preset: behaves like one override.
      return this.budgetContinueOnce(budgetItemId);
    }
    this.budget.increaseTo(level);
    if (this.directory) await this.store.update(this.key("budget"), level);
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "increased" }]);
    this.log.info(`Budget increased to ${level}`);
    return this.dispatch({ text: CONTINUE_TEXT, files: [] });
  }

  async budgetNewSession(budgetItemId: string): Promise<void> {
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "new-session" }]);
    await this.newSession();
  }

  private checkBudget(signal: ReturnType<BudgetTracker["evaluate"]>): void {
    if (signal.kind === "warning") {
      this.deferred.push({
        type: "budget",
        id: `budget:${++this.budgetSeq}`,
        state: "warning",
        text: this.strings().budgetWarning,
      });
    } else if (signal.kind === "exceeded") {
      const v = this.budget.view();
      const id = `budget:${++this.budgetSeq}`;
      this.taskStopReason = "budget";
      this.notify("budget-stopped", `budget:${this.current?.id}:${this.budgetSeq}`);
      // Interrupting an edit could leave a file half written: let the edits running now
      // finish, then stop before the agent's next step.
      const edits = this.busy && !this.stopping ? this.runningEdits() : [];
      const why = signal.projected ? ", the next step would cross it" : "";
      const then = edits.length ? `stopping after ${edits.length} edit(s)` : "interrupting";
      this.log.warn(
        `Budget ${v.level} reached (${signal.metric}${why}): cost=${v.taskCost ?? "n/a"} steps=${v.taskSteps}; ${then}`,
      );
      if (edits.length) {
        const file = edits.length === 1 ? edits[0].file : `${edits.length} files`;
        this.clearDrain();
        this.budgetDrain = {
          id,
          tools: new Set(edits.map((e) => e.id)),
          file,
          // An edit that never reports back must not keep the agent going.
          timer: setTimeout(() => this.finishDrain(), this.timing.budgetDrainMs ?? 30_000),
        };
        this.deferred.push({
          type: "budget",
          id,
          state: "warning",
          text: this.strings().budgetStopping(file),
        });
        return;
      }
      this.deferred.push({ type: "budget", id, state: "stopped", text: this.strings().budgetStopped });
      if (this.busy && !this.stopping) void this.stop();
    }
  }

  /** Edit calls of the open session that are writing now, with the file each one writes. */
  private runningEdits(): Array<{ id: string; file: string }> {
    const out: Array<{ id: string; file: string }> = [];
    for (const i of this.transcript.items) {
      if (i.kind !== "tool" || i.category !== "edit" || i.status !== "running") continue;
      out.push({ id: i.id.slice("tool:".length), file: this.displayPath(i.detail.path) ?? i.title });
    }
    return out;
  }

  /** A path as the user knows it: relative to the open folder when it is inside it. */
  private displayPath(path: string | undefined): string | null {
    if (!path) return null;
    const dir = this.directory?.replace(/[\\/]+$/, "");
    if (dir && sameDirectory(path.slice(0, dir.length), dir) && /^[\\/]/.test(path.slice(dir.length)))
      return path.slice(dir.length + 1).replace(/\\/g, "/");
    return path.replace(/\\/g, "/");
  }

  /** The held-back budget stop: the edits are done (or took too long), stop the agent now. */
  private finishDrain(): void {
    const d = this.budgetDrain;
    if (!d) return;
    this.clearDrain();
    this.emit([
      { type: "budget", id: d.id, state: "stopped", text: this.strings().budgetStoppedAfter(d.file) },
    ]);
    if (this.busy && !this.stopping) void this.stop();
  }

  private clearDrain(): void {
    if (this.budgetDrain) clearTimeout(this.budgetDrain.timer);
    this.budgetDrain = null;
  }

  // ----------------------------------------------------------------- events

  /** Notes a session starting or finishing work; true when a listed session changed. */
  private trackRunning(sessionID: string, events: UiEvent[]): boolean {
    let changed = false;
    for (const ev of events) {
      if (ev.type === "session.busy" && !this.running.has(sessionID)) {
        this.running.add(sessionID);
        changed = true;
      } else if (ev.type === "session.idle" && this.running.delete(sessionID)) changed = true;
    }
    return changed && this.sessions.some((s) => s.id === sessionID);
  }

  /** Entry point for every raw event from the OpenCode event stream. */
  handleRawEvent(raw: unknown): void {
    if (this.disposed) return;
    if (isCatalogEvent(raw)) this.scheduleCatalogRefresh();
    if (isMcpEvent(raw, this.directory)) this.sink.onMcpChanged?.();
    const env = this.normalizer.normalize(raw);
    if (!env) return;
    if (env.sessionsChanged && (env.directory === null || sameDirectory(env.directory, this.directory)))
      this.scheduleSessionsRefresh();
    if (env.sessionID && this.trackRunning(env.sessionID, env.events)) this.sink.onStateChanged();
    // A side question's session and its subagents never reach the main conversation.
    if (env.sessionID && env.parentID && this.asideIds.has(env.parentID)) this.asideIds.add(env.sessionID);
    if (env.sessionID && this.asideIds.has(env.sessionID)) {
      this.applyAside(env.sessionID, env.events);
      return;
    }
    if (env.sessionID) this.watchEvents(raw, env);
    if (!this.current || !env.sessionID) return;
    const root = this.current.id;
    if (env.parentID && this.subagents.created(env.sessionID, env.parentID, root, env.created))
      this.sink.onStateChanged();
    if (env.events.length === 0) return;
    // When the session or one of its subagents stops, a request may have closed without a reply event.
    if (env.events.some((ev) => ev.type === "session.idle")) void this.closeStaleRequests(root);
    if (env.sessionID === root) {
      this.emit(env.events);
      return;
    }
    if (!this.subagents.has(env.sessionID)) return;
    const wasActive = this.subagentsActive();
    if (this.subagents.apply(env.sessionID, env.events)) this.sink.onStateChanged();
    // A subagent's own output and lifecycle stay in its session; only the requests that
    // block the open session's run are shown here.
    const requests = env.events.filter(isInputRequest);
    if (requests.length > 0) this.emit(requests);
    if (this.viewer?.id === env.sessionID && !this.viewer.loading) {
      const now = Date.now();
      const stamped = env.events.map((ev) => stampTime(ev, now));
      for (const ev of stamped) this.viewer.transcript.apply(ev);
      this.sink.onSubagentEvents?.(env.sessionID, stamped);
    }
    // The open session can finish its turn while subagents work; report completion once they are done.
    if (wasActive && !this.subagentsActive() && !this.busy && this.task?.status === "completed")
      this.notify("completed", `completed:${this.task.id}:${this.execSeq}`);
  }

  /**
   * Marks as expired the waiting requests OpenCode no longer has open, so the dock and
   * the badge never wait on something nobody can answer (e.g. a subagent's request
   * dropped when the subagent ended, which sends no reply event).
   */
  private async closeStaleRequests(root: string): Promise<void> {
    const waiting = this.transcript.items.filter(
      (i): i is Extract<TranscriptItem, { kind: "permission" | "form" }> =>
        (i.kind === "permission" || i.kind === "form") && i.status === "pending",
    );
    if (!waiting.length) return;
    const sessionOf = (i: (typeof waiting)[number]) =>
      i.kind === "permission" ? i.request.sessionID : i.form.sessionID;
    const open = new Set<string>();
    for (const sessionID of new Set(waiting.map(sessionOf))) {
      try {
        const [permissions, forms] = await Promise.all([
          this.client.listPermissions(sessionID),
          this.client.listForms(sessionID),
        ]);
        for (const p of permissions) open.add(p.id);
        for (const f of forms) open.add(f.id);
      } catch {
        // Unknown: keep that session's requests rather than closing a live one.
        for (const i of waiting)
          if (sessionOf(i) === sessionID) open.add(i.kind === "permission" ? i.request.id : i.form.id);
      }
    }
    if (this.disposed || this.current?.id !== root) return;
    const stale: UiEvent[] = [];
    for (const i of waiting) {
      const now = this.transcript.get(i.id);
      if (now?.kind !== i.kind || now.status !== "pending") continue; // answered meanwhile
      if (i.kind === "permission" && !open.has(i.request.id))
        stale.push({ type: "permission.resolved", requestId: i.request.id, decision: "expired" });
      if (i.kind === "form" && !open.has(i.form.id))
        stale.push({ type: "form.resolved", formId: i.form.id, status: "expired", answer: null });
    }
    if (stale.length) {
      this.log.info(`Closed ${stale.length} request(s) OpenCode no longer has open`);
      this.emit(stale);
      this.sink.onStateChanged();
    }
  }

  /** Called when the event stream reconnects; resynchronizes the open session. */
  async resync(): Promise<void> {
    // What background sessions wait on is read again: nothing that changed meanwhile is notified.
    this.scanned.clear();
    if (this.current) await this.openSession(this.current.id);
    else await this.refreshSessions();
  }

  /** Inbox bookkeeping; returns the events to forward to the transcript. */
  private applyInbox(ev: Extract<UiEvent, { type: `inbox.${string}` }>): UiEvent[] {
    switch (ev.type) {
      case "inbox.enqueued":
        if (this.transcript.has(`user:${ev.id}`)) return [];
        if (this.deliveredEarly.delete(ev.id)) {
          this.trackUserMessage(
            ev.id,
            ev.raw ?? ev.text,
            ev.delivery === "queue" || !this.task || !this.execActive,
          );
          return [
            { type: "user.message", id: ev.id, text: ev.text, attachments: ev.attachments, raw: ev.raw },
          ];
        }
        if (!this.pending.some((p) => p.id === ev.id)) {
          // Queued items and prompts sent while idle start a task; steering joins the running one.
          this.pendingStartsTask.set(ev.id, ev.delivery === "queue" || !this.execActive);
          this.pending = [
            ...this.pending,
            { id: ev.id, text: ev.text, raw: ev.raw, attachments: ev.attachments, delivery: ev.delivery },
          ];
        }
        return [];
      case "inbox.delivered": {
        const item = this.pending.find((p) => p.id === ev.id);
        this.pending = this.pending.filter((p) => p.id !== ev.id);
        if (!item) {
          this.deliveredEarly.add(ev.id);
          return [];
        }
        const starts = this.pendingStartsTask.get(item.id) ?? (item.delivery === "queue" || !this.task);
        this.pendingStartsTask.delete(item.id);
        this.trackUserMessage(item.id, item.raw ?? item.text, starts);
        return [
          {
            type: "user.message",
            id: item.id,
            text: item.text,
            attachments: item.attachments,
            raw: item.raw,
          },
        ];
      }
      case "inbox.cancelled":
        this.pending = this.pending.filter((p) => p.id !== ev.id);
        this.pendingStartsTask.delete(ev.id);
        return [];
      case "inbox.delivery":
        this.pending = this.pending.map((p) => (p.id === ev.id ? { ...p, delivery: ev.delivery } : p));
        if (this.pendingStartsTask.has(ev.id))
          this.pendingStartsTask.set(ev.id, ev.delivery === "queue" || !this.execActive);
        return [];
    }
  }

  private applyLocal(ev: UiEvent, replay = false): UiEvent[] {
    const out: UiEvent[] = [ev];
    switch (ev.type) {
      case "session.busy":
        this.busy = true;
        this.execActive = true;
        this.execSeq++;
        this.budget.startTask(this.sessionCost ?? 0);
        break;
      case "session.idle":
        this.busy = false;
        this.stopping = false;
        this.execActive = false;
        this.budget.endTask();
        clearTimeout(this.stopTimer);
        if (this.budgetDrain) {
          // The agent ended by itself while its last edits finished: the card says it stopped.
          const d = this.budgetDrain;
          this.clearDrain();
          this.deferred.push({
            type: "budget",
            id: d.id,
            state: "stopped",
            text: this.strings().budgetStoppedAfter(d.file),
          });
        }
        if (!replay) {
          this.finishTask(ev.outcome);
          void this.refreshQuota();
        }
        break;
      case "tool.completed":
      case "tool.failed":
        // The last edit a held-back budget stop waits for is done: stop before the next step.
        if (this.budgetDrain?.tools.delete(ev.toolId) && this.budgetDrain.tools.size === 0)
          queueMicrotask(() => this.finishDrain());
        break;
      case "permission.requested":
        if (!replay)
          this.notify(
            "needs-input",
            `input:${ev.request.id}`,
            permissionDetail(ev.request.action, ev.request.resources),
          );
        break;
      case "form.requested":
        if (!replay) {
          // The first question the form asks says more than its title ("Questions").
          const first = ev.form.fields.find((f) => f.title)?.title;
          this.notify("needs-input", `input:${ev.form.id}`, oneLine(`a question: ${first ?? ev.form.title}`));
        }
        break;
      case "session.renamed":
        if (this.current) this.current = { ...this.current, title: ev.title };
        break;
      case "session.reverted":
        // Another client rewound the session; Sidecar's own rewind reloads by itself.
        if (!replay && !this.rewinding && this.current) {
          const id = this.current.id;
          clearTimeout(this.revertTimer);
          this.revertTimer = setTimeout(() => {
            if (this.current?.id === id && !this.rewinding) void this.openSession(id);
          }, 300);
        }
        break;
      case "session.selection":
        // Follow an agent or model chosen in another client (the TUI, another window).
        if (this.current && this.staleEcho(this.current.id, ev)) break;
        if (ev.agent && this.agents?.some((a) => a.id === ev.agent)) {
          const changed = this.selectedAgent !== ev.agent;
          this.selectedAgent = ev.agent;
          if (changed && !replay) void this.refitMode();
        }
        if (ev.modelKey && this.models?.some((m) => m.key === ev.modelKey)) {
          this.selectedModel = ev.modelKey;
          const variants = this.models.find((m) => m.key === ev.modelKey)?.variants ?? [];
          this.selectedVariant = ev.variant && variants.includes(ev.variant) ? ev.variant : null;
        }
        break;
      case "session.permissions":
        // Rules set by Sidecar, the TUI or another client: the badge follows them.
        if (this.current) this.current = { ...this.current, permissions: ev.rules };
        break;
      case "goal.changed":
        // Set, advanced, stopped, achieved or cleared, in Sidecar or another client.
        this.goalToken++;
        this.goal = ev.goal ? { state: ev.goal, live: true } : null;
        break;
      case "user.message":
        if (this.firstUserText === null) this.firstUserText = ev.text;
        break;
      case "usage.step":
        this.lastStep = {
          tokens: ev.tokens,
          modelKey: ev.modelKey,
          at: ev.time ?? (replay ? null : Date.now()),
        };
        this.steps++;
        this.ledger.add(ev);
        if (!replay) {
          this.checkBudget(this.budget.recordStep());
          this.checkContext();
        }
        break;
      case "usage.session":
        this.sessionCost = ev.cost;
        if (!replay) this.checkBudget(this.budget.recordCost(ev.cost));
        break;
      case "session.error": {
        // A run that fails before its first step (no such model) names no model: it was
        // the session's.
        const modelKey = ev.modelKey ?? this.current?.modelKey ?? null;
        const model = this.models?.find((m) => m.key === modelKey);
        const providerID = model?.providerID ?? modelKey?.split("/")[0] ?? null;
        const providerName =
          model?.providerName ?? this.providers?.find((p) => p.id === providerID)?.name ?? providerID;
        const raw = ev.error ?? { type: "unknown", message: ev.message, status: null, body: null };
        const friendly = classifyError(raw, { modelName: model?.name ?? null, providerName });
        if (!replay) {
          this.log.error(`OpenCode run failed: ${describeForLog(raw, { providerID, modelKey })}`);
        }
        const provider =
          providerID && providerName
            ? { id: integrationOf(providerID, this.providers), name: providerName }
            : null;
        if (provider && !replay && PROVIDER_KINDS.has(friendly.kind))
          this.providerErrors.set(provider.id, `${friendly.title} ${friendly.detail}`.trim());
        const actions = friendly.actions.filter(
          (a) => (a !== "retry" || (!replay && this.lastPayload !== null)) && (a !== "reauth" || provider),
        );
        const replaced: UiEvent = {
          type: "error",
          id: `error:${++this.errorSeq}`,
          title: friendly.title,
          detail: friendly.detail,
          actions,
          ...(provider && actions.includes("reauth") ? { provider } : {}),
        };
        out[0] = replaced;
        break;
      }
      case "inbox.enqueued":
      case "inbox.delivered":
      case "inbox.cancelled":
      case "inbox.delivery": {
        const forwarded = this.applyInbox(ev);
        for (const f of forwarded)
          if (f.type === "user.message" && this.firstUserText === null) this.firstUserText = f.text;
        out.splice(0, 1, ...forwarded);
        break;
      }
      case "form.resolved":
        if (ev.status === "answered" && ev.answer) {
          const item = this.transcript.get(`form:${ev.formId}`);
          if (item?.kind === "form")
            this.log.info(`Form answered: ${summarizeAnswer(item.form, ev.answer).length} chars`);
        }
        break;
      default:
        break;
    }
    // Live events carry no time; stamp them here so the host's and the webview's
    // transcripts agree. Replayed history keeps OpenCode's stored times.
    if (!replay) {
      const now = Date.now();
      for (let i = 0; i < out.length; i++) out[i] = stampTime(out[i], now);
    }
    for (const e of out) this.transcript.apply(e);
    return out;
  }

  // ------------------------------------------------------------- current task

  /**
   * Records a delivered user message: a new task, a steer into the running
   * task, or a Budget Guard continuation of the same task.
   */
  private trackUserMessage(id: string, raw: string, startsTask: boolean): void {
    if (raw === CONTINUE_TEXT && this.task) {
      this.task = { ...this.task, status: "running" };
      this.taskStopReason = null;
      return;
    }
    if (startsTask || !this.task) {
      this.task = { id, raw, status: "running", steer: null };
      this.taskStopReason = null;
    } else {
      this.task = { ...this.task, steer: raw };
    }
  }

  private finishTask(outcome: "succeeded" | "failed" | "interrupted"): void {
    if (!this.task) return;
    const status: TaskStatus =
      outcome === "succeeded"
        ? "completed"
        : outcome === "failed"
          ? "failed"
          : this.taskStopReason === "budget"
            ? "budget-stopped"
            : "stopped";
    this.task = { ...this.task, status };
    // While subagents still work the task is not done; they report back and wake the session.
    if (outcome === "succeeded" && !this.subagentsActive())
      this.notify("completed", `completed:${this.task.id}:${this.execSeq}`);
    else if (outcome === "failed") this.notify("failed", `failed:${this.task.id}:${this.execSeq}`);
    // A user Stop or a budget stop is never reported as completed.
  }

  private notify(kind: TaskNotice["kind"], key: string, detail?: string): void {
    if (this.notified.has(key) || !this.sink.onTaskNotice) return;
    this.notified.add(key);
    this.sink.onTaskNotice({
      kind,
      key,
      summary: this.task ? summarizeTask(this.task.raw) : "",
      sessionTitle: this.currentTitle(),
      ...(detail ? { detail } : {}),
    });
  }

  /** Permission requests and questions waiting for an answer (the main session and its subagents). */
  pendingRequestCount(): number {
    return this.transcript.items.filter(
      (i) => (i.kind === "permission" || i.kind === "form") && i.status === "pending",
    ).length;
  }

  /** View model for the Current / Last Task bar; null for an empty session. */
  taskView(): TaskView | null {
    const t = this.task;
    if (!t) return null;
    const working = this.busy || this.subagentsActive();
    const waiting =
      working &&
      this.transcript.items.some(
        (i) =>
          (i.kind === "permission" && i.status === "pending") ||
          (i.kind === "form" && i.status === "pending"),
      );
    const queued = this.pending.filter((p) => p.delivery === "queue");
    return {
      id: t.id,
      label: working ? "current" : "last",
      summary: summarizeTask(t.raw) || "(empty prompt)",
      status: waiting ? "waiting" : working ? "running" : t.status,
      steer: t.steer ? summarizeTask(t.steer) : null,
      next: queued.length
        ? { summary: summarizeTask(queued[0].raw ?? queued[0].text), more: queued.length - 1 }
        : null,
      chars: t.raw.length,
      lines: t.raw.split("\n").length,
    };
  }

  private checkContext(): void {
    const pct = this.defaults().contextWarnPercent ?? 80;
    const u = this.usage();
    if (!pct || this.contextWarned || !u?.contextTokens || !u.contextLimit) return;
    const used = Math.round((u.contextTokens / u.contextLimit) * 100);
    if (used >= pct) {
      this.contextWarned = true;
      this.deferred.push({ type: "notice", level: "info", text: this.strings().contextWarning(used) });
    }
  }

  private emit(events: UiEvent[]): void {
    let stateChanged = false;
    let changesDirty = false;
    const forwarded: UiEvent[] = [];
    for (const ev of events) {
      if (/^(session\.|usage\.|inbox\.|budget|goal\.)/.test(ev.type)) stateChanged = true;
      if (ev.type === "files.changed" || ev.type === "session.idle") changesDirty = true;
      forwarded.push(...this.applyLocal(ev));
    }
    if (forwarded.length) this.sink.onEvents(forwarded);
    if (stateChanged) this.sink.onStateChanged();
    if (changesDirty) this.scheduleChangesRefresh();
    this.flushDeferred();
  }

  /** Canonical Markdown of an assistant message (for Copy), or null when not copyable yet. */
  copyText(itemId: string): string | null {
    const item = this.transcript.get(itemId);
    if (item?.kind !== "assistant") return null;
    if (item.streaming && this.busy) return null;
    return item.text;
  }

  // ---------------------------------------------------------------- changes

  private scheduleChangesRefresh(): void {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.refreshChanges(), this.timing.debounceMs);
  }

  /** User message ids of the loaded session, oldest first. */
  private userMessageIds(): string[] {
    return this.transcript.items.filter((i) => i.kind === "user").map((i) => i.id.slice("user:".length));
  }

  /** Files the agent reported editing (edit-tool metadata) in this session. */
  private reportedEdits(): Set<string> {
    const out = new Set<string>();
    for (const i of this.transcript.items) {
      if (i.kind === "tool") for (const f of i.detail.files) out.add(f.path);
      if (i.kind === "turn-summary") for (const f of i.files) out.add(f.path);
    }
    return out;
  }

  /**
   * Loads the agent's changes for the whole session from OpenCode's snapshots
   * (first user turn → last user turn, full-file patches). If the attribution is
   * not reliable, reports "unavailable" instead of guessing.
   */
  async refreshChanges(): Promise<void> {
    const id = this.current?.id;
    if (!id) return;
    const users = this.userMessageIds();
    const range = users.length
      ? { from: users[0], to: users.length > 1 ? users[users.length - 1] : undefined, full: true }
      : { full: true };
    try {
      const diff = await this.client.sessionDiff(id, range);
      if (this.current?.id !== id) return;
      this.patches.clear();
      for (const d of diff) this.patches.set(d.file, { patch: d.patch, status: d.status });
      this.changesVersion++;
      const files = diff.map((d) => ({
        path: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }));
      const reported = this.reportedEdits();
      if (files.length === 0 && reported.size > 0) {
        this.agentChanges = {
          status: "unavailable",
          reason: "OpenCode did not record snapshots for the agent's edits.",
        };
      } else {
        this.agentChanges = files.length ? { status: "ok", files } : { status: "none" };
      }
      this.sink.onStateChanged();
    } catch (e) {
      this.log.warn(`Session diff unavailable: ${e instanceof Error ? e.message : String(e)}`);
      if (this.current?.id !== id) return;
      this.agentChanges = {
        status: "unavailable",
        reason: "OpenCode could not provide the session's snapshot diff.",
      };
      this.sink.onStateChanged();
    }
  }

  /** Before/after contents of one agent-changed file, or null when they cannot be reconstructed reliably. */
  agentFileSides(path: string): FileSides | null {
    const p = this.patches.get(path);
    if (!p) return null;
    return reconstructSides(p.patch, p.status);
  }

  /** OpenCode's patch and status for one agent-changed file. */
  agentPatch(path: string): { patch: string; status: FileChange["status"] } | null {
    return this.patches.get(path) ?? null;
  }

  /**
   * What a rewind with code to before this prompt would revert: the files OpenCode's
   * snapshots recorded from its turn on, and the shell commands run since, which its
   * snapshots may only partly cover.
   */
  async rewindPreview(messageID: string): Promise<RewindPreview | null> {
    const id = this.current?.id;
    const items = this.transcript.items;
    const at = items.findIndex((i) => i.id === `user:${messageID}`);
    if (!id || at < 0) return null;
    const tools = items.slice(at).flatMap((i) =>
      i.kind === "tool"
        ? [
            {
              id: i.id,
              category: i.category,
              files: [...i.detail.files.map((f) => f.path), ...(i.detail.path ? [i.detail.path] : [])],
            },
          ]
        : [],
    );
    const users = this.userMessageIds();
    const last = users[users.length - 1];
    const why = (e: unknown) =>
      this.log.warn(`Rewind preview: ${e instanceof Error ? e.message : String(e)}`);
    // What revert undoes is what the agent's steps changed (their snapshot files); the
    // session diff also has what changed between them, which a rewind leaves alone.
    const [steps, diff] = await Promise.all([
      this.client
        .listMessages(id, MAX_REWIND_MESSAGES)
        .then((m) => stepFiles(m, messageID))
        .catch((e) => (why(e), null)),
      this.client
        .sessionDiff(id, { from: messageID, to: last && last !== messageID ? last : undefined })
        .then((d) => d.map((f) => ({ path: f.file, status: f.status })))
        .catch((e) => (why(e), null)),
    ]);
    return rewindPreview(tools, steps, diff);
  }

  /** The agent's changes in the open session, one patch per file (OpenCode's snapshot diff). */
  agentPatches(): Array<{ path: string; patch: string }> {
    return [...this.patches].map(([path, p]) => ({ path, patch: p.patch }));
  }

  /**
   * Text from the selected model, generated outside any session (OpenCode's stateless
   * generate call), so nothing is added to the conversation or its costs.
   */
  generateText(prompt: string): Promise<string> {
    return this.client.generateText(prompt, this.modelRef());
  }

  /** Back-compat for v0.1 callers: agent-attributed files (empty when unavailable). */
  get changes(): FileChange[] {
    return this.agentChanges.status === "ok" ? this.agentChanges.files : [];
  }
}

/** Permission requests and questions, and their resolution: the events that need the user. */
function isInputRequest(ev: UiEvent): boolean {
  return (
    ev.type === "permission.requested" ||
    ev.type === "permission.resolved" ||
    ev.type === "form.requested" ||
    ev.type === "form.resolved"
  );
}

/** Failures a new sign-in or the provider's setup fixes, remembered for the Providers panel. */
const PROVIDER_KINDS = new Set<FriendlyError["kind"]>(["auth", "model-not-found", "provider-setup"]);

/** Events after which models, providers or connections may have changed (e.g. a sign-in). */
const CATALOG_EVENTS = new Set([
  "agent.updated",
  "integration.updated",
  "provider.updated",
  "model.updated",
  "models-dev.refreshed",
]);

/** `mcp.status.changed` for `directory` (the event carries the server's folder). */
function isMcpEvent(raw: unknown, directory: string | null): boolean {
  const e =
    raw && typeof raw === "object" ? (raw as { type?: unknown; location?: { directory?: unknown } }) : null;
  if (e?.type !== "mcp.status.changed" || !directory) return false;
  const at = e.location?.directory;
  return typeof at !== "string" || sameDirectory(at, directory);
}

/** A session deleted or archived (in Sidecar or another client): it leaves the strip. */
function isRemovalEvent(raw: unknown): boolean {
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : null;
  return type === "session.deleted" || type === "session.archived";
}

export function isCatalogEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" && CATALOG_EVENTS.has(type);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
