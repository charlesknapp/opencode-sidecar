import type {
  EventHandlers,
  EventSubscription,
  FileDiffInfo,
  FoundFile,
  OpenCodeClient,
  PromptInput,
  ServerInfo,
} from "../src/opencode/client";
import { OpenCodeHttpError } from "../src/opencode/client";
import type {
  AccountStatus,
  AgentOption,
  FormAnswer,
  FormRequest,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  McpServerInfo,
  PermissionRequest,
  SavedPermission,
  SessionSummary,
  SkillOption,
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
  async forkSession(id: string, before?: string): Promise<SessionSummary> {
    if (before) this.record("forkSession", id, before);
    else this.record("forkSession", id);
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
    this.sessions = this.sessions.filter((x) => x.id !== id);
  }
  mcp: McpServerInfo[] = [];
  async listMcpServers(directory: string) {
    this.record("listMcpServers", directory);
    return this.mcp;
  }
  /** "Always allow" rules by project; `projects` maps a folder to its project. */
  projects = new Map<string, string>();
  saved: Array<SavedPermission & { projectID: string }> = [];
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
  async prompt(id: string, input: PromptInput) {
    this.record("prompt", id, input);
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
