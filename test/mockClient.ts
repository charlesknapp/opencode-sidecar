import type {
  EventHandlers,
  EventSubscription,
  FileDiffInfo,
  FoundFile,
  ModelRef,
  OAuthAttempt,
  OAuthStatus,
  OpenCodeClient,
  PromptInput,
  ServerInfo,
} from "../src/opencode/client";
import type { IntegrationInfo, ProviderEntry } from "../src/core/providers";
import type { AgentDetail, ConfigSources } from "../src/core/agents";
import { OpenCodeHttpError } from "../src/opencode/client";
import type { PermissionRule } from "../src/shared/approval";
import type {
  AccountStatus,
  AgentOption,
  FormAnswer,
  FormRequest,
  GoalState,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  McpConfig,
  McpServerInfo,
  PermissionRequest,
  QuotaView,
  SavedPermission,
  SessionSummary,
  SkillOption,
  UsageStats,
} from "../src/shared/model";

export interface Call {
  method: string;
  args: unknown[];
}

/** In-memory OpenCodeClient used to test the controller without a server. */
export class MockClient implements OpenCodeClient {
  readonly url = "http://127.0.0.1:1";
  calls: Call[] = [];
  models: ModelOption[] = [
    {
      key: "opencode-go/kimi",
      providerID: "opencode-go",
      id: "kimi",
      name: "Kimi",
      providerName: "OpenCode Go",
      contextLimit: 262144,
      variants: [],
    },
    {
      key: "vast/qwen",
      providerID: "vast",
      id: "qwen",
      name: "Qwen",
      providerName: "Vast",
      contextLimit: 131072,
      variants: ["low", "high"],
    },
  ];
  modelResponses: ModelOption[][] | null = null;
  agents: AgentOption[] = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ];
  serverDefault: string | null = "vast/qwen";
  sessions: SessionSummary[] = [];
  messages: unknown[] = [];
  permissions: PermissionRequest[] = [];
  active = new Set<string>();
  interruptResult = true;
  replyError: Error | null = null;
  diff: FileDiffInfo[] = [];
  private counter = 0;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  async info(): Promise<ServerInfo> {
    return { version: "2.0.24", pid: 1 };
  }
  async listModels(directory: string) {
    this.record("listModels", directory);
    if (this.modelsError) throw this.modelsError;
    if (this.modelResponses?.length) return this.modelResponses.shift()!;
    return this.models;
  }
  async defaultModel() {
    return this.serverDefault;
  }
  async listAgents() {
    this.record("listAgents");
    if (this.agentsError) throw this.agentsError;
    return this.agents;
  }
  account: AccountStatus = { opencode: "connected", otherProviders: false };
  accountError: Error | null = null;
  agentsError: Error | null = null;
  modelsError: Error | null = null;
  async accountStatus(directory: string) {
    this.record("accountStatus", directory);
    if (this.accountError) throw this.accountError;
    return { ...this.account };
  }
  integrations: IntegrationInfo[] = [];
  providers: ProviderEntry[] = [
    {
      id: "opencode-go",
      name: "OpenCode Go",
      integrationID: "opencode-go",
      activation: "auto",
      localEndpoint: null,
    },
    { id: "vast", name: "Vast", integrationID: "vast", activation: "auto", localEndpoint: null },
  ];
  /** Errors thrown by the connect calls, by method name. */
  connectErrors = new Map<string, Error>();
  oauthAttempt: OAuthAttempt = {
    attemptID: "att_1",
    url: "https://example.test/authorize",
    instructions: "Enter code ABCD-1234",
    mode: "auto",
    paste: false,
    expires: null,
  };
  /** Statuses `oauthStatus` returns in turn; the last one repeats. */
  oauthStatuses: OAuthStatus[] = [{ status: "complete", message: null }];
  private fail(method: string) {
    const e = this.connectErrors.get(method);
    if (e) throw e;
  }
  async listIntegrations(directory: string) {
    this.record("listIntegrations", directory);
    this.fail("listIntegrations");
    return this.integrations;
  }
  async getIntegration(directory: string, id: string) {
    this.record("getIntegration", directory, id);
    const i = this.integrations.find((x) => x.id === id);
    if (!i) throw new OpenCodeHttpError(404, "IntegrationNotFoundError", `Integration not found: ${id}`);
    return i;
  }
  async listProviders(directory: string) {
    this.record("listProviders", directory);
    this.fail("listProviders");
    return this.providers;
  }
  async connectKey(directory: string, integrationID: string, key: string, answer?: FormAnswer) {
    this.record("connectKey", directory, integrationID, key, answer);
    this.fail("connectKey");
  }
  async startOAuth(directory: string, integrationID: string, methodID: string, answer?: FormAnswer) {
    this.record("startOAuth", directory, integrationID, methodID, answer);
    this.fail("startOAuth");
    return { ...this.oauthAttempt };
  }
  async oauthStatus(directory: string, integrationID: string, attemptID: string) {
    this.record("oauthStatus", directory, integrationID, attemptID);
    this.fail("oauthStatus");
    return this.oauthStatuses.length > 1 ? this.oauthStatuses.shift()! : this.oauthStatuses[0];
  }
  async completeOAuth(directory: string, integrationID: string, attemptID: string, code: string | null) {
    this.record("completeOAuth", directory, integrationID, attemptID, code);
    this.fail("completeOAuth");
  }
  async cancelOAuth(directory: string, integrationID: string, attemptID: string) {
    this.record("cancelOAuth", directory, integrationID, attemptID);
  }
  async connectExternal(directory: string, integrationID: string, methodID: string, answer?: FormAnswer) {
    this.record("connectExternal", directory, integrationID, methodID, answer);
    this.fail("connectExternal");
  }
  async removeCredential(credentialID: string) {
    this.record("removeCredential", credentialID);
    this.fail("removeCredential");
  }
  /** What `generateText` answers; an Error is thrown instead. */
  generated: string | Error = "Fix: a change";
  async generateText(prompt: string, model?: ModelRef) {
    this.record("generateText", prompt, model);
    if (this.generated instanceof Error) throw this.generated;
    return this.generated;
  }
  async reloadConfig() {
    this.record("reloadConfig");
    this.fail("reloadConfig");
  }
  async listSessions(directory: string, limit: number, archived = false) {
    if (archived) this.record("listSessions", directory, limit, true);
    else this.record("listSessions", directory, limit);
    return this.sessions.filter((s) => !!s.archived === archived);
  }
  subagentOptions: AgentOption[] = [
    { id: "explore", name: "Explore", description: "Reads and searches the code." },
    { id: "general", name: "General" },
  ];
  async listSubagents(directory: string) {
    this.record("listSubagents", directory);
    return this.subagentOptions;
  }
  /**
   * What `GET /api/agent` lists in full; a function is asked on each call (to model an
   * agent that appears or goes once OpenCode notices its file).
   */
  agentDetails: AgentDetail[] | (() => AgentDetail[]) = [];
  async listAgentDetails(directory: string) {
    this.record("listAgentDetails", directory);
    this.fail("listAgentDetails");
    return typeof this.agentDetails === "function" ? this.agentDetails() : this.agentDetails;
  }
  config: ConfigSources = { directories: [], documentAgents: {} };
  async configSources(directory: string) {
    this.record("configSources", directory);
    this.fail("configSources");
    return this.config;
  }
  skills: SkillOption[] = [{ id: "review", name: "Review", description: "Reviews a change." }];
  async listSkills(directory: string) {
    this.record("listSkills", directory);
    return this.skills;
  }
  files: FoundFile[] = [
    { path: "src", type: "directory" },
    { path: "src/auth.ts", type: "file" },
    { path: "README.md", type: "file" },
  ];
  async findFiles(directory: string, query: string, limit: number) {
    this.record("findFiles", directory, query, limit);
    if (!query) return [];
    return this.files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }
  forkError: Error | null = null;
  deleteError: Error | null = null;
  promptError: Error | null = null;
  /** When set, `forkSession` waits for it (to close an aside while its copy is made). */
  forkGate: Promise<void> | null = null;
  async forkSession(id: string, before?: string): Promise<SessionSummary> {
    if (before) this.record("forkSession", id, before);
    else this.record("forkSession", id);
    if (this.forkGate) await this.forkGate;
    if (this.forkError) throw this.forkError;
    const from = this.sessions.find((x) => x.id === id);
    const s: SessionSummary = {
      id: `ses_${++this.counter}`,
      title: from?.title ?? "Fork",
      created: 3,
      updated: 3,
      agent: from?.agent ?? null,
      modelKey: from?.modelKey ?? null,
      variant: null,
      outcome: null,
      cost: 0,
      forked: true,
    };
    this.sessions.unshift(s);
    return s;
  }
  async setArchived(id: string, archived: boolean) {
    this.record("setArchived", id, archived);
    for (const x of this.sessions) if (x.id === id) x.archived = archived || undefined;
  }
  async deleteSession(id: string) {
    this.record("deleteSession", id);
    if (this.deleteError) throw this.deleteError;
    this.sessions = this.sessions.filter((x) => x.id !== id);
  }
  /** `GET /api/session/{id}/context` messages by session. */
  contexts = new Map<string, unknown[]>();
  async sessionContext(id: string) {
    this.record("sessionContext", id);
    return this.contexts.get(id) ?? [];
  }
  quota: QuotaView | null = null;
  quotaError: Error | null = null;
  async usageLimits(directory: string) {
    this.record("usageLimits", directory);
    if (this.quotaError) throw this.quotaError;
    return this.quota;
  }
  stats: UsageStats = { sessions: 0, steps: 0, cost: 0, tokens: 0, models: [] };
  async usageStats(range: { from: number; projectID?: string | null }) {
    this.record("usageStats", range);
    return this.stats;
  }
  mcp: McpServerInfo[] = [];
  async listMcpServers(directory: string) {
    this.record("listMcpServers", directory);
    return this.mcp;
  }
  /** States a server takes, in turn, after `connectMcp` (the last one stays); default connected. */
  mcpAfterConnect: Array<McpServerInfo["status"]> = [];
  private mcpServer(name: string) {
    const m = this.mcp.find((x) => x.name === name);
    if (!m) throw new OpenCodeHttpError(404, "McpServerNotFoundError", `MCP server not found: ${name}`);
    return m;
  }
  async connectMcp(directory: string, name: string) {
    this.record("connectMcp", directory, name);
    this.fail("connectMcp");
    const m = this.mcpServer(name);
    const next =
      this.mcpAfterConnect.length > 1
        ? this.mcpAfterConnect.shift()!
        : (this.mcpAfterConnect[0] ?? "connected");
    this.mcp = this.mcp.map((x) =>
      x === m
        ? {
            name: m.name,
            ...(m.title ? { title: m.title } : {}),
            status: next,
            ...(m.integrationID ? { integrationID: m.integrationID } : {}),
          }
        : x,
    );
  }
  async disconnectMcp(directory: string, name: string) {
    this.record("disconnectMcp", directory, name);
    const m = this.mcpServer(name);
    this.mcp = this.mcp.map((x) => (x === m ? { name: m.name, status: "disabled" as const } : x));
  }
  async addMcp(directory: string, name: string, config: McpConfig) {
    this.record("addMcp", directory, name, config);
    this.fail("addMcp");
    this.mcp = [...this.mcp.filter((x) => x.name !== name), { name, status: "connected" }];
  }
  async removeMcp(directory: string, name: string) {
    this.record("removeMcp", directory, name);
    this.mcpServer(name);
    this.mcp = this.mcp.filter((x) => x.name !== name);
  }
  /** "Always allow" rules by project; `projects` maps a folder to its project. */
  projects = new Map<string, string>();
  saved: Array<SavedPermission & { projectID: string }> = [];
  /** Goals by session; `goalFailures` calls fail first (the plugin's RPC not loaded yet). */
  goals = new Map<string, GoalState | null>();
  goalFailures = 0;
  async getGoal(directory: string, sessionID: string) {
    this.record("getGoal", directory, sessionID);
    if (this.goalFailures > 0) {
      this.goalFailures--;
      throw new OpenCodeHttpError(400, "RpcError", "RPC is unavailable: opencode.goal");
    }
    return this.goals.get(sessionID) ?? null;
  }
  /** Project folders by folder; the folder itself when not set. */
  projectDirs = new Map<string, string>();
  async projectDirectory(directory: string) {
    this.record("projectDirectory", directory);
    return this.projectDirs.get(directory) ?? directory;
  }
  async projectId(directory: string) {
    this.record("projectId", directory);
    return this.projects.get(directory) ?? null;
  }
  async listSavedPermissions(projectID: string) {
    this.record("listSavedPermissions", projectID);
    return this.saved
      .filter((x) => x.projectID === projectID)
      .map(({ projectID: _p, ...rest }) => rest)
      .sort((a, b) => b.created - a.created);
  }
  async removeSavedPermission(id: string) {
    this.record("removeSavedPermission", id);
    const before = this.saved.length;
    this.saved = this.saved.filter((x) => x.id !== id);
    if (this.saved.length === before)
      throw new OpenCodeHttpError(404, "PermissionSavedNotFoundError", "not found");
  }
  async updateSavedPermission(id: string, change: { action?: string; resource?: string }) {
    this.record("updateSavedPermission", id, change);
    const x = this.saved.find((r) => r.id === id);
    if (!x) throw new OpenCodeHttpError(404, "PermissionSavedNotFoundError", "not found");
    const action = change.action ?? x.action;
    const resource = change.resource ?? x.resource;
    // Like OpenCode: a project has each action and pattern once.
    if (
      this.saved.some(
        (r) => r !== x && r.projectID === x.projectID && r.action === action && r.resource === resource,
      )
    )
      throw new OpenCodeHttpError(409, "PermissionSavedConflictError", "conflict");
    x.action = action;
    x.resource = resource;
    return { id: x.id, action, resource, created: x.created };
  }
  /** Fails `setSessionPermissions` when set. */
  permissionsError: Error | null = null;
  async setSessionPermissions(id: string, rules: PermissionRule[]) {
    this.record("setSessionPermissions", id, rules);
    if (this.permissionsError) throw this.permissionsError;
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new OpenCodeHttpError(404, "NotFound", "Session not found");
    s.permissions = rules.map((r) => ({ ...r }));
  }
  /** Agent permission rules by agent id, as `GET /api/agent` reports them. */
  rules: Record<string, PermissionRule[]> = {
    build: [{ action: "*", resource: "*", effect: "allow" }],
    plan: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ],
  };
  async agentRules(directory: string) {
    this.record("agentRules", directory);
    return this.rules;
  }
  /** What an "always" reply saves (by request id), as OpenCode does from the request's save patterns. */
  onAlways: ((requestId: string) => void) | null = null;
  async resolveRevert(id: string, action: "commit" | "clear") {
    this.record("resolveRevert", id, action);
    for (const x of this.sessions) if (x.id === id) x.revert = null;
  }
  /** When set, `getSession` waits for it (to test what happens while a session loads). */
  sessionGate: Promise<void> | null = null;
  async getSession(id: string): Promise<SessionSummary> {
    if (this.sessionGate) await this.sessionGate;
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new OpenCodeHttpError(404, "NotFound", "Session not found");
    return s;
  }
  /** Subagent (child) session IDs by parent session ID; summaries come from `sessions` when present. */
  children = new Map<string, string[]>();
  async listChildSessions(id: string): Promise<SessionSummary[]> {
    this.record("listChildSessions", id);
    return (this.children.get(id) ?? []).map(
      (child) =>
        this.sessions.find((s) => s.id === child) ?? {
          id: child,
          title: "Subagent",
          created: 1,
          updated: 2,
          agent: "explore",
          modelKey: null,
          variant: null,
          outcome: null,
          cost: null,
        },
    );
  }
  async createSession(input: {
    directory: string;
    agent?: string;
    model?: { providerID: string; id: string; variant?: string };
    permissions?: PermissionRule[];
  }) {
    this.record("createSession", input);
    const s: SessionSummary = {
      id: `ses_${++this.counter}`,
      title: "New session",
      created: 1,
      updated: 1,
      agent: input.agent ?? null,
      modelKey: input.model ? `${input.model.providerID}/${input.model.id}` : null,
      outcome: null,
      variant: input.model?.variant ?? null,
      cost: 0,
      ...(input.permissions ? { permissions: input.permissions.map((r) => ({ ...r })) } : {}),
    };
    this.sessions.unshift(s);
    return s;
  }
  /** History by session, for subagent sessions; other sessions use `messages`. */
  messagesBySession = new Map<string, unknown[]>();
  async listMessages(id: string) {
    this.record("listMessages", id);
    return this.messagesBySession.get(id) ?? this.messages;
  }
  async listHistory(id: string, max: number) {
    const all = await this.listMessages(id);
    return { messages: all.slice(-max), more: all.length > max };
  }
  async prompt(id: string, input: PromptInput) {
    this.record("prompt", id, input);
    if (this.promptError) throw this.promptError;
    return { id: `msg_${++this.counter}` };
  }
  async switchModel(id: string, model: { providerID: string; id: string; variant?: string }) {
    this.record("switchModel", id, model);
  }
  async switchAgent(id: string, agent: string) {
    this.record("switchAgent", id, agent);
  }
  async activeSessions() {
    return new Set(this.active);
  }
  async interrupt(id: string) {
    this.record("interrupt", id);
    return this.interruptResult;
  }
  async listPermissions(id: string) {
    this.record("listPermissions", id);
    return this.permissions.filter((p) => p.sessionID === id);
  }
  commands: Array<{ name: string; description: string | null }> = [
    { name: "init", description: "create AGENTS.md" },
    { name: "review", description: "review changes" },
  ];
  async listCommands(directory: string) {
    this.record("listCommands", directory);
    return this.commands;
  }
  async runCommand(id: string, name: string, text: string, delivery?: "steer" | "queue") {
    if (delivery) this.record("runCommand", id, name, text, delivery);
    else this.record("runCommand", id, name, text);
  }
  async compact(id: string) {
    this.record("compact", id);
  }
  async runShell(id: string, command: string) {
    this.record("runShell", id, command);
  }

  async renameSession(id: string, title: string) {
    this.record("renameSession", id, title);
    // Like OpenCode: later listings return the new title.
    for (const x of this.sessions) if (x.id === id) x.title = title;
  }

  async revert(id: string, messageID: string, files: boolean) {
    this.record("revert", id, messageID, files);
  }

  async replyPermission(id: string, requestId: string, decision: PermissionDecision, message?: string) {
    if (message) this.record("replyPermission", id, requestId, decision, message);
    else this.record("replyPermission", id, requestId, decision);
    if (this.replyError) throw this.replyError;
    if (decision === "always") this.onAlways?.(requestId);
  }
  async sessionDiff(id: string, range?: { from?: string; to?: string; full?: boolean }) {
    this.record("sessionDiff", id, range);
    if (this.diffError) throw this.diffError;
    return this.diff;
  }
  forms: FormRequest[] = [];
  inbox: PendingInboxItem[] = [];
  formReplyError: Error | null = null;
  inboxCancelError: Error | null = null;
  diffError: Error | null = null;
  firstTexts = new Map<string, string>();

  async listForms(id: string) {
    this.record("listForms", id);
    return this.forms.filter((f) => f.sessionID === id);
  }
  async replyForm(id: string, formId: string, answer: FormAnswer) {
    this.record("replyForm", id, formId, answer);
    if (this.formReplyError) throw this.formReplyError;
  }
  async cancelForm(id: string, formId: string) {
    this.record("cancelForm", id, formId);
  }
  async listInbox(id: string) {
    this.record("listInbox", id);
    return this.inbox;
  }
  async setInboxDelivery(id: string, inboxId: string, delivery: "steer" | "queue") {
    this.record("setInboxDelivery", id, inboxId, delivery);
  }
  async cancelInbox(id: string, inboxId: string) {
    this.record("cancelInbox", id, inboxId);
    if (this.inboxCancelError) throw this.inboxCancelError;
  }
  async firstUserText(id: string) {
    this.record("firstUserText", id);
    return this.firstTexts.get(id) ?? null;
  }

  subscribe(_handlers: EventHandlers): EventSubscription {
    return { dispose() {} };
  }
}

export class MemoryStore {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown) {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}
