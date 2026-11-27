// Sidebar webview provider and host-side controller: owns the OpenCode
// connection, VS Code integrations (editor context, quick pick, diff, links)
// and the bridge to the webview.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { languageFor } from "../shared/languages";
import { pathToFileURL } from "node:url";
import type { BookmarkView, MentionCandidate, PromptMention } from "../shared/model";
import { autoAttachment, autoKey, isAutoId, type EditorSnapshot } from "../core/autoContext";
import { discoverExecutable } from "../core/cliDiscovery";
import { buildCommitPrompt, cleanCommitMessage, splitGitDiff } from "../core/commitMessage";
import {
  chipFor,
  dataUriBytes,
  formatBytes,
  MAX_IMAGE_BYTES,
  validateSelection,
  type ResolvedMention,
} from "../core/context";
import { groupProblems, MAX_PROBLEMS, type FoundProblem } from "../core/problems";
import { classifyPath } from "../core/sensitive";
import { decideNotification, type TaskNotice } from "../core/currentTask";
import { healthMarkdown, healthReport, overall } from "../core/healthCheck";
import { deriveOnboarding, OPENCODE_LINKS, statusBarText } from "../core/onboarding";
import type { ConnectOutcome } from "../core/providerConnect";
import type { IntegrationInfo, IntegrationMethod } from "../core/providers";
import { SessionController } from "../core/sessionController";
import {
  HttpOpenCodeClient,
  OpenCodeHttpError,
  opencodeDirectory,
  type EventSubscription,
} from "../opencode/client";
import {
  cliVersion,
  discoverServer,
  parseRegistration,
  serviceFilePath,
  startService,
} from "../opencode/service";
import type {
  AccountStatus,
  BudgetLevel,
  ConnectionStatus,
  ContextAttachment,
  McpBusy,
  OnboardingView,
  ProvidersView,
  SignInState,
  UiEvent,
} from "../shared/model";
import {
  parseWebviewMessage,
  type AttachmentChip,
  type HostMessage,
  type ViewState,
  type WebviewMessage,
} from "../shared/protocol";
import { CONFIG_SECTION, readConfig, readNotificationSettings } from "./config";
import { openAgentDiffs, openAgentFileDiff, openAllDiffs, openFileDiff, type AgentSideSource } from "./diff";
import { getGitApi, type GitAPI, type GitRepository } from "./gitApi";
import type { Logger } from "./log";
import { addExcerpts, documentProblems, workspaceProblems } from "./problems";
import { AgentsHost } from "./agents";
import { InstructionsHost } from "./instructions";
import { AgentReview } from "./review";
import { vscodeConnectUi } from "./providers";
import type { ToolTextProvider } from "./toolText";
import { WorkspaceTracker } from "./workspace";

export const VIEW_ID = "opencodeSidecar.chat";
/** The one command every entry point uses to open the chat. */
export const FOCUS_COMMAND = "opencodeSidecar.focusChat";
const HINT_KEY = "opencodeSidecar.placementHintDismissed";
/** Bookmarked answers, per workspace (OpenCode has no bookmark store). */
const BOOKMARKS_KEY = "opencodeSidecar.bookmarks";
const MAX_BOOKMARKS = 200;
const SIGN_IN_HINT_KEY = "opencodeSidecar.signInHintDismissed";
/** Set once "Don't ask again" was chosen when switching to Auto. */
const AUTO_CONFIRMED_KEY = "opencodeSidecar.autoModeConfirmed";
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_MAX_MS = 15 * 60_000;

function uiLocale(): "en" | "ar" {
  return vscode.env.language.toLowerCase().startsWith("ar") ? "ar" : "en";
}

const AR_STRINGS = {
  budgetWarning: "اقتربت المهمة من حد الاستهلاك المحدد.",
  budgetStopped: "تم بلوغ حد استهلاك المهمة. تم إيقاف الوكيل.",
  contextWarning: (p: number) => `نافذة السياق ممتلئة بنسبة ${p}٪. يُفضّل بدء جلسة جديدة.`,
};

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, AgentSideSource {
  private view: vscode.WebviewView | undefined;
  private webviewReady = false;
  private connection: ConnectionStatus = { kind: "connecting" };
  private controller: SessionController | undefined;
  private subscription: EventSubscription | undefined;
  private attachments: ContextAttachment[] = [];
  /** The editor context chip the user removed (its file or lines), until the editor moves on. */
  private autoDismissed: string | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  /** Words for the message box, sent when the chat is ready (it may still be loading). */
  private suggestPending: string | null = null;
  private pendingEvents: UiEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live events of the open subagent conversation, batched like `pendingEvents`. */
  private pendingSubagent: { sessionID: string; events: UiEvent[] } | null = null;
  private subagentTimer: ReturnType<typeof setTimeout> | undefined;
  /** The side question card, pushed at most every 30 ms while its answer streams. */
  private asideTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private autoStartTried = false;
  private streamWasOpen = false;
  private readonly workspace: WorkspaceTracker;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly taps = new Set<(events: UiEvent[]) => void>();
  private readonly statusItem: vscode.StatusBarItem;
  private focusPending = false;
  private signInState: SignInState = "idle";
  private signInTerminal: vscode.Terminal | undefined;
  private signInTimer: ReturnType<typeof setInterval> | undefined;
  private signInStarted = 0;
  private signInBaseline: string | null = null;
  /** A provider connect, re-auth or disconnect in progress (one at a time). */
  private providerBusy: ProvidersView["busy"] = null;
  /** What the MCP panel waits for; the panel's list is sent again on OpenCode's MCP events once it opened. */
  private mcpBusy: McpBusy | null = null;
  private mcpWatched = false;
  private mcpTimer: ReturnType<typeof setTimeout> | undefined;
  private providersPending = false;
  /** The Agents panel's files, saves and imports. */
  private readonly agents: AgentsHost;
  private readonly instructions: InstructionsHost;
  /** Open the Agents panel (true: its import preview) once the webview is ready. */
  private agentsPending: boolean | null = null;
  /** Keep / Undo review of the agent's changes in the editor. */
  readonly review: AgentReview;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly toolText?: ToolTextProvider,
  ) {
    this.workspace = new WorkspaceTracker(context.workspaceState);
    this.disposables.push(this.workspace);
    this.instructions = new InstructionsHost({
      controller: () => this.controller,
      folder: () => this.workspace.current.active?.path ?? null,
      post: (m) => this.post(m),
      log,
      toolText,
    });
    this.agents = new AgentsHost({
      controller: () => this.controller,
      folder: () => this.workspace.current.active?.path ?? null,
      post: (m) => this.post(m),
      log,
      storage: context.globalStorageUri.fsPath,
    });
    this.review = new AgentReview(
      context.workspaceState,
      {
        session: () => {
          const c = this.controller;
          return c?.current && c.agentChanges.status === "ok"
            ? { id: c.current.id, files: c.agentChanges.files, version: c.changesVersion }
            : null;
        },
        sides: (file) => this.controller?.agentFileSides(file) ?? null,
        patch: (file) => this.controller?.agentPatch(file)?.patch ?? "",
        resolve: (file) => this.workspace.resolveInActive(file),
        git: () => this.workspace.gitApi,
        changed: () => this.postState(),
        openDiff: (file) => (file ? this.openAgentDiff(file) : this.openAgentDiffAll()),
      },
      log,
    );
    this.disposables.push(this.review);
    // Status Bar shortcut to the chat. It stays neutral until the sidebar has connected.
    this.statusItem = vscode.window.createStatusBarItem(
      "opencodeSidecar.status",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.name = "Sidecar";
    this.statusItem.command = FOCUS_COMMAND;
    this.disposables.push(this.statusItem);
    this.updateStatusBar(null);
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.signInTerminal) void this.finishSignIn(t);
      }),
    );
    this.disposables.push(
      this.workspace.onDidChange((info) => {
        // Branch / Git status updates also fire this event; only a different folder reloads.
        const dir = info.active?.path ?? null;
        if (this.controller && this.controller.directory !== dir) void this.controller.setDirectory(dir);
        this.postState();
      }),
    );
    // The editor context chip follows the active editor (only with autoContext on).
    const followEditor = (delay: number) => {
      if (!readConfig().autoContext || this.autoTimer) return;
      this.autoTimer = setTimeout(() => {
        this.autoTimer = undefined;
        this.postState();
      }, delay);
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => followEditor(0)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) followEditor(150);
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG_SECTION)) return;
        if (
          e.affectsConfiguration(`${CONFIG_SECTION}.serverUrl`) ||
          e.affectsConfiguration(`${CONFIG_SECTION}.allowRemoteServer`) ||
          e.affectsConfiguration(`${CONFIG_SECTION}.executablePath`)
        ) {
          void this.reconnect();
        } else this.postState();
        if (e.affectsConfiguration(`${CONFIG_SECTION}.showStatusBarItem`))
          this.updateStatusBar(this.lastStage);
      }),
    );
  }

  // ------------------------------------------------------------ webview

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [distRoot, mediaRoot] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw) => void this.onMessage(raw), undefined, this.disposables);
    view.onDidChangeVisibility(() => {
      if (view.visible && this.focusPending) this.post({ type: "focusInput" });
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });
    void this.ensureStarted();
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OpenCode</title>
</head>
<body>
<div id="app" role="application" aria-label="OpenCode chat"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private post(message: HostMessage): void {
    if (this.view && this.webviewReady) void this.view.webview.postMessage(message);
  }

  /** Coalesces state pushes; the state snapshot is small. */
  postState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.review.sync();
      const state = this.viewState();
      this.updateBadge();
      this.updateStatusBar(state.onboarding.stage);
      this.post({ type: "state", state });
    }, 16);
  }

  /** Permission requests and questions waiting for an answer, in the open session and the others. */
  private waitingCount(): { all: number; elsewhere: number } {
    const elsewhere = this.controller?.backgroundWaitingCount() ?? 0;
    return { all: (this.controller?.pendingRequestCount() ?? 0) + elsewhere, elsewhere };
  }

  /**
   * A count on Sidecar's icon while permission requests or questions wait (in any of the
   * folder's sessions), so a hidden panel still says it needs you. VS Code shows it on
   * the Activity Bar icon.
   */
  private updateBadge(): void {
    if (!this.view) return;
    const { all: n, elsewhere } = this.waitingCount();
    const tooltip =
      (n === 1 ? "OpenCode is waiting for your answer" : `OpenCode is waiting for ${n} answers`) +
      (elsewhere === n
        ? ` in ${n === 1 ? "another session" : "other sessions"}`
        : elsewhere
          ? ` (${elsewhere} in other sessions)`
          : "");
    const want = n ? `${n} ${tooltip}` : "";
    const have = this.view.badge ? `${this.view.badge.value} ${this.view.badge.tooltip}` : "";
    if (want === have) return;
    this.view.badge = n ? { value: n, tooltip } : undefined;
  }

  private queueEvents(events: UiEvent[]): void {
    for (const tap of this.taps) tap(events);
    this.pendingEvents.push(...events);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const batch = this.pendingEvents;
      this.pendingEvents = [];
      if (batch.length) this.post({ type: "events", events: batch });
    }, 30);
  }

  private queueSubagentEvents(sessionID: string, events: UiEvent[]): void {
    if (this.pendingSubagent && this.pendingSubagent.sessionID !== sessionID) this.pendingSubagent = null;
    this.pendingSubagent ??= { sessionID, events: [] };
    this.pendingSubagent.events.push(...events);
    if (this.subagentTimer) return;
    this.subagentTimer = setTimeout(() => {
      this.subagentTimer = undefined;
      const batch = this.pendingSubagent;
      this.pendingSubagent = null;
      if (batch?.events.length) this.post({ type: "subagentEvents", ...batch });
    }, 30);
  }

  private queueAside(): void {
    if (this.asideTimer) return;
    this.asideTimer = setTimeout(() => {
      this.asideTimer = undefined;
      this.post({ type: "aside", aside: this.controller?.asideView() ?? null });
    }, 30);
  }

  /** Deletes an open side question's session before the extension stops (bounded wait). */
  async shutdown(): Promise<void> {
    const c = this.controller;
    if (c) await Promise.race([c.closeAside(), new Promise((r) => setTimeout(r, 1500))]);
  }

  private viewState(): ViewState {
    const c = this.controller;
    const cfg = readConfig();
    return {
      connection: this.connection,
      workspace: this.workspace.current,
      models: c?.models ?? null,
      agents: c?.agents ?? null,
      selectedModel: c?.selectedModel ?? null,
      selectedAgent: c?.selectedAgent ?? null,
      sessions: c?.displaySessions() ?? [],
      currentSession: c?.current ? { id: c.current.id, title: c.currentTitle() ?? "Untitled session" } : null,
      busy: c?.busy ?? false,
      stopping: c?.stopping ?? false,
      attachments: this.chips(),
      agentChanges: c?.agentChanges ?? { status: "none" },
      review: this.review.view(),
      workspaceChanges:
        this.workspace.current.uncommitted === null ? null : { count: this.workspace.current.uncommitted },
      usage: cfg.showUsage ? (c?.usage() ?? null) : null,
      costs: cfg.showUsage ? (c?.costs() ?? null) : null,
      quota: cfg.showUsage ? (c?.quota ?? null) : null,
      steps: c?.steps ?? 0,
      selectedVariant: c?.selectedVariant ?? null,
      budget: c?.budgetView() ?? {
        level: cfg.budgetDefault,
        limits: { maxCost: null, maxSteps: null },
        taskCost: null,
        taskSteps: 0,
        active: false,
        state: "ok",
        allowance: 1,
      },
      budgetPresets: cfg.budget.presets,
      pending: c?.pending ?? [],
      locale: uiLocale(),
      showPlacementHint: !this.context.globalState.get<boolean>(HINT_KEY, false),
      onboarding: this.onboarding(),
      subagents: c?.subagentViews() ?? [],
      viewingSubagent: c?.viewingSubagent() ?? null,
      prefs: {
        autoContext: cfg.autoContext,
        stickyPrompt: cfg.stickyPrompt,
        statusWords: cfg.statusWords,
        cacheWarmMinutes: cfg.cacheWarmMinutes,
        activity: cfg.activity,
        sessionStrip: cfg.sessionStrip,
      },
      commands: c?.commands ?? [],
      bookmarks: this.bookmarks(),
      mentionAgents: c?.mentionAgents ?? [],
      skills: c?.skills ?? [],
      goal: c?.goalView() ?? null,
      revert: c?.stagedRevert() ?? null,
      archivedSessions: c?.archivedSessions ?? null,
      history: c?.historyView() ?? { more: false, capped: false, loading: false, error: null },
      strip: c?.stripView() ?? [],
      approval: {
        ...(c?.approvalView() ?? {
          mode: "default",
          folderMode: null,
          modeRules: [],
          rules: [],
          actions: [],
          session: false,
          busy: false,
        }),
        confirmAuto: !this.context.globalState.get<boolean>(AUTO_CONFIRMED_KEY, false),
      },
    };
  }

  private onboarding(): OnboardingView {
    const c = this.controller;
    return deriveOnboarding({
      connection: this.connection,
      hasFolder: !!this.workspace.current.active,
      catalogLoaded: c?.catalogLoaded ?? false,
      catalogLoading: c?.catalogLoading ?? false,
      models: c?.models ?? null,
      account: c?.account ?? null,
      signIn: this.signInState,
      hintDismissed: this.context.globalState.get<boolean>(SIGN_IN_HINT_KEY, false),
    });
  }

  private lastStage: OnboardingView["stage"] | null = null;

  private updateStatusBar(stage: OnboardingView["stage"] | null): void {
    this.lastStage = stage;
    if (!readConfig().showStatusBarItem) {
      this.statusItem.hide();
      return;
    }
    // Requests waiting in any session are counted, like the badge on Sidecar's icon.
    const waiting = stage === "ready" ? this.waitingCount().all : 0;
    const text = waiting ? `OpenCode: ${waiting} waiting for you` : statusBarText(stage);
    this.statusItem.text = `$(comment-discussion) ${text}`;
    this.statusItem.tooltip = `Sidecar — ${text === "Sidecar" ? "open the chat" : text}. Click to open the chat.`;
    this.statusItem.accessibilityInformation = {
      label: `${text}. Open Sidecar`,
      role: "button",
    };
    this.statusItem.backgroundColor =
      stage === "sign-in" || stage === "sign-in-expired" || stage === "not-installed"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this.statusItem.show();
  }

  // ------------------------------------------------------- connection

  private async ensureStarted(): Promise<void> {
    await this.workspace.start();
    if (!this.controller && !this.connecting) await this.connect();
  }

  private setConnection(status: ConnectionStatus): void {
    this.connection = status;
    this.postState();
  }

  private reconnectGeneration = 0;

  /** Drops the current connection and connects again with the current settings. */
  private async reconnect(): Promise<void> {
    const generation = ++this.reconnectGeneration;
    // A connect still in flight read older settings: let it finish, then start over. Several
    // quick changes (e.g. two settings) collapse into one reconnect with the latest values.
    if (this.connecting) await this.connecting.catch(() => undefined);
    if (generation !== this.reconnectGeneration) return;
    this.teardown();
    await this.connect();
  }

  private teardown(): void {
    void this.controller?.closeAside();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.streamWasOpen = false;
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const cfg = readConfig();
    this.setConnection({ kind: "connecting" });
    const outcome = await discoverServer(
      { serverUrl: cfg.serverUrl, allowRemote: cfg.allowRemoteServer },
      {
        readFile: (f) => fs.promises.readFile(f, "utf8").catch(() => undefined),
        fetch,
        env: process.env,
      },
    );
    if (!outcome.ok) {
      this.log.warn(`OpenCode server not available: ${outcome.detail}`);
      if (outcome.reason === "invalid-setting" || outcome.reason === "unauthorized") {
        this.setConnection({ kind: "error", message: outcome.detail });
        return;
      }
      const cli = this.findCli();
      if (!cli.found) {
        this.setConnection({ kind: "cli-not-found", searched: cli.searched });
        return;
      }
      const canStart = cfg.serverUrl.trim() === "";
      this.setConnection({
        kind: "not-running",
        canStart,
        detail: canStart
          ? "OpenCode is installed but its background service is not running."
          : outcome.detail,
      });
      if (canStart && cfg.autoStart && !this.autoStartTried) {
        this.autoStartTried = true;
        await this.startOpenCode();
      }
      return;
    }

    this.log.info(`Connected to OpenCode ${outcome.version} at ${outcome.endpoint.url} (${outcome.source})`);
    const client = new HttpOpenCodeClient(outcome.endpoint);
    const controller = new SessionController(
      client,
      this.context.workspaceState,
      {
        onEvents: (events) => this.queueEvents(events),
        onTranscriptReset: (items) => {
          this.pendingEvents = [];
          this.post({ type: "transcript", items });
        },
        onStateChanged: () => this.postState(),
        onTaskNotice: (notice) => void this.showTaskNotice(notice),
        onSubagentTranscript: (sessionID, items) => {
          this.pendingSubagent = null;
          this.post({ type: "subagentTranscript", sessionID, items });
        },
        onSubagentEvents: (sessionID, events) => this.queueSubagentEvents(sessionID, events),
        onAsideChanged: () => this.queueAside(),
        onMcpChanged: () => this.queueMcp(),
      },
      this.log,
      () => {
        const c = readConfig();
        return {
          model: c.defaultModel.trim(),
          agent: c.defaultAgent.trim(),
          budgetLevel: c.budgetDefault,
          budget: c.budget,
          contextWarnPercent: c.contextWarnPercent,
          stuck: c.stuckDetection ? { repeats: 3, stallMs: c.stuckMinutes * 60_000 } : null,
          strings: uiLocale() === "ar" ? AR_STRINGS : undefined,
        };
      },
    );
    this.controller = controller;
    // Side-question sessions an earlier run could not delete (VS Code closed with one open).
    void controller.cleanupAsides();
    this.subscription = client.subscribe({
      onEvent: (raw) => controller.handleRawEvent(raw),
      onOpen: () => {
        this.log.info("Event stream connected");
        if (this.streamWasOpen) void controller.resync();
        this.streamWasOpen = true;
        this.setConnection({ kind: "connected", version: outcome.version, url: outcome.endpoint.url });
      },
      onClose: (error) => {
        if (this.controller !== controller) return;
        this.log.warn(`Event stream closed: ${error ?? "unknown"}; reconnecting`);
        this.setConnection({ kind: "connecting" });
      },
    });
    this.setConnection({ kind: "connected", version: outcome.version, url: outcome.endpoint.url });
    await controller.setDirectory(this.workspace.current.active?.path ?? null);
  }

  private findCli() {
    const cfg = readConfig();
    return discoverExecutable({
      configuredPath: cfg.executablePath,
      pathEnv: process.env.PATH ?? "",
      home: process.env.HOME ?? process.env.USERPROFILE ?? "",
      platform: process.platform,
      isExecutable: (file) => {
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) return false;
          if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  async startOpenCode(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cli = this.findCli();
      if (!cli.found) {
        this.setConnection({ kind: "cli-not-found", searched: cli.searched });
        return;
      }
      this.setConnection({ kind: "connecting" });
      this.log.info(`Starting OpenCode background service via ${cli.path} service start`);
      const result = await startService(cli.path);
      if (!result.ok) {
        this.log.error(`opencode service start failed: ${result.output}`);
        this.setConnection({
          kind: "error",
          message: "Could not start OpenCode. See the Sidecar output for details.",
        });
        return;
      }
      for (let i = 0; i < 20 && !this.controller; i++) {
        await this.connect();
        if (this.controller) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!this.controller)
        this.setConnection({ kind: "error", message: "OpenCode started but could not be reached." });
    })().finally(() => (this.starting = undefined));
    return this.starting;
  }

  // ---------------------------------------------------------- commands

  /** Reveals the chat view (wherever the user moved it) and focuses the message box. */
  async focus(): Promise<void> {
    this.focusPending = !(this.view && this.webviewReady);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "focusInput" });
  }

  /** Re-checks the service, account, providers, models and agents without reloading the window. */
  async refreshConnection(): Promise<void> {
    const c = this.controller;
    if (!c || this.connection.kind !== "connected") {
      await this.reconnect();
      return;
    }
    await Promise.all([c.refreshCatalog(), c.refreshSessions()]);
    // Nothing answered: the service probably went away, so rediscover it.
    if (this.controller === c && c.directory && c.models === null && c.account === null)
      await this.reconnect();
  }

  /**
   * Runs OpenCode's own sign-in (`opencode auth login`) in a VS Code terminal. The extension
   * never sees the credentials: OpenCode stores them. "account" uses the OpenCode Console
   * device flow; "provider" opens OpenCode's provider picker; an integration runs that
   * provider's method (a command, or a question only OpenCode's terminal flow can ask).
   */
  async signIn(
    target:
      "account" | "provider" | { integration: IntegrationInfo; method: IntegrationMethod | null } = "account",
  ): Promise<void> {
    const cli = this.findCli();
    if (!cli.found) {
      this.setConnection({ kind: "cli-not-found", searched: cli.searched });
      return;
    }
    if (this.signInTerminal && this.signInTerminal.exitStatus === undefined) {
      try {
        this.signInTerminal.show();
        return;
      } catch {
        // Closed a moment ago (the close event has not arrived yet): start a new sign-in.
        this.signInTerminal = undefined;
      }
    }
    const args = ["auth", "login"];
    if (target === "account") args.push("opencode", "--method", "device");
    else if (target !== "provider") {
      args.push(target.integration.id);
      if (target.method?.id) args.push("--method", target.method.id);
    }
    // A server chosen in settings is used for the login too; otherwise the background service.
    if (readConfig().serverUrl.trim() && this.connection.kind === "connected")
      args.push("--server", this.connection.url);
    this.log.info(`Starting sign-in: opencode ${args.join(" ")}`);
    const terminal = vscode.window.createTerminal({
      name:
        target === "account"
          ? "OpenCode Sign In"
          : target === "provider"
            ? "OpenCode Providers"
            : `OpenCode: ${target.integration.name}`,
      shellPath: cli.path,
      shellArgs: args,
      iconPath: new vscode.ThemeIcon("account"),
      message: "Sign in using OpenCode. Sidecar never sees or stores your password or keys.",
    });
    this.signInTerminal = terminal;
    this.signInStarted = Date.now();
    this.signInBaseline = accountKey(this.controller?.account ?? null, this.controller?.models?.length);
    this.signInState = "waiting";
    terminal.show();
    clearInterval(this.signInTimer);
    this.signInTimer = setInterval(() => void this.pollSignIn(terminal), SIGN_IN_POLL_MS);
    this.postState();
  }

  private async pollSignIn(terminal: vscode.Terminal): Promise<void> {
    if (terminal !== this.signInTerminal) return;
    if (terminal.exitStatus !== undefined) return this.finishSignIn(terminal);
    if (Date.now() - this.signInStarted > SIGN_IN_MAX_MS) {
      this.endSignInWait("idle");
      return;
    }
    // OpenCode also emits integration/provider events, which refresh the catalog; polling is a fallback.
    const c = this.controller;
    if (!c) return;
    await c.refreshCatalog();
    if (this.signInChanged()) this.endSignInWait("idle");
  }

  private async finishSignIn(terminal: vscode.Terminal): Promise<void> {
    if (terminal !== this.signInTerminal) return;
    const status = terminal.exitStatus;
    // Closed by the user (or VS Code) rather than OpenCode finishing: treat as cancelled.
    const closed = !status || status.reason !== vscode.TerminalExitReason.Process;
    const code = status?.code;
    this.signInTerminal = undefined;
    clearInterval(this.signInTimer);
    if (this.controller) await this.controller.refreshCatalog();
    else await this.reconnect();
    if (this.signInChanged() || (!closed && code === 0)) this.endSignInWait("idle");
    // 129/130/143: hang-up, Ctrl+C, terminate.
    else if (closed || code === undefined || code === 129 || code === 130 || code === 143)
      this.endSignInWait("cancelled");
    else {
      this.log.warn(`opencode auth login exited with code ${code}`);
      this.endSignInWait("failed");
    }
  }

  private signInChanged(): boolean {
    const c = this.controller;
    return !!c && accountKey(c.account, c.models?.length) !== this.signInBaseline;
  }

  private endSignInWait(state: SignInState): void {
    clearInterval(this.signInTimer);
    this.signInTimer = undefined;
    this.signInState = state;
    this.postState();
  }

  private async openFolder(): Promise<void> {
    // Native "Open Folder…" dialog.
    await vscode.commands.executeCommand("vscode.openFolder");
  }

  async newSession(): Promise<void> {
    await this.controller?.newSession();
    await this.focus();
  }

  async stop(): Promise<void> {
    await this.controller?.stop();
  }

  /** Reveals Sidecar with its History open. */
  async showHistory(): Promise<void> {
    await this.focus();
    this.post({ type: "showHistory" });
  }

  /** Opens the current session as an untitled Markdown document, to read, share or save. */
  async exportSession(): Promise<void> {
    const md = this.controller?.exportMarkdown() ?? null;
    if (!md) {
      void vscode.window.showInformationMessage("Open a session with messages to export it.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: md });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private addAttachment(a: Extract<ContextAttachment, { kind: "file" | "selection" }>): void {
    const duplicate = this.attachments.some((x) =>
      a.kind === "file"
        ? x.kind === "file" && x.absPath === a.absPath
        : x.kind === "selection" &&
          x.absPath === a.absPath &&
          x.startLine === a.startLine &&
          x.endLine === a.endLine,
    );
    if (!duplicate) this.attachments.push(a);
    this.postState();
  }

  private relativeToActive(absPath: string): string | null {
    const root = this.workspace.current.active?.path;
    if (!root) return null;
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private async confirmSensitive(relPath: string): Promise<boolean> {
    const match = classifyPath(relPath);
    if (!match) return true;
    const choice = await vscode.window.showWarningMessage(
      `${relPath} looks sensitive (${match.reason}). Attaching it sends its contents to your model provider through OpenCode.`,
      { modal: true },
      "Attach Anyway",
    );
    return choice === "Attach Anyway";
  }

  async addCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("OpenCode: open a file in the editor first.");
      return;
    }
    const absPath = editor.document.uri.fsPath;
    const rel = this.relativeToActive(absPath);
    if (!rel) {
      void vscode.window.showWarningMessage(
        "OpenCode: the current file is outside the active workspace folder.",
      );
      return;
    }
    if (!(await this.confirmSensitive(rel))) return;
    if (editor.document.isDirty) {
      void vscode.window.showInformationMessage(
        "OpenCode reads files from disk — save the file to include unsaved changes.",
      );
    }
    this.addAttachment({ kind: "file", id: crypto.randomUUID(), relPath: rel, absPath });
    await this.focus();
  }

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage("OpenCode: select some code in the editor first.");
      return;
    }
    const sel = editor.selection;
    // A selection ending at column 0 of the next line should not count that line.
    const endLine =
      sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const text = editor.document.getText(sel);
    const error = validateSelection(text);
    if (error) {
      void vscode.window.showWarningMessage(`OpenCode: ${error}`);
      return;
    }
    const absPath =
      editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : editor.document.uri.toString();
    const rel =
      editor.document.uri.scheme === "file"
        ? (this.relativeToActive(absPath) ?? absPath)
        : path.basename(editor.document.fileName);
    if (!(await this.confirmSensitive(rel))) return;
    this.addAttachment({
      kind: "selection",
      id: crypto.randomUUID(),
      relPath: rel,
      absPath,
      startLine: sel.start.line + 1,
      endLine: endLine + 1,
      text,
      languageId: editor.document.languageId,
    });
    await this.focus();
  }

  // ------------------------------------------------------ editor context

  /** The active editor for the editor context chip: a file on disk, never another tab. */
  private editorSnapshot(): EditorSnapshot | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return null;
    const absPath = editor.document.uri.fsPath;
    const relPath = this.relativeToActive(absPath);
    const snap: EditorSnapshot = {
      absPath,
      relPath,
      languageId: editor.document.languageId,
      sensitive: !!relPath && !!classifyPath(relPath),
    };
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const endLine =
        sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
      snap.selection = {
        startLine: sel.start.line + 1,
        endLine: endLine + 1,
        text: editor.document.getText(sel),
      };
    }
    return snap;
  }

  /** The editor context to send, or null (setting off, chip removed, nothing open). */
  private autoContext(): ContextAttachment | null {
    if (!readConfig().autoContext) return null;
    const snap = this.editorSnapshot();
    // A removed chip comes back once the editor shows another file or other lines.
    if (this.autoDismissed && (!snap || autoKey(snap) !== this.autoDismissed)) this.autoDismissed = null;
    return autoAttachment(snap, this.autoDismissed, this.attachments);
  }

  private chips(): AttachmentChip[] {
    const auto = this.autoContext();
    const chips = this.attachments.map(chipFor);
    return auto ? [...chips, { ...chipFor(auto), auto: true }] : chips;
  }

  // ------------------------------------------------------------ problems

  /** Puts problems in the message box as one chip (replacing an earlier one) and focuses it. */
  private async attachProblems(found: FoundProblem[], context?: number): Promise<void> {
    const { files, total } = groupProblems(found, MAX_PROBLEMS);
    addExcerpts(files, context);
    this.attachments = this.attachments.filter((a) => a.kind !== "problems");
    this.attachments.push({ kind: "problems", id: crypto.randomUUID(), files, total });
    this.postState();
    // A chat that is still loading gets the words once it is ready.
    if (this.view && this.webviewReady) this.post({ type: "suggestInput", text: "Fix these problems." });
    else this.suggestPending = "Fix these problems.";
    await this.focus();
  }

  /** How the prompt names a document: relative to the open folder, else its path or name. */
  private problemPath(uri: vscode.Uri): string {
    if (uri.scheme !== "file") return path.posix.basename(uri.path) || uri.toString();
    return this.relativeToActive(uri.fsPath) ?? uri.fsPath;
  }

  /** "Fix with OpenCode" on a diagnostic: the problems touching `range` in `uri`. */
  async fixWithOpenCode(uri?: vscode.Uri, range?: vscode.Range): Promise<void> {
    await this.workspace.start();
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target) return this.fixFileProblems();
    const rel = this.problemPath(target);
    const found = documentProblems(target, rel, range instanceof vscode.Range ? range : undefined);
    if (!found.length) {
      void vscode.window.showInformationMessage("OpenCode: there are no errors or warnings there.");
      return;
    }
    if (!(await this.confirmSensitive(rel))) return;
    await this.attachProblems(found);
  }

  async fixFileProblems(): Promise<void> {
    await this.workspace.start();
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      void vscode.window.showInformationMessage("OpenCode: open a file in the editor first.");
      return;
    }
    const rel = this.problemPath(doc.uri);
    const found = documentProblems(doc.uri, rel);
    if (!found.length) {
      void vscode.window.showInformationMessage(`OpenCode: ${rel} has no errors or warnings.`);
      return;
    }
    if (!(await this.confirmSensitive(rel))) return;
    await this.attachProblems(found);
  }

  async fixWorkspaceProblems(): Promise<void> {
    await this.workspace.start();
    const root = this.workspace.current.active?.path;
    if (!root) {
      void vscode.window.showInformationMessage("OpenCode: open a folder first.");
      return;
    }
    const { problems, skipped } = workspaceProblems(root);
    if (skipped) this.log.info(`Fix problems: left out ${skipped} file(s) that look sensitive`);
    if (!problems.length) {
      void vscode.window.showInformationMessage(
        "OpenCode: VS Code reports no errors or warnings in this folder.",
      );
      return;
    }
    // One line on each side keeps a long list readable.
    await this.attachProblems(problems, 1);
  }

  // ------------------------------------------------------- commit message

  /** The repository a Source Control title passed, else the open folder's, else the only one. */
  private commitRepository(git: GitAPI, arg?: unknown): GitRepository | null {
    const root = arg && typeof arg === "object" && "rootUri" in arg ? arg.rootUri : null;
    if (root instanceof vscode.Uri) return git.getRepository(root);
    const repoRoot = this.workspace.current.repoRoot;
    const active = repoRoot ? git.getRepository(vscode.Uri.file(repoRoot)) : null;
    return active ?? (git.repositories.length === 1 ? git.repositories[0] : null);
  }

  /**
   * Writes a commit message for the staged changes, or the agent's when nothing is
   * staged, into the Source Control commit box. It never commits. The model is asked
   * outside any session, so the conversation and its costs are not touched.
   */
  async writeCommitMessage(arg?: unknown): Promise<void> {
    await this.workspace.start();
    const git = this.workspace.gitApi ?? (await getGitApi());
    const repo = git ? this.commitRepository(git, arg) : null;
    if (!repo) {
      void vscode.window.showInformationMessage("OpenCode: open a Git repository first.");
      return;
    }
    await this.ensureStarted();
    const c = this.controller;
    if (!c || this.connection.kind !== "connected") {
      void vscode.window.showWarningMessage("OpenCode is not connected. Open the Sidecar panel to connect.");
      return;
    }
    let sections = splitGitDiff(await repo.diff(true).catch(() => ""));
    let source: "staged" | "agent" = "staged";
    if (!sections.length) {
      sections = c.agentPatches();
      source = "agent";
    }
    if (!sections.length) {
      void vscode.window.showInformationMessage(
        "OpenCode: nothing is staged and the agent made no changes. Stage the changes to describe first.",
      );
      return;
    }
    if (repo.inputBox.value.trim()) {
      const pick = await vscode.window.showWarningMessage(
        "Replace the message in the commit box?",
        "Replace",
      );
      if (pick !== "Replace") return;
    }
    const recent = await repo
      .log({ maxEntries: 20 })
      .then((l) => l.map((x) => x.message))
      .catch(() => [] as string[]);
    const prompt = buildCommitPrompt({ sections, recent, source });
    let reply: string;
    try {
      reply = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Writing commit message…" },
        () => c.generateText(prompt),
      );
    } catch (e) {
      this.log.warn(`Commit message failed: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showWarningMessage(`OpenCode could not write a commit message: ${commitError(e)}`);
      return;
    }
    const message = cleanCommitMessage(reply);
    if (!message) {
      void vscode.window.showWarningMessage(
        "OpenCode could not write a commit message: the reply was empty.",
      );
      return;
    }
    repo.inputBox.value = message;
    this.log.info(`Commit message written for the ${source} changes (${sections.length} file(s))`);
    await vscode.commands.executeCommand("workbench.view.scm");
  }

  /** "+ Context" menu: native quick pick, keyboard accessible. */
  private async pickFile(): Promise<void> {
    const root = this.workspace.current.active?.path;
    if (!root) return;
    const picked = await vscode.window.showQuickPick(
      (async () => {
        // Only runs on explicit user action; honours files.exclude and is capped.
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, "**/*"),
          undefined,
          5000,
        );
        return uris
          .map((u) => this.relativeToActive(u.fsPath))
          .filter((r): r is string => !!r)
          .sort()
          .map((r) => ({ label: path.posix.basename(r), description: r }));
      })(),
      {
        title: "Attach file to OpenCode context",
        placeHolder: "Search workspace files",
        matchOnDescription: true,
      },
    );
    if (!picked?.description) return;
    const absPath = path.join(root, picked.description);
    if (!(await this.confirmSensitive(picked.description))) return;
    this.addAttachment({ kind: "file", id: crypto.randomUUID(), relPath: picked.description, absPath });
  }

  // ---------------------------------------------------------- messages

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (!msg) {
      this.log.warn("Ignored malformed message from webview");
      return;
    }
    try {
      await this.handle(msg);
    } catch (e) {
      this.log.error(`Handling ${msg.type} failed`, e);
    }
  }

  private async handle(msg: WebviewMessage): Promise<void> {
    const c = this.controller;
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        this.post({ type: "transcript", items: c?.transcript.items ?? [] });
        {
          const viewing = c?.viewingSubagent();
          if (c && viewing)
            this.post({ type: "subagentTranscript", sessionID: viewing.id, items: c.subagentItems() });
        }
        this.post({ type: "state", state: this.viewState() });
        this.post({ type: "aside", aside: c?.asideView() ?? null });
        if (this.focusPending) {
          this.focusPending = false;
          this.post({ type: "focusInput" });
        }
        if (this.suggestPending) {
          this.post({ type: "suggestInput", text: this.suggestPending });
          this.suggestPending = null;
        }
        if (this.providersPending) {
          this.providersPending = false;
          this.post({ type: "showProviders" });
        }
        if (this.agentsPending !== null) {
          this.post({ type: "showAgents", import: this.agentsPending });
          this.agentsPending = null;
        }
        return;
      case "send": {
        if (!c) return;
        const mentions = await this.resolveMentions(msg.mentions ?? []);
        if (!mentions) {
          this.post({ type: "restoreInput", text: msg.text });
          return;
        }
        // The editor context goes only if its chip is still there now.
        const auto = this.autoContext();
        const attachments = auto ? [...this.attachments, auto] : this.attachments;
        const sent = await c.send(msg.text, attachments, msg.delivery, mentions, msg.pastes ?? []);
        if (sent) {
          this.attachments = [];
          this.postState();
        } else this.post({ type: "state", state: this.viewState() });
        return;
      }
      case "askAside":
        return c?.askAside(msg.text);
      case "closeAside":
        return c?.closeAside();
      case "asideToMain":
        await c?.asideToMain();
        return;
      case "findMentions":
        this.post({
          type: "mentionResults",
          requestId: msg.requestId,
          items: await this.findMentions(msg.query),
        });
        return;
      case "attachImage":
        return this.attachImage(msg);
      case "pickImage":
        return this.pickImages();
      case "forkSession": {
        const text = await c?.fork(msg.messageID);
        if (text) this.post({ type: "restoreInput", text });
        return;
      }
      case "archiveSession":
        return c?.setArchived(msg.id, msg.archived);
      case "loadArchived":
        return c?.loadArchived();
      case "insertCode":
        return this.insertCode(msg.text);
      case "openCode":
        return this.openCode(msg.text, msg.lang);
      case "loadMcpServers":
        this.mcpWatched = true;
        return this.postMcpServers();
      case "mcpConnect":
        return this.mcpAction(msg.name, "Connecting…", (n) => c?.connectMcp(n));
      case "mcpDisconnect":
        return this.mcpAction(msg.name, "Disconnecting…", (n) => c?.disconnectMcp(n));
      case "mcpRemove":
        return this.mcpAction(msg.name, "Removing…", (n) => c?.removeMcp(n));
      case "mcpAuth":
        return this.authenticateMcp(msg.name);
      case "mcpAdd":
        return this.addMcp(msg.name, msg.target);
      case "reloadMcp":
        return this.reloadMcp();
      case "loadInstructions":
        return this.instructions.postView();
      case "openInstruction":
        return this.instructions.open(msg.path);
      case "createInstructions":
        return this.instructions.create(msg.scope);
      case "goalAction":
        return c?.goalCommand(msg.action);
      case "remember":
        await this.instructions.remember(msg.text);
        return;
      case "loadUsageDetails":
        return this.postUsageDetails();
      case "exportSession":
        return this.exportSession();
      case "deleteSession":
        return c?.deleteSession(msg.id);
      case "loadSavedPermissions":
        return this.postSavedPermissions();
      case "removeSavedPermission":
        if (!c) return;
        try {
          await c.removeSavedPermission(msg.id);
        } catch (e) {
          this.log.warn(`Removing a saved permission failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return this.postSavedPermissions();
      case "updateSavedPermission":
        if (!c) return;
        try {
          await c.updateSavedPermission(msg.id, { action: msg.action, resource: msg.resource });
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          this.log.warn(`Changing a saved permission failed: ${why}`);
          void vscode.window.showWarningMessage(`OpenCode could not change the rule: ${why}`);
        }
        return this.postSavedPermissions();
      case "setApprovalMode":
        if (msg.dontAskAgain) await this.context.globalState.update(AUTO_CONFIRMED_KEY, true);
        return c?.setApprovalMode(msg.mode, msg.scope);
      case "setSessionRules":
        return c?.setSessionRules(msg.rules);
      case "allowLike":
        return c?.allowLike(msg.requestId, msg.patterns, msg.scope);
      case "resolveRevert":
        return this.resolveRevert(msg.action);
      case "stop":
        return c?.stop();
      case "newSession":
        return c?.newSession();
      case "selectSession":
        if (c) await c.openSession(msg.id);
        return;
      case "closeStripTab":
        return c?.closeStripTab(msg.id);
      case "refreshSessions":
        return c?.refreshSessions();
      case "selectModel":
        return c?.selectModel(msg.key);
      case "selectAgent":
        return c?.selectAgent(msg.id);
      case "selectRoot":
        await this.workspace.setActiveRoot(msg.path);
        return;
      case "addCurrentFile":
        return this.addCurrentFile();
      case "addSelection":
        return this.addSelection();
      case "searchFiles":
        return this.pickFile();
      case "openToolText":
        return this.openToolText(msg.itemId, msg.part);
      case "setPref":
        await vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        return;
      case "refreshCommands":
        return c?.refreshCommands();
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "opencodeSidecar");
        return;
      case "removeAttachment":
        if (isAutoId(msg.id)) this.autoDismissed = msg.id.slice("auto:".length);
        else this.attachments = this.attachments.filter((a) => a.id !== msg.id);
        this.postState();
        return;
      case "fixProblems":
        return msg.scope === "file" ? this.fixFileProblems() : this.fixWorkspaceProblems();
      case "writeCommitMessage":
        return this.writeCommitMessage();
      case "rewind":
        return this.rewind(msg.messageID, msg.files);
      case "renameSession":
        return c?.renameSession(msg.title);
      case "runCommand":
        return c?.runCommand(msg.name, msg.text, msg.delivery);
      case "compact":
        return c?.compact();
      case "shellCommand":
        return c?.runShell(msg.command);
      case "toggleBookmark":
        return this.toggleBookmark(msg.itemId);
      case "openBookmark":
        return this.openBookmark(msg.id);
      case "removeBookmark":
        await this.context.workspaceState.update(
          BOOKMARKS_KEY,
          this.bookmarks().filter((b) => b.id !== msg.id),
        );
        this.postState();
        return;
      case "respondPermission":
        return c?.respondPermission(msg.requestId, msg.decision, msg.message);
      case "openFile":
        return this.openFile(msg.path);
      case "openAgentDiff":
        return this.openAgentDiff(msg.path);
      case "openAgentDiffAll":
        return this.openAgentDiffAll();
      case "reviewChanges":
        return this.review.showReview();
      case "rewindPreview": {
        const preview = c && !c.busy ? await c.rewindPreview(msg.messageID) : null;
        this.post({ type: "rewindPreview", messageID: msg.messageID, preview });
        return;
      }
      case "openWorkspaceDiffAll": {
        const files = this.workspace.workspaceChanges();
        if (!files || files.length === 0) {
          void vscode.window.showInformationMessage("OpenCode: no uncommitted workspace changes.");
          return;
        }
        await openAllDiffs(this.workspace.gitApi, files);
        return;
      }
      case "copy":
        return this.copy(msg.requestId, msg.text);
      case "copyMessage": {
        const text = c?.copyText(msg.itemId) ?? null;
        if (text === null) {
          this.post({ type: "copyResult", requestId: msg.requestId, ok: false });
          return;
        }
        return this.copy(msg.requestId, text);
      }
      case "selectVariant":
        return c?.selectVariant(msg.variant === "" ? null : msg.variant);
      case "selectBudget":
        return c?.selectBudget(msg.level as BudgetLevel);
      case "budgetAction":
        if (!c) return;
        if (msg.action === "continue") await c.budgetContinueOnce(msg.itemId);
        else if (msg.action === "increase") await c.budgetIncrease(msg.itemId);
        else await c.budgetNewSession(msg.itemId);
        return;
      case "answerForm": {
        if (!c) return;
        const error = await c.answerForm(msg.formId, msg.answer);
        if (error) this.post({ type: "formError", formId: msg.formId, error });
        return;
      }
      case "cancelForm":
        return c?.cancelForm(msg.formId);
      case "editPending": {
        const text = (await c?.cancelPending(msg.id)) ?? null;
        if (text !== null) this.post({ type: "restoreInput", text });
        return;
      }
      case "removePending":
        await c?.cancelPending(msg.id);
        return;
      case "setDelivery":
        return c?.setPendingDelivery(msg.id, msg.delivery);
      case "retryLast":
        await c?.retry();
        return;
      case "focusModelPicker":
        this.post({ type: "focusModel" });
        return;
      case "dismissHint":
        await this.context.globalState.update(HINT_KEY, true);
        this.postState();
        return;
      case "openLink":
        return this.openLink(msg.href);
      case "startOpenCode":
        return this.startOpenCode();
      case "retry":
        return this.reconnect();
      case "configurePath":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `${CONFIG_SECTION}.executablePath`,
        );
        return;
      case "showLogs":
        this.log.show();
        return;
      case "signIn":
        return this.signIn("account");
      case "connectProvider":
        return this.signIn("provider");
      case "loadAgents":
        return this.agents.postView();
      case "saveAgent":
        return this.agents.save(msg.draft, msg.editing, msg.open, msg.override);
      case "deleteAgent":
        return this.agents.remove(msg.id);
      case "openAgentFile":
        return this.agents.openFile(msg.id);
      case "previewImport":
        return this.agents.preview();
      case "importModes":
        return this.agents.importModes(msg.keys, msg.scope, msg.override);
      case "loadProviders":
        return this.postProviders();
      case "providerConnect":
        return this.connectProvider(msg.id, false);
      case "providerReauth":
        return this.connectProvider(msg.id, true);
      case "providerDisconnect":
        return this.disconnectProvider(msg.id);
      case "reloadProviders":
        return this.reloadProviders();
      case "checkSetup":
        return this.checkSetup();
      case "refreshConnection":
        if (this.signInState === "cancelled" || this.signInState === "failed") this.signInState = "idle";
        return this.refreshConnection();
      case "openFolder":
        return this.openFolder();
      case "openOfficial":
        await vscode.env.openExternal(vscode.Uri.parse(OPENCODE_LINKS[msg.link]));
        return;
      case "openSubagent":
        if (c) await c.openSubagent(msg.sessionID);
        return;
      case "closeSubagent":
        c?.closeSubagent();
        return;
      case "loadEarlier":
        return c?.loadEarlier();
      case "retryHistory":
        return c?.retryHistory();
      case "viewError":
        this.log.warn(`The chat could not show ${msg.itemId}: ${msg.message}`);
        return;
      case "openRawJson": {
        const raw = c?.rawJson(msg.itemId);
        if (raw && this.toolText) await this.toolText.open(raw.title, raw.text);
        return;
      }
      case "stuckAction":
        if (c) await c.stuckAction(msg.sessionID, msg.action);
        return;
      case "stopSubagent":
        if (c) await c.stopSubagent(msg.sessionID);
        return;
      case "dismissSignInHint":
        await this.context.globalState.update(SIGN_IN_HINT_KEY, true);
        this.postState();
        return;
    }
  }

  /**
   * Inserts a code block at the cursor of the last text editor (replacing its selection),
   * as an ordinary edit that Undo reverts.
   */
  private async insertCode(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file first; the code goes in at its cursor.");
      return;
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    const ok = await editor.edit((b) => {
      for (const sel of editor.selections) b.replace(sel, text);
    });
    if (!ok) void vscode.window.showWarningMessage("The code could not be inserted into this editor.");
  }

  /** Opens a code block as a new untitled document in its language. */
  private async openCode(text: string, lang: string): Promise<void> {
    const language = await languageId(lang);
    const doc = await vscode.workspace.openTextDocument({ language, content: text });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Sends the folder's MCP servers to the webview (or why they could not be listed). */
  private async postMcpServers(): Promise<void> {
    const c = this.controller;
    if (!c) return this.post({ type: "mcpServers", items: null, error: "Not connected to OpenCode." });
    try {
      this.post({ type: "mcpServers", items: await c.mcpServers(), busy: this.mcpBusy });
    } catch (e) {
      this.log.warn(`Listing MCP servers failed: ${e instanceof Error ? e.message : String(e)}`);
      this.post({
        type: "mcpServers",
        items: null,
        error: "OpenCode could not list them.",
        busy: this.mcpBusy,
      });
    }
  }

  /** OpenCode reported an MCP server's state changed: the panel's list follows (debounced). */
  private queueMcp(): void {
    if (!this.mcpWatched || this.mcpTimer) return;
    this.mcpTimer = setTimeout(() => {
      this.mcpTimer = undefined;
      void this.postMcpServers();
    }, 200);
  }

  private setMcpBusy(busy: McpBusy | null): void {
    this.mcpBusy = busy;
    void this.postMcpServers();
  }

  /** Connect, Disconnect, Retry or Remove: one at a time, the list sent again after it. */
  private async mcpAction(
    name: string,
    text: string,
    run: (name: string) => Promise<void> | undefined,
  ): Promise<void> {
    if (!this.controller || this.mcpBusy) return;
    this.setMcpBusy({ name, text });
    try {
      await run(name);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log.warn(`MCP server ${name}: ${why}`);
      void vscode.window.showWarningMessage(`OpenCode could not do that for ${name}: ${why}`);
    } finally {
      this.mcpBusy = null;
    }
    await this.postMcpServers();
  }

  /** Signs in to an MCP server through OpenCode's OAuth (the providers' flow), then reconnects it. */
  private async authenticateMcp(name: string): Promise<void> {
    const c = this.controller;
    if (!c || this.mcpBusy) return;
    this.setMcpBusy({ name, text: "Signing in…" });
    let outcome: ConnectOutcome;
    try {
      const ui = vscodeConnectUi(
        (integration, method) => this.signIn({ integration, method }),
        (text) => this.setMcpBusy({ name, text: text ?? "Signing in…" }),
      );
      outcome = await c.authenticateMcp(name, ui);
    } catch (e) {
      outcome = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
    } finally {
      this.mcpBusy = null;
    }
    await this.postMcpServers();
    if (outcome.kind === "connected") void vscode.window.showInformationMessage(`${name} is connected.`);
    else if (outcome.kind === "failed")
      void vscode.window.showWarningMessage(`${name} could not be signed in: ${outcome.message}`);
  }

  private async addMcp(name: string, target: string): Promise<void> {
    const c = this.controller;
    if (!c) return this.post({ type: "mcpAddResult", ok: false, error: "Not connected to OpenCode." });
    if (this.mcpBusy)
      return this.post({ type: "mcpAddResult", ok: false, error: "Wait for the last change to finish." });
    this.setMcpBusy({ name, text: "Adding…" });
    let error: string | undefined;
    try {
      await c.addMcp(name, target);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.log.warn(`Adding MCP server ${name} failed: ${error}`);
    } finally {
      this.mcpBusy = null;
    }
    this.post(error ? { type: "mcpAddResult", ok: false, error } : { type: "mcpAddResult", ok: true });
    await this.postMcpServers();
  }

  /** Reload config from the MCP panel: the providers' reload (retried past deleted folders). */
  private async reloadMcp(): Promise<void> {
    const c = this.controller;
    if (!c || this.mcpBusy) return;
    this.setMcpBusy({ name: "", text: "Reloading OpenCode's config…" });
    try {
      await c.reloadConfig();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log.warn(`Reloading OpenCode's config failed: ${why}`);
      void vscode.window.showWarningMessage(
        `OpenCode could not reload its config: ${why.split(/\r?\n/)[0].replace(/^[\w.]+Error: /, "")}`,
      );
    } finally {
      this.mcpBusy = null;
    }
    await this.postMcpServers();
  }

  private async postProviders(): Promise<void> {
    const c = this.controller;
    if (!c) return this.post({ type: "providers", view: null, error: "Not connected to OpenCode." });
    try {
      this.post({ type: "providers", view: await c.providersView(this.providerBusy) });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log.warn(`Listing providers failed: ${why}`);
      this.post({
        type: "providers",
        view: null,
        error: c.directory ? "OpenCode could not list them." : why,
      });
    }
  }

  private setProviderBusy(busy: ProvidersView["busy"]): void {
    this.providerBusy = busy;
    void this.postProviders();
  }

  /** Opens the Agents panel in the chat (Manage Agents), or its import preview (Import Roo Code Modes). */
  async showAgents(importModes = false): Promise<void> {
    this.agentsPending = this.view && this.webviewReady ? null : importModes;
    await this.focus();
    if (this.agentsPending === null) this.post({ type: "showAgents", import: importModes });
  }

  /** Opens the Providers panel in the chat (the Manage Providers command). */
  async showProviders(): Promise<void> {
    // A view that is still loading opens the panel once it is ready.
    this.providersPending = !(this.view && this.webviewReady);
    await this.focus();
    this.post({ type: "showProviders" });
  }

  /**
   * Connects a provider or signs in to it again through OpenCode's own flow: a browser
   * sign-in, a masked key box or OpenCode's terminal. OpenCode stores what it gets.
   */
  private async connectProvider(id: string, reauth: boolean): Promise<void> {
    const c = this.controller;
    if (!c) return;
    if (this.providerBusy) {
      void vscode.window.showInformationMessage("Another provider sign-in is still running.");
      return;
    }
    this.setProviderBusy({ id, text: reauth ? "Signing in again…" : "Connecting…" });
    let outcome: ConnectOutcome;
    let name = id;
    try {
      const ui = vscodeConnectUi(
        (integration, method) => this.signIn({ integration, method }),
        (text) => this.setProviderBusy({ id, text: text ?? "Connecting…" }),
      );
      outcome = await c.connectProvider(id, ui, reauth, (n) => (name = n));
    } finally {
      this.providerBusy = null;
    }
    await this.postProviders();
    switch (outcome.kind) {
      case "connected":
        void vscode.window.showInformationMessage(`${name} is connected.`);
        break;
      case "failed":
        void vscode.window.showWarningMessage(`${name} could not be connected: ${outcome.message}`);
        break;
      case "env":
        void vscode.window.showInformationMessage(
          `${name} connects through an environment variable: set ${outcome.names.join(" or ")}, then restart the OpenCode service so it sees it.`,
        );
        break;
      default:
        break;
    }
  }

  private async disconnectProvider(id: string): Promise<void> {
    const c = this.controller;
    if (!c || this.providerBusy) return;
    this.setProviderBusy({ id, text: "Disconnecting…" });
    try {
      const n = await c.disconnectProvider(id);
      if (!n)
        void vscode.window.showInformationMessage(
          "Nothing to remove: it is connected through an environment variable or OpenCode's config.",
        );
    } catch (e) {
      this.log.warn(`Disconnecting ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showWarningMessage(
        "OpenCode could not disconnect it. See the Sidecar output for details.",
      );
    } finally {
      this.providerBusy = null;
    }
    await this.postProviders();
  }

  private async reloadProviders(): Promise<void> {
    const c = this.controller;
    if (!c || this.providerBusy) return;
    this.setProviderBusy({ id: "", text: "Reloading OpenCode's config…" });
    try {
      await c.reloadConfig();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log.warn(`Reloading OpenCode's config failed: ${why}`);
      // OpenCode 2.4 refuses (503) while it still has a folder loaded that was deleted since.
      void vscode.window.showWarningMessage(
        `OpenCode could not reload its config: ${why.split(/\r?\n/)[0].replace(/^[\w.]+Error: /, "")}`,
      );
    } finally {
      this.providerBusy = null;
    }
    await this.postProviders();
  }

  /**
   * "Check OpenCode setup": the program, the service, sign-in, models, providers and, on
   * Windows, PATH and the folder's drive letter, as a Markdown report in an editor tab.
   */
  async checkSetup(): Promise<void> {
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking OpenCode setup…" },
      () => this.setupReport(),
    );
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: report.markdown });
    await vscode.window.showTextDocument(doc, { preview: false });
    const pick = await vscode.window.showInformationMessage(
      report.level === "ok" ? "OpenCode setup looks fine." : "The setup check found things to look at.",
      "Copy Report",
    );
    if (pick === "Copy Report") await vscode.env.clipboard.writeText(report.markdown);
  }

  /** Gathers the setup check's facts (read-only: nothing is started or changed). */
  async setupReport(): Promise<{ markdown: string; level: ReturnType<typeof overall> }> {
    const cfg = readConfig();
    const cli = this.findCli();
    const version = cli.found ? await cliVersion(cli.path) : null;
    const reg = parseRegistration(
      await fs.promises.readFile(serviceFilePath(), "utf8").catch(() => undefined),
    );
    const c = this.controller;
    let server: { url: string; version: string; pid: number | null } | null = null;
    let serverError: string | undefined;
    if (c && this.connection.kind === "connected") {
      try {
        const info = await c.serverInfo();
        server = { url: this.connection.url, version: info.version, pid: info.pid };
      } catch (e) {
        serverError = e instanceof Error ? e.message : String(e);
      }
    } else
      serverError = this.connection.kind === "error" ? this.connection.message : "Sidecar is not connected.";
    if (server && c) await c.refreshCatalog();
    const facts = server && c ? await c.setupFacts() : null;
    const folder = this.workspace.current.active?.path ?? null;
    const sections = healthReport({
      platform: process.platform,
      cli,
      cliVersion: version?.version ?? null,
      cliError: version && !version.version ? version.output.split(/\r?\n/)[0] : undefined,
      service: reg ? { url: reg.url, pid: reg.pid ?? null } : null,
      serverSetting: cfg.serverUrl,
      server,
      serverError,
      folder: folder ? { path: folder, sent: opencodeDirectory(folder) } : null,
      projectID: facts?.projectID,
      account: c?.account ?? null,
      integrations: facts?.integrations ?? null,
      providers: c?.providers ?? null,
      models: c?.models ?? null,
      defaultModel: facts?.defaultModel ?? null,
      providerErrors: c?.providerErrors ?? new Map(),
      pathDirs: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean),
    });
    const sidecar = String((this.context.extension.packageJSON as { version?: string }).version ?? "");
    const markdown = healthMarkdown(sections, { when: new Date(), sidecar });
    this.log.info(`Setup check: ${overall(sections)}`);
    return { markdown, level: overall(sections) };
  }

  /** Sends the usage menu what fills the context and today's usage; a part that fails is left out. */
  private async postUsageDetails(): Promise<void> {
    const c = this.controller;
    if (!c || !readConfig().showUsage) return this.post({ type: "usageDetails", context: null, today: null });
    const warn = (what: string) => (e: unknown) => {
      this.log.warn(`Reading ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    };
    const [context, today] = await Promise.all([
      c.contextBreakdown().catch(warn("the session's context")),
      c.usageToday().catch(warn("today's usage")),
    ]);
    this.post({ type: "usageDetails", context, today });
  }

  /** Sends the open folder's "always allow" rules to the webview (or why they could not be listed). */
  private async postSavedPermissions(): Promise<void> {
    const c = this.controller;
    if (!c) return this.post({ type: "savedPermissions", items: null, error: "Not connected to OpenCode." });
    try {
      this.post({ type: "savedPermissions", items: await c.savedPermissions() });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log.warn(`Listing saved permissions failed: ${why}`);
      this.post({ type: "savedPermissions", items: null, error: "OpenCode could not list them." });
    }
  }

  /**
   * Native VS Code notification for a task milestone; "Open Chat" reveals the sidebar.
   * For a session that is not open, "Open" switches to it.
   */
  private async showTaskNotice(notice: TaskNotice): Promise<void> {
    const decision = decideNotification(notice, readNotificationSettings(), {
      viewVisible: !!this.view?.visible,
      windowFocused: vscode.window.state.focused,
    });
    if (!decision.show) return;
    this.log.info(`Notification (${notice.kind}${notice.sessionID ? ", another session" : ""}) shown`);
    const action = notice.sessionID ? "Open" : "Open Chat";
    const c = this.controller;
    const choice = await this.notifier(decision.severity, decision.message, [action]);
    if (choice !== action) return;
    // The folder (or the connection) may have changed while the notice was up.
    if (notice.sessionID && c?.current?.id !== notice.sessionID) {
      if (!c || c !== this.controller || !c.inFolder(notice.sessionID)) return;
      if (!(await c.openSession(notice.sessionID))) return;
    }
    await vscode.commands.executeCommand(FOCUS_COMMAND);
  }

  /** Replaceable for tests; defaults to VS Code's native notifications. */
  notifier: (
    severity: "info" | "warning" | "error",
    message: string,
    actions: string[],
  ) => Thenable<string | undefined> = (severity, message, actions) =>
    severity === "error"
      ? vscode.window.showErrorMessage(message, ...actions)
      : severity === "warning"
        ? vscode.window.showWarningMessage(message, ...actions)
        : vscode.window.showInformationMessage(message, ...actions);

  private async copy(requestId: string, text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
      this.post({ type: "copyResult", requestId, ok: true });
    } catch (e) {
      this.log.error("Clipboard write failed", e);
      this.post({ type: "copyResult", requestId, ok: false });
    }
  }

  /** AgentSideSource for the agent-diff document provider. */
  sides(sessionId: string, file: string): { before: string; after: string } | null {
    const c = this.controller;
    if (!c || c.current?.id !== sessionId) return null;
    return c.agentFileSides(file);
  }

  private async openAgentDiff(file: string): Promise<void> {
    const c = this.controller;
    const abs = this.workspace.resolveInActive(file);
    if (!c?.current || !abs) return;
    if (c.agentChanges.status === "ok" && c.agentFileSides(file)) {
      await openAgentFileDiff(c.current.id, file);
      return;
    }
    // Never guess ownership: fall back to the plain workspace diff and say so.
    void vscode.window.showWarningMessage(
      `Agent-only diff unavailable for ${file}. Showing the workspace diff (HEAD ↔ working tree) instead.`,
    );
    const status = c.changes.find((f) => f.path === file)?.status ?? "modified";
    await openFileDiff(this.workspace.gitApi, abs, status);
  }

  private async openAgentDiffAll(): Promise<void> {
    const c = this.controller;
    if (!c?.current) return;
    if (c.agentChanges.status !== "ok") {
      void vscode.window.showWarningMessage(
        "Agent-only diff unavailable. Showing workspace changes instead.",
      );
      await this.handle({ type: "openWorkspaceDiffAll" });
      return;
    }
    const files = c.agentChanges.files
      .filter((f) => c.agentFileSides(f.path))
      .map((f) => ({ file: f.path, absPath: this.workspace.resolveInActive(f.path) }))
      .filter((f): f is { file: string; absPath: string } => !!f.absPath);
    if (files.length < c.agentChanges.files.length) {
      void vscode.window.showWarningMessage(
        `Agent-only diff unavailable for ${c.agentChanges.files.length - files.length} file(s) (binary or incomplete snapshot).`,
      );
    }
    await openAgentDiffs(c.current.id, files);
  }

  private bookmarks(): BookmarkView[] {
    const raw = this.context.workspaceState.get<unknown>(BOOKMARKS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (b): b is BookmarkView =>
        !!b &&
        typeof b === "object" &&
        typeof (b as BookmarkView).id === "string" &&
        typeof (b as BookmarkView).sessionID === "string" &&
        typeof (b as BookmarkView).itemId === "string",
    );
  }

  /** Bookmarks an answer of the open session, or removes the bookmark. */
  private async toggleBookmark(itemId: string): Promise<void> {
    const c = this.controller;
    const item = c?.transcript.get(itemId);
    if (!c?.current || item?.kind !== "assistant") return;
    const list = this.bookmarks();
    const existing = list.find((b) => b.sessionID === c.current!.id && b.itemId === itemId);
    const next = existing
      ? list.filter((b) => b !== existing)
      : [
          {
            id: `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            sessionID: c.current.id,
            sessionTitle: c.currentTitle() ?? "Untitled session",
            itemId,
            excerpt: item.text.replace(/\s+/g, " ").trim().slice(0, 200),
            created: Date.now(),
          },
          ...list,
        ].slice(0, MAX_BOOKMARKS);
    await this.context.workspaceState.update(BOOKMARKS_KEY, next);
    this.postState();
  }

  /** Opens a bookmark's session (if needed) and scrolls to the answer. */
  private async openBookmark(id: string): Promise<void> {
    const c = this.controller;
    const b = this.bookmarks().find((x) => x.id === id);
    if (!c || !b) return;
    if (c.current?.id !== b.sessionID && !(await c.openSession(b.sessionID))) return;
    this.post({ type: "revealItem", itemId: b.itemId });
  }

  /** Opens a tool call's full command, output or subagent prompt in a read-only tab. */
  private async openToolText(itemId: string, part: "in" | "out" | "prompt"): Promise<void> {
    const c = this.controller;
    const item = c?.transcript.get(itemId) ?? c?.subagentItems().find((i) => i.id === itemId);
    if (item?.kind !== "tool" || !this.toolText) return;
    const d = item.detail;
    const name = item.name.toLowerCase();
    const label =
      name === "bash" || name === "shell" ? "Shell" : name.charAt(0).toUpperCase() + name.slice(1);
    const command = (d.command ?? item.title).split("\n")[0].slice(0, 40);
    if (part === "prompt" && d.prompt) await this.toolText.open(`Subagent prompt (${item.title})`, d.prompt);
    else if (part === "in")
      await this.toolText.open(`${label} command (${command})`, d.command ?? item.title);
    else if (part === "out" && d.output !== null)
      await this.toolText.open(
        `${label} output (${command})`,
        d.output + (d.outputTruncated ? "\n\n[Output truncated by OpenCode or Sidecar.]" : ""),
      );
  }

  /** A rewind staged in another client; the view has asked before Apply. */
  private async resolveRevert(action: "restore" | "apply"): Promise<void> {
    const c = this.controller;
    if (!c?.stagedRevert()) return;
    await c.resolveRevert(action);
  }

  // ------------------------------------------------------------ mentions

  /**
   * Checks the `@` mentions sent with a prompt. Files and folders must exist inside the
   * open folder (sensitive ones are confirmed, like attachments); agents and skills must
   * be ones OpenCode lists. Unknown mentions are dropped. Returns null when the user
   * declined a sensitive file, so the prompt is not sent.
   */
  private async resolveMentions(list: readonly PromptMention[]): Promise<ResolvedMention[] | null> {
    const c = this.controller;
    const root = this.workspace.current.active?.path;
    const out: ResolvedMention[] = [];
    for (const m of list) {
      if (m.kind === "agent") {
        const a = c?.mentionAgents.find((x) => x.id === m.value);
        if (a) out.push({ kind: "agent", name: a.id, text: m.text });
      } else if (m.kind === "skill") {
        const k = c?.skills.find((x) => x.id === m.value);
        if (k) out.push({ kind: "skill", id: k.id, text: m.text });
      } else if (root) {
        const abs = path.resolve(root, m.value);
        const rel = this.relativeToActive(abs);
        if (!rel) continue;
        let isDir: boolean;
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch {
          continue;
        }
        if (isDir !== (m.kind === "folder")) continue;
        if (!isDir && !(await this.confirmSensitive(rel))) return null;
        out.push({ kind: m.kind, absPath: abs, relPath: rel, text: m.text });
      }
    }
    return out;
  }

  /**
   * Suggestions for `@query`: subagents and skills whose name starts with it, then the
   * files and folders OpenCode finds. With no query: the open editors' files, the open
   * folder's top level and the subagents (skills appear once you type).
   */
  private async findMentions(query: string): Promise<MentionCandidate[]> {
    const c = this.controller;
    const root = this.workspace.current.active?.path;
    if (!c || !root) return [];
    const q = query.toLowerCase();
    const starts = (...names: string[]) => names.some((n) => n.toLowerCase().startsWith(q));
    const agents: MentionCandidate[] = c.mentionAgents
      .filter((a) => starts(a.id, a.name))
      .slice(0, 8)
      .map((a) => ({ kind: "agent", value: a.id, label: a.id, detail: a.description ?? "Subagent" }));
    const skills: MentionCandidate[] = q
      ? c.skills
          .filter((k) => starts(k.id, k.name))
          .slice(0, 6)
          .map((k) => ({ kind: "skill", value: k.id, label: k.id, detail: k.description ?? "Skill" }))
      : [];
    const file = (rel: string, dir: boolean): MentionCandidate => {
      const cut = rel.lastIndexOf("/");
      return {
        kind: dir ? "folder" : "file",
        value: rel,
        label: dir ? `${rel.slice(cut + 1)}/` : rel.slice(cut + 1),
        ...(cut > 0 ? { detail: rel.slice(0, cut + 1) } : {}),
      };
    };
    let files: MentionCandidate[];
    if (q) {
      files = (await c.findFiles(query, 30)).map((f) => file(f.path, f.type === "directory"));
    } else {
      const open = new Set<string>();
      for (const group of vscode.window.tabGroups.all)
        for (const tab of group.tabs)
          if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file") {
            const rel = this.relativeToActive(tab.input.uri.fsPath);
            if (rel) open.add(rel);
          }
      let top: Array<[string, vscode.FileType]> = [];
      try {
        top = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
      } catch {
        // an unreadable folder lists nothing
      }
      const skip = new Set([".git", "node_modules"]);
      files = [
        ...[...open].slice(0, 10).map((r) => file(r, false)),
        ...top
          .filter(([name]) => !skip.has(name) && !open.has(name))
          .sort(([a, at], [b, bt]) =>
            at === bt ? a.localeCompare(b) : at === vscode.FileType.Directory ? -1 : 1,
          )
          .slice(0, 30)
          .map(([name, type]) => file(name, type === vscode.FileType.Directory)),
      ];
    }
    return [...agents, ...skills, ...files];
  }

  // -------------------------------------------------------------- images

  /** A pasted or dropped image (a base64 data: URI checked by the message schema). */
  private attachImage(msg: Extract<WebviewMessage, { type: "attachImage" }>): void {
    const bytes = dataUriBytes(msg.dataUrl);
    if (bytes === null) return;
    if (bytes > MAX_IMAGE_BYTES) {
      void vscode.window.showWarningMessage(
        `OpenCode: the image is too large (${formatBytes(bytes)}). Images up to ${formatBytes(MAX_IMAGE_BYTES)} can be attached.`,
      );
      return;
    }
    const name =
      [...path.basename(msg.name)]
        .filter((ch) => ch >= " ")
        .join("")
        .slice(0, 120) || "image.png";
    const size = msg.width && msg.height ? `${msg.width}×${msg.height} · ` : "";
    this.attachments.push({
      kind: "image",
      id: crypto.randomUUID(),
      name,
      uri: msg.dataUrl,
      detail: `${size}${formatBytes(bytes)}`,
      ...(msg.thumb ? { thumb: msg.thumb } : {}),
    });
    this.warnIfNoImages();
    this.postState();
  }

  /** "Attach image…": image files from anywhere on disk; OpenCode reads them itself. */
  private async pickImages(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      title: "Attach images to the prompt",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
      defaultUri: this.workspace.current.active
        ? vscode.Uri.file(this.workspace.current.active.path)
        : undefined,
    });
    if (!picked?.length) return;
    for (const uri of picked) {
      let size: number;
      try {
        size = fs.statSync(uri.fsPath).size;
      } catch {
        continue;
      }
      // OpenCode's own limit for a file it reads.
      if (size > 20 * 1024 * 1024) {
        void vscode.window.showWarningMessage(`OpenCode: ${path.basename(uri.fsPath)} is larger than 20 MB.`);
        continue;
      }
      const href = pathToFileURL(uri.fsPath).href;
      if (this.attachments.some((a) => a.kind === "image" && a.uri === href)) continue;
      this.attachments.push({
        kind: "image",
        id: crypto.randomUUID(),
        name: path.basename(uri.fsPath),
        uri: href,
        detail: `${this.relativeToActive(uri.fsPath) ?? uri.fsPath} · ${formatBytes(size)}`,
      });
    }
    this.warnIfNoImages();
    this.postState();
    await this.focus();
  }

  /** Tells the user when the chosen model does not list image input in OpenCode. */
  private warnIfNoImages(): void {
    const c = this.controller;
    const model = c?.models?.find((m) => m.key === c.selectedModel);
    if (model && !model.images)
      void vscode.window.showInformationMessage(
        `OpenCode does not list image input for ${model.name}. Pick a model that accepts images before sending.`,
      );
  }

  /**
   * Rewind ↺ on a prompt, after the view's confirmation dialog: OpenCode drops the
   * prompt and everything after it, and with `files` also undoes its file changes.
   */
  private async rewind(messageID: string, files: boolean): Promise<void> {
    const c = this.controller;
    if (!c?.current) return;
    if (c.busy) {
      void vscode.window.showInformationMessage("Stop the running task before rewinding.");
      return;
    }
    const text = await c.rewind(messageID, files);
    if (text !== null) this.post({ type: "restoreInput", text });
  }

  private async openFile(p: string): Promise<void> {
    const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(p);
    const file = m?.[1] ?? p;
    const line = m?.[2] ? Math.max(0, Number(m[2]) - 1) : undefined;
    const abs = path.isAbsolute(file) ? file : this.workspace.resolveInActive(file);
    if (!abs || !fs.existsSync(abs)) {
      void vscode.window.showWarningMessage(`OpenCode: file not found: ${file}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return; // ignore other schemes
    const file = /^file:/i.test(href) ? vscode.Uri.parse(href).fsPath : decodeURIComponent(href);
    await this.openFile(file);
  }

  dispose(): void {
    clearInterval(this.signInTimer);
    this.teardown();
    clearTimeout(this.flushTimer);
    clearTimeout(this.stateTimer);
    clearTimeout(this.asideTimer);
    clearTimeout(this.autoTimer);
    for (const d of this.disposables) d.dispose();
  }

  /** Test hook: exposes internals to the acceptance harness only. */
  get testApi() {
    return {
      controller: () => this.controller,
      connection: () => this.connection,
      workspace: () => this.workspace.current,
      attachments: () => this.attachments,
      autoContext: () => this.autoContext(),
      viewState: () => this.viewState(),
      handle: (msg: WebviewMessage) => this.handle(msg),
      ensureStarted: () => this.ensureStarted(),
      setNotifier: (fn: ChatViewProvider["notifier"]) => {
        this.notifier = fn;
      },
      viewVisible: () => !!this.view?.visible,
      badge: () => this.view?.badge?.value ?? 0,
      statusBar: () => ({
        text: this.statusItem.text,
        tooltip: String(this.statusItem.tooltip ?? ""),
        command: this.statusItem.command,
      }),
      signInState: () => this.signInState,
      setupReport: () => this.setupReport(),
      importItems: () => this.agents.previewItems(),
      instructions: () => this.instructions,
      review: () => this.review.testApi,
      focusPending: () => this.focusPending,
      tap: (fn: (events: UiEvent[]) => void) => {
        this.taps.add(fn);
        return { dispose: () => this.taps.delete(fn) };
      },
    };
  }
}

/** Why a generation failed, in plain words: the free limit and missing models are common. */
function commitError(e: unknown): string {
  if (e instanceof OpenCodeHttpError) {
    if (e.reason === "rate_limit")
      return `the model's usage limit is reached (${e.message}). Try again later or pick another model.`;
    if (e.reason === "authentication") return "the provider needs you to sign in again.";
    if (e.tag === "ModelNotFoundError" || e.tag === "ProviderNotFoundError")
      return `${e.message}. Pick another model in the chat.`;
    return e.message;
  }
  if (e instanceof Error && e.name === "TimeoutError") return "the model took too long to answer.";
  return e instanceof Error ? e.message : String(e);
}

/** Fingerprint of the connection evidence, used to notice when a sign-in completed. */
function accountKey(account: AccountStatus | null, modelCount: number | undefined): string | null {
  return account ? `${account.opencode}:${account.otherProviders}:${modelCount ?? -1}` : null;
}

async function languageId(lang: string): Promise<string> {
  return languageFor(lang, await vscode.languages.getLanguages());
}
