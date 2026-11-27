// OpenCode integration adapter. The UI talks only to the `OpenCodeClient`
// interface; `HttpOpenCodeClient` implements it on top of the OpenCode v2 HTTP
// API (the same surface used by the official `opencode` CLI and clients).

import { parseForm } from "../core/forms";
import type {
  CommandInfo,
  AccountStatus,
  AgentOption,
  FormAnswer,
  FormRequest,
  InboxDelivery,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  McpServerInfo,
  PermissionRequest,
  QuotaMeter,
  QuotaView,
  SavedPermission,
  SessionSummary,
  SkillOption,
  UsageStats,
} from "../shared/model";
import type { PromptPayload } from "../core/context";
import { parseIntegration, parseProvider, type IntegrationInfo, type ProviderEntry } from "../core/providers";
import { parseRules, type PermissionRule } from "../shared/approval";
import { modelKey, toPermissionRequest } from "./events";
import { SseParser } from "./sse";

export interface Endpoint {
  url: string;
  /** Value of the Authorization header, if the server requires one. Never logged. */
  authorization?: string;
}

export interface ServerInfo {
  version: string;
  pid: number | null;
}

export interface ModelRef {
  providerID: string;
  id: string;
  /** Model variant (e.g. reasoning effort); omitted = model default. */
  variant?: string;
}

export interface FileDiffInfo {
  file: string;
  /** Unified patch; full-file when requested with `full: true`. */
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

/** OpenCode's prompt input: text, file attachments, `@` mentions and delivery. */
export type PromptInput = PromptPayload & { delivery?: InboxDelivery };

export interface FoundFile {
  path: string;
  type: "file" | "directory";
}

/** An OAuth sign-in OpenCode started: the page to open and how it finishes. */
export interface OAuthAttempt {
  attemptID: string;
  url: string;
  /** What to tell the user (a device code to enter, …). */
  instructions: string;
  /** auto: OpenCode notices when it is done; code: the user pastes a code from the page. */
  mode: "auto" | "code";
  /** auto: the redirect URL can also be pasted, when the browser cannot reach OpenCode. */
  paste: boolean;
  /** When the attempt expires (epoch ms), if OpenCode says. */
  expires: number | null;
}

export interface OAuthStatus {
  status: "pending" | "complete" | "failed" | "expired";
  message: string | null;
}

export interface EventSubscription {
  dispose(): void;
}

export interface EventHandlers {
  onEvent(raw: unknown): void;
  onOpen(): void;
  onClose(error: string | null): void;
}

export interface OpenCodeClient {
  readonly url: string;
  info(): Promise<ServerInfo>;
  listModels(directory: string): Promise<ModelOption[]>;
  defaultModel(directory: string): Promise<string | null>;
  listAgents(directory: string): Promise<AgentOption[]>;
  /** Subagents (not hidden), which a prompt can mention as `@name`. */
  listSubagents(directory: string): Promise<AgentOption[]>;
  /** OpenCode's skills for a folder. */
  listSkills(directory: string): Promise<SkillOption[]>;
  /** Files and folders matching `query`, ranked by OpenCode (paths relative to the folder). */
  findFiles(directory: string, query: string, limit: number): Promise<FoundFile[]>;
  /** OpenCode's slash commands for a folder. */
  listCommands(directory: string): Promise<CommandInfo[]>;
  /** Runs a slash command in a session (its arguments as `text`). */
  runCommand(id: string, name: string, text: string, delivery?: InboxDelivery): Promise<void>;
  /** Asks OpenCode to compact the session's context. */
  compact(id: string): Promise<void>;
  /** Runs one shell command in the session's working directory (`!command`). */
  runShell(id: string, command: string): Promise<void>;
  /** Connection states from OpenCode's integration list; never labels or credentials. */
  accountStatus(directory: string): Promise<AccountStatus>;
  /** OpenCode's integrations: each provider's sign-in methods and connection states, no credentials. */
  listIntegrations(directory: string): Promise<IntegrationInfo[]>;
  /** One integration (404 `IntegrationNotFoundError` for an unknown id). */
  getIntegration(directory: string, id: string): Promise<IntegrationInfo>;
  /** Active providers, without their settings, headers or body (they can hold keys). */
  listProviders(directory: string): Promise<ProviderEntry[]>;
  /** Hands an API key to OpenCode, which checks and stores it. Sidecar keeps no copy. */
  connectKey(directory: string, integrationID: string, key: string, answer?: FormAnswer): Promise<void>;
  /** Starts an OAuth sign-in; the user finishes it in the browser. */
  startOAuth(
    directory: string,
    integrationID: string,
    methodID: string,
    answer?: FormAnswer,
  ): Promise<OAuthAttempt>;
  oauthStatus(directory: string, integrationID: string, attemptID: string): Promise<OAuthStatus>;
  /** Finishes a code sign-in with the code (or, for `paste`, the redirect URL) from the browser. */
  completeOAuth(
    directory: string,
    integrationID: string,
    attemptID: string,
    code: string | null,
  ): Promise<void>;
  cancelOAuth(directory: string, integrationID: string, attemptID: string): Promise<void>;
  /** Connects through credentials OpenCode finds itself (an AWS profile, …). */
  connectExternal(
    directory: string,
    integrationID: string,
    methodID: string,
    answer?: FormAnswer,
  ): Promise<void>;
  /** Removes a stored credential (Disconnect). */
  removeCredential(credentialID: string): Promise<void>;
  /** Rebuilds every loaded location, so config changes apply (`POST /api/location/reload`). */
  reloadConfig(): Promise<void>;
  /**
   * One stateless generation (no session, nothing stored): the model's text. Without
   * `model`, OpenCode's default model.
   */
  generateText(prompt: string, model?: ModelRef): Promise<string>;
  /** Root sessions of a folder: active ones, or with `archived` the archived ones. */
  listSessions(directory: string, limit: number, archived?: boolean): Promise<SessionSummary[]>;
  /** Copies a session into a new one: the history before `before`, or all of it. */
  forkSession(id: string, before?: string): Promise<SessionSummary>;
  setArchived(id: string, archived: boolean): Promise<void>;
  /** Deletes a session and its history from OpenCode (cannot be undone). */
  deleteSession(id: string): Promise<void>;
  /** The MCP servers configured for a folder and their state. */
  listMcpServers(directory: string): Promise<McpServerInfo[]>;
  /** OpenCode's project for a folder (the scope of its saved permissions). */
  projectId(directory: string): Promise<string | null>;
  /** "Always allow" rules OpenCode saved for a project. */
  listSavedPermissions(projectID: string): Promise<SavedPermission[]>;
  removeSavedPermission(id: string): Promise<void>;
  /** Changes a saved rule's action or pattern (409 when the project already has that rule). */
  updateSavedPermission(id: string, change: { action?: string; resource?: string }): Promise<SavedPermission>;
  /** Replaces a session's own permission rules (checked after the agent's; inherited by new subagents). */
  setSessionPermissions(id: string, rules: PermissionRule[]): Promise<void>;
  /** Every agent's permission rules for a folder, by agent id (subagents included). */
  agentRules(directory: string): Promise<Record<string, PermissionRule[]>>;
  /** Applies a staged rewind (`commit`) or restores the messages it hid (`clear`). */
  resolveRevert(id: string, action: "commit" | "clear"): Promise<void>;
  getSession(id: string): Promise<SessionSummary>;
  /** Sessions a session started as subagents (its direct children). */
  listChildSessions(id: string): Promise<SessionSummary[]>;
  createSession(input: {
    directory: string;
    agent?: string;
    model?: ModelRef;
    permissions?: PermissionRule[];
  }): Promise<SessionSummary>;
  listMessages(id: string, max: number): Promise<unknown[]>;
  /** The messages that make up the session's context now (after its last compaction), raw. */
  sessionContext(id: string): Promise<unknown[]>;
  /** OpenCode Go and Console limits of the signed-in OpenCode workspace; null when none. */
  usageLimits(directory: string): Promise<QuotaView | null>;
  /** Usage since `from` (epoch ms), for one project when `projectID` is given. */
  usageStats(range: { from: number; projectID?: string | null }): Promise<UsageStats>;
  prompt(id: string, input: PromptInput): Promise<{ id: string }>;
  switchModel(id: string, model: ModelRef): Promise<void>;
  switchAgent(id: string, agent: string): Promise<void>;
  /** Ids of sessions that are currently executing. */
  activeSessions(): Promise<Set<string>>;
  /** Cancels the running execution. Resolves to whether anything was interrupted. */
  interrupt(id: string): Promise<boolean>;
  /** Rewinds to just before `messageID` (stage + commit); `files` also restores the files. */
  revert(id: string, messageID: string, files: boolean): Promise<void>;
  /** Renames a session (OpenCode `session.update`). */
  renameSession(id: string, title: string): Promise<void>;
  listPermissions(id: string): Promise<PermissionRequest[]>;
  /** `message` goes with a rejection: OpenCode hands it to the agent as what to do instead. */
  replyPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    message?: string,
  ): Promise<void>;
  /**
   * Agent changes recorded by OpenCode snapshots. With `from`/`to` (user message ids) the
   * range spans several turns; `full` requests full-file patches.
   */
  sessionDiff(id: string, range?: { from?: string; to?: string; full?: boolean }): Promise<FileDiffInfo[]>;
  listForms(id: string): Promise<FormRequest[]>;
  replyForm(id: string, formId: string, answer: FormAnswer): Promise<void>;
  cancelForm(id: string, formId: string): Promise<void>;
  listInbox(id: string): Promise<PendingInboxItem[]>;
  cancelInbox(id: string, inboxId: string): Promise<void>;
  /** Switches a waiting message between steer (next step) and queue (after the task). */
  setInboxDelivery(id: string, inboxId: string, delivery: InboxDelivery): Promise<void>;
  /** Text of the first user message, used for local title fallbacks. */
  firstUserText(id: string): Promise<string | null>;
  subscribe(handlers: EventHandlers): EventSubscription;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const money = (v: number) => `$${v.toFixed(2)}`;

/**
 * OpenCode's `UsageLimits.Info`: the OpenCode Go allowance (rolling, weekly and monthly
 * windows, each a share used and a reset time) and the Console budgets (dollars spent of
 * a limit). Null when OpenCode is not signed in to an OpenCode workspace, which is the
 * case for every other provider: they report no quotas.
 */
export function parseUsageLimits(raw: unknown): QuotaView | null {
  if (!raw || typeof raw !== "object") return null;
  const d = rec(raw);
  const meters: QuotaMeter[] = [];
  const go = rec(d.go);
  for (const [key, label] of [
    ["rolling", "Go · rolling"],
    ["weekly", "Go · weekly"],
    ["monthly", "Go · monthly"],
  ] as const) {
    const m = rec(go[key]);
    const percent = num(m.percent);
    if (percent === null) continue;
    meters.push({
      id: `go:${key}`,
      label,
      percent: Math.min(100, Math.max(0, percent)),
      used: null,
      limited: m.limited === true,
      resetsAt: num(m.resetsAt),
    });
  }
  for (const b of Array.isArray(d.budgets) ? d.budgets : []) {
    const x = rec(b);
    const limit = num(x.limit);
    const spent = num(x.spent);
    if (limit === null || spent === null || limit <= 0) continue;
    const models = (Array.isArray(x.models) ? x.models : []).map((m) => str(rec(m).name)).filter(Boolean);
    const what = x.coverage === "models" && models.length ? models.join(", ") : "all models";
    meters.push({
      id: `budget:${str(x.id) ?? meters.length}`,
      label: `Budget · ${what}${x.scope === "each" ? " (you)" : ""}`,
      percent: Math.min(100, Math.max(0, (spent / limit) * 100)),
      used: `${money(spent)} / ${money(limit)}`,
      limited: spent >= limit,
      resetsAt: num(x.resetsAt),
    });
  }
  const workspace = rec(d.workspace);
  return { workspace: str(workspace.name) ?? null, meters };
}

/** OpenCode's `SessionStats.Info`, reduced to what the usage menu shows. */
export function parseUsageStats(raw: unknown): UsageStats {
  const d = rec(raw);
  const generated = (t: unknown) => (num(rec(t).output) ?? 0) + (num(rec(t).reasoning) ?? 0);
  const models: UsageStats["models"] = [];
  for (const m of Array.isArray(d.models) ? d.models : []) {
    const x = rec(m);
    const key = modelKey(x.model);
    if (!key) continue;
    // OpenCode lists each variant of a model on its own row.
    const row = models.find((r) => r.modelKey === key);
    if (row) {
      row.steps += num(x.steps) ?? 0;
      row.cost += num(x.cost) ?? 0;
    } else models.push({ modelKey: key, steps: num(x.steps) ?? 0, cost: num(x.cost) ?? 0 });
  }
  return {
    sessions: num(d.sessions) ?? 0,
    steps: num(d.steps) ?? 0,
    cost: num(d.cost) ?? 0,
    tokens: generated(d.tokens),
    models,
  };
}

function modelBody(model: ModelRef): Rec {
  const body: Rec = { providerID: model.providerID, id: model.id };
  if (model.variant) body.variant = model.variant;
  return body;
}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | null,
    message: string,
    /** A provider error's `reason` (`rate_limit`, `authentication`, …), when OpenCode gives one. */
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

type FetchLike = typeof fetch;
type Rec = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;

const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A workspace path as OpenCode records it. VS Code reports Windows drive letters in
 * lower case (`c:\repo`) while OpenCode's CLI and TUI record `C:\repo`, and OpenCode
 * compares directories case-sensitively, so the drive letter is upper-cased.
 */
export function opencodeDirectory(directory: string): string {
  return directory.replace(/^([a-z]):(?=[\\/]|$)/, (_, d: string) => `${d.toUpperCase()}:`);
}

/** Whether two workspace paths name the same folder as far as OpenCode is concerned. */
export function sameDirectory(a: string | null, b: string | null): boolean {
  return a === b || (a !== null && b !== null && opencodeDirectory(a) === opencodeDirectory(b));
}

function toSaved(raw: unknown): SavedPermission | null {
  const x = rec(raw);
  if (typeof x.id !== "string") return null;
  return {
    id: x.id,
    action: typeof x.action === "string" ? x.action : "",
    resource: typeof x.resource === "string" ? x.resource : "",
    created: typeof rec(x.time).created === "number" ? (rec(x.time).created as number) : 0,
  };
}

/** An agent's or skill's first sentence, for one-line lists. */
function firstSentence(v: unknown): string | undefined {
  return str(v)
    ?.split(/(?<=\.)\s/)[0]
    ?.slice(0, 160);
}

export function toSessionSummary(raw: unknown): SessionSummary {
  const d = rec(raw);
  const time = rec(d.time);
  const outcome = d.outcome;
  const revert = rec(d.revert);
  const revertID = str(revert.messageID);
  const extra: Partial<SessionSummary> = {};
  if (d.fork && typeof d.fork === "object") extra.forked = true;
  if (typeof time.archived === "number") extra.archived = true;
  // OpenCode leaves `permissions` out until a client sets some.
  if (Array.isArray(d.permissions)) extra.permissions = parseRules(d.permissions);
  if (revertID)
    extra.revert = { messageID: revertID, files: Array.isArray(revert.files) ? revert.files.length : 0 };
  return {
    ...extra,
    id: str(d.id) ?? "",
    title: str(d.title) ?? "Untitled session",
    created: typeof time.created === "number" ? time.created : 0,
    updated: typeof time.updated === "number" ? time.updated : 0,
    agent: str(d.agent),
    modelKey: modelKey(d.model),
    variant: str(rec(d.model).variant),
    outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : null,
    cost: typeof d.cost === "number" ? d.cost : null,
  };
}

/** OpenCode's integration id for the OpenCode Console account (`opencode auth login opencode`). */
export const OPENCODE_INTEGRATION = "opencode";

/**
 * Reduces `GET /api/integration` to connection states. Only `id`, `connections[].type` and
 * `connections[].status.status` are read; labels, metadata and methods are ignored.
 */
export function parseAccountStatus(list: unknown): AccountStatus {
  let opencode: AccountStatus["opencode"] = "none";
  let otherProviders = false;
  if (!Array.isArray(list)) throw new Error("Unexpected integration list");
  for (const raw of list) {
    const i = rec(raw);
    const connections = Array.isArray(i.connections) ? i.connections : [];
    const states = connections
      .map((c) => rec(c))
      .filter((c) => c.type === "credential" || c.type === "env")
      .map((c) => (rec(c.status).status === "needs_auth" ? "needs-auth" : "ok"));
    if (states.length === 0) continue;
    if (i.id === OPENCODE_INTEGRATION) opencode = states.includes("ok") ? "connected" : "needs-auth";
    else if (states.includes("ok")) otherProviders = true;
  }
  return { opencode, otherProviders };
}

/** Projects a model record onto the fields the UI needs (drops headers/body/settings, which may hold secrets). */
function acceptsImages(model: Rec): boolean {
  const input = rec(model.capabilities).input;
  return Array.isArray(input) && input.includes("image");
}

export function toModelOption(raw: unknown, providerNames: Map<string, string>): ModelOption | null {
  const d = rec(raw);
  const providerID = str(d.providerID);
  const id = str(d.id);
  if (!providerID || !id || d.enabled === false) return null;
  const limit = rec(d.limit);
  return {
    key: `${providerID}/${id}`,
    providerID,
    id,
    name: str(d.name) ?? id,
    variants: Array.isArray(d.variants)
      ? d.variants.map((v) => str(rec(v).id)).filter((v): v is string => !!v && v !== "default")
      : [],
    providerName: providerNames.get(providerID) ?? providerID,
    contextLimit: typeof limit.context === "number" && limit.context > 0 ? limit.context : null,
    ...(acceptsImages(d) ? { images: true } : {}),
  };
}

export class HttpOpenCodeClient implements OpenCodeClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly endpoint: Endpoint,
    fetchImpl?: FetchLike,
    private readonly reconnectDelays: number[] = [500, 1000, 2000, 5000, 10000],
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  get url(): string {
    return this.endpoint.url;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (json) h["content-type"] = "application/json";
    if (this.endpoint.authorization) h.authorization = this.endpoint.authorization;
    return h;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.endpoint.url);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const res = await this.fetchImpl(this.buildUrl(path, options.query), {
      method,
      headers: this.headers(options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204) return undefined;
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const body = rec(json);
      throw new OpenCodeHttpError(
        res.status,
        str(body._tag),
        str(body.message) ?? `OpenCode request failed (${method} ${path}: HTTP ${res.status})`,
        str(body.reason),
      );
    }
    return json;
  }

  private loc(directory: string): Record<string, string> {
    return { "location[directory]": opencodeDirectory(directory) };
  }

  async info(): Promise<ServerInfo> {
    const d = rec(await this.request("GET", "/api/info", { timeoutMs: 5000 }));
    return { version: str(d.version) ?? "unknown", pid: typeof d.pid === "number" ? d.pid : null };
  }

  async listModels(directory: string): Promise<ModelOption[]> {
    const [models, providers] = await Promise.all([
      this.request("GET", "/api/model", { query: this.loc(directory) }),
      this.request("GET", "/api/provider", { query: this.loc(directory) }).catch(() => undefined),
    ]);
    const names = new Map<string, string>();
    const plist = rec(providers).data;
    if (Array.isArray(plist)) {
      for (const p of plist) {
        const id = str(rec(p).id);
        const name = str(rec(p).name);
        if (id && name) names.set(id, name);
      }
    }
    const list = rec(models).data;
    if (!Array.isArray(list)) return [];
    const out: ModelOption[] = [];
    for (const m of list) {
      const opt = toModelOption(m, names);
      if (opt) out.push(opt);
    }
    out.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));
    return out;
  }

  async defaultModel(directory: string): Promise<string | null> {
    const d = rec(await this.request("GET", "/api/model/default", { query: this.loc(directory) }));
    return modelKey(d.data);
  }

  async listAgents(directory: string): Promise<AgentOption[]> {
    const d = rec(await this.request("GET", "/api/agent", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: AgentOption[] = [];
    for (const a of list) {
      const r = rec(a);
      const id = str(r.id);
      // Only primary agents can drive a session; subagents and hidden agents are internal.
      if (!id || r.hidden === true || r.mode === "subagent") continue;
      const description = firstSentence(r.description);
      out.push(description ? { id, name: str(r.name) ?? id, description } : { id, name: str(r.name) ?? id });
    }
    return out;
  }

  async listSubagents(directory: string): Promise<AgentOption[]> {
    const d = rec(await this.request("GET", "/api/agent", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: AgentOption[] = [];
    for (const a of list) {
      const r = rec(a);
      const id = str(r.id);
      if (!id || r.hidden === true || r.mode === "primary") continue;
      const description = firstSentence(r.description);
      out.push(description ? { id, name: str(r.name) ?? id, description } : { id, name: str(r.name) ?? id });
    }
    return out;
  }

  async listSkills(directory: string): Promise<SkillOption[]> {
    const d = rec(await this.request("GET", "/api/skill", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: SkillOption[] = [];
    for (const k of list) {
      const r = rec(k);
      const id = str(r.id);
      if (!id) continue;
      // A skill's content and path stay with OpenCode; only what the list shows is kept.
      const description = firstSentence(r.description);
      out.push(description ? { id, name: str(r.name) ?? id, description } : { id, name: str(r.name) ?? id });
    }
    return out;
  }

  async findFiles(directory: string, query: string, limit: number): Promise<FoundFile[]> {
    const d = rec(
      await this.request("GET", "/api/fs/find", {
        query: { ...this.loc(directory), query, limit: String(limit) },
      }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    const out: FoundFile[] = [];
    for (const f of list) {
      const r = rec(f);
      // OpenCode reports folders with a trailing separator, in the platform's style.
      const p = str(r.path)?.replace(/\\/g, "/").replace(/\/+$/, "");
      if (p && (r.type === "file" || r.type === "directory")) out.push({ path: p, type: r.type });
    }
    return out;
  }

  async listCommands(directory: string): Promise<CommandInfo[]> {
    const raw = await this.request("GET", "/api/command", { query: this.loc(directory) });
    const list = Array.isArray(raw) ? raw : Array.isArray(rec(raw).data) ? (rec(raw).data as unknown[]) : [];
    const out: CommandInfo[] = [];
    for (const c of list) {
      const r = rec(c);
      const name = str(r.name);
      if (name) out.push({ name, description: str(r.description) });
    }
    return out;
  }

  async runCommand(id: string, name: string, text: string, delivery?: InboxDelivery): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/command`, {
      body: delivery ? { name, text, delivery } : { name, text },
    });
  }

  async compact(id: string): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/compact`, { body: {} });
  }

  async runShell(id: string, command: string): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/shell`, { body: { command } });
  }

  async accountStatus(directory: string): Promise<AccountStatus> {
    const d = rec(await this.request("GET", "/api/integration", { query: this.loc(directory) }));
    return parseAccountStatus(d.data);
  }

  async listIntegrations(directory: string): Promise<IntegrationInfo[]> {
    const d = rec(await this.request("GET", "/api/integration", { query: this.loc(directory) }));
    if (!Array.isArray(d.data)) throw new Error("Unexpected integration list");
    return d.data.map(parseIntegration).filter((i): i is IntegrationInfo => i !== null);
  }

  async getIntegration(directory: string, id: string): Promise<IntegrationInfo> {
    const d = rec(
      await this.request("GET", `/api/integration/${encodeURIComponent(id)}`, { query: this.loc(directory) }),
    );
    const info = parseIntegration(d.data);
    if (!info) throw new Error("Unexpected integration");
    return info;
  }

  async listProviders(directory: string): Promise<ProviderEntry[]> {
    const d = rec(await this.request("GET", "/api/provider", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(parseProvider).filter((p): p is ProviderEntry => p !== null);
  }

  private integrationPath(id: string, rest: string): string {
    return `/api/integration/${encodeURIComponent(id)}/connect/${rest}`;
  }

  async connectKey(
    directory: string,
    integrationID: string,
    key: string,
    answer?: FormAnswer,
  ): Promise<void> {
    await this.request("POST", this.integrationPath(integrationID, "key"), {
      query: this.loc(directory),
      body: answer ? { key, answer } : { key },
      timeoutMs: 60_000,
    });
  }

  async startOAuth(
    directory: string,
    integrationID: string,
    methodID: string,
    answer?: FormAnswer,
  ): Promise<OAuthAttempt> {
    const d = rec(
      await this.request("POST", this.integrationPath(integrationID, "oauth"), {
        query: this.loc(directory),
        body: answer ? { methodID, answer } : { methodID },
        timeoutMs: 60_000,
      }),
    );
    const a = rec(d.data);
    const attemptID = str(a.attemptID);
    const url = str(a.url);
    if (!attemptID || !url) throw new Error("OpenCode did not return a sign-in page");
    return {
      attemptID,
      url,
      instructions: str(a.instructions) ?? "",
      mode: a.mode === "code" ? "code" : "auto",
      paste: a.paste === true,
      expires: num(rec(a.time).expires),
    };
  }

  async oauthStatus(directory: string, integrationID: string, attemptID: string): Promise<OAuthStatus> {
    const d = rec(
      await this.request(
        "GET",
        this.integrationPath(integrationID, `oauth/${encodeURIComponent(attemptID)}`),
        {
          query: this.loc(directory),
        },
      ),
    );
    const a = rec(d.data);
    const status =
      a.status === "complete" || a.status === "failed" || a.status === "expired" ? a.status : "pending";
    return { status, message: str(a.message) };
  }

  async completeOAuth(
    directory: string,
    integrationID: string,
    attemptID: string,
    code: string | null,
  ): Promise<void> {
    await this.request(
      "POST",
      this.integrationPath(integrationID, `oauth/${encodeURIComponent(attemptID)}/complete`),
      { query: this.loc(directory), body: { code }, timeoutMs: 60_000 },
    );
  }

  async cancelOAuth(directory: string, integrationID: string, attemptID: string): Promise<void> {
    await this.request(
      "DELETE",
      this.integrationPath(integrationID, `oauth/${encodeURIComponent(attemptID)}`),
      {
        query: this.loc(directory),
      },
    );
  }

  async connectExternal(
    directory: string,
    integrationID: string,
    methodID: string,
    answer?: FormAnswer,
  ): Promise<void> {
    await this.request("POST", this.integrationPath(integrationID, "external"), {
      query: this.loc(directory),
      body: answer ? { methodID, answer } : { methodID },
      timeoutMs: 60_000,
    });
  }

  async removeCredential(credentialID: string): Promise<void> {
    await this.request("DELETE", `/api/credential/${encodeURIComponent(credentialID)}`);
  }

  async generateText(prompt: string, model?: ModelRef): Promise<string> {
    // A model call: allow as long as a slow free model may take to answer.
    const d = rec(
      await this.request("POST", "/api/experimental/generate/text", {
        body: model ? { prompt, model: modelBody(model) } : { prompt },
        timeoutMs: 120_000,
      }),
    );
    const text = str(rec(d.data).text);
    if (text === null) throw new Error("OpenCode returned no text.");
    return text;
  }

  async reloadConfig(): Promise<void> {
    // OpenCode answers once every location has been rebuilt. OpenCode 2.4.2 refuses (503)
    // while it has a folder loaded that was deleted since, and drops that folder as it does,
    // so a few more tries get past each such folder.
    for (let i = 0; ; i++) {
      try {
        await this.request("POST", "/api/location/reload", { timeoutMs: 120_000 });
        return;
      } catch (e) {
        const gone =
          e instanceof OpenCodeHttpError && e.status === 503 && /Directory not found/.test(e.message);
        if (!gone || i >= 4) throw e;
      }
    }
  }

  async listSessions(directory: string, limit: number, archived = false): Promise<SessionSummary[]> {
    const canonical = opencodeDirectory(directory);
    // Sessions Sidecar created before the drive letter was upper-cased are recorded
    // under the lower-case form; list both so none of them disappear.
    const legacy = canonical.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
    const [main, older] = await Promise.all([
      this.listSessionsIn(canonical, limit, archived),
      legacy !== canonical ? this.listSessionsIn(legacy, limit, archived).catch(() => []) : [],
    ]);
    if (!older.length) return main;
    const seen = new Set(main.map((x) => x.id));
    return [...main, ...older.filter((x) => !seen.has(x.id))]
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit);
  }

  private async listSessionsIn(
    directory: string,
    limit: number,
    archived: boolean,
  ): Promise<SessionSummary[]> {
    // OpenCode's list includes archived sessions unless asked; forks are root sessions too.
    const d = rec(
      await this.request("GET", "/api/session", {
        query: {
          directory,
          parentID: "null",
          archived: archived ? "true" : "false",
          limit: String(limit),
          order: "desc",
        },
      }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(toSessionSummary).filter((x) => x.id);
  }

  async getSession(id: string): Promise<SessionSummary> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}`));
    return toSessionSummary(d.data);
  }

  async listChildSessions(id: string): Promise<SessionSummary[]> {
    const d = rec(await this.request("GET", "/api/session", { query: { parentID: id, limit: "100" } }));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(toSessionSummary).filter((x) => x.id);
  }

  async createSession(input: {
    directory: string;
    agent?: string;
    model?: ModelRef;
    permissions?: PermissionRule[];
  }): Promise<SessionSummary> {
    const body: Rec = { location: { directory: opencodeDirectory(input.directory) } };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = modelBody(input.model);
    if (input.permissions?.length) body.permissions = input.permissions;
    const d = rec(await this.request("POST", "/api/session", { body }));
    return toSessionSummary(d.data);
  }

  async listMessages(id: string, max: number): Promise<unknown[]> {
    // Newest-first pages, then reversed, so very long sessions only load their tail.
    // OpenCode rejects `order` together with `cursor`; the cursor carries the order.
    const out: unknown[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const limit = Math.min(100, max - out.length);
      const query: Record<string, string | undefined> = cursor
        ? { cursor, limit: String(limit) }
        : { order: "desc", limit: String(limit) };
      const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/message`, { query }));
      const page = Array.isArray(d.data) ? d.data : [];
      out.push(...page);
      const next = str(rec(d.cursor).next);
      if (!next || page.length === 0) break;
      cursor = next;
    }
    return out.reverse();
  }

  async sessionContext(id: string): Promise<unknown[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/context`));
    return Array.isArray(d.data) ? d.data : [];
  }

  async usageLimits(directory: string): Promise<QuotaView | null> {
    const d = rec(
      await this.request("GET", "/api/experimental/usage/limits", { query: this.loc(directory) }),
    );
    return parseUsageLimits(d.data);
  }

  async usageStats(range: { from: number; projectID?: string | null }): Promise<UsageStats> {
    const query: Record<string, string | undefined> = { from: String(Math.floor(range.from)), tools: "none" };
    if (range.projectID) query.project = range.projectID;
    const d = rec(await this.request("GET", "/api/experimental/session/stats", { query }));
    return parseUsageStats(d.data);
  }

  async prompt(id: string, input: PromptInput): Promise<{ id: string }> {
    const body: Rec = { text: input.text };
    if (input.files.length) body.files = input.files;
    if (input.agents?.length) body.agents = input.agents;
    if (input.skills?.length) body.skills = input.skills;
    if (input.delivery) body.delivery = input.delivery;
    const d = rec(await this.request("POST", `/api/session/${encodeURIComponent(id)}/prompt`, { body }));
    return { id: str(rec(d.data).id) ?? "" };
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/model`, {
      body: { model: modelBody(model) },
    });
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/agent`, { body: { agent } });
  }

  async activeSessions(): Promise<Set<string>> {
    const d = rec(await this.request("GET", "/api/session/active"));
    return new Set(Object.keys(rec(d.data)));
  }

  async interrupt(id: string): Promise<boolean> {
    const d = rec(await this.request("POST", `/api/session/${encodeURIComponent(id)}/interrupt`));
    return d.interrupted === true;
  }

  /**
   * Rewinds a session to just before `messageID`: OpenCode stages a revert boundary
   * (optionally restoring the files it changed after that point), then commits it.
   */
  async revert(id: string, messageID: string, files: boolean): Promise<void> {
    const base = `/api/session/${encodeURIComponent(id)}/revert`;
    await this.request("POST", `${base}/stage`, { body: { messageID, files } });
    await this.request("POST", `${base}/commit`);
  }

  async forkSession(id: string, before?: string): Promise<SessionSummary> {
    const d = rec(
      await this.request("POST", `/api/session/${encodeURIComponent(id)}/fork`, {
        body: before ? { before } : {},
      }),
    );
    return toSessionSummary(d.data);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.request("PATCH", `/api/session/${encodeURIComponent(id)}`, { body: { archived } });
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/api/session/${encodeURIComponent(id)}`);
  }

  async listMcpServers(directory: string): Promise<McpServerInfo[]> {
    const d = rec(await this.request("GET", "/api/mcp", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    const states = new Set(["connected", "pending", "disabled", "failed", "needs_auth"]);
    const out: McpServerInfo[] = [];
    for (const raw of list) {
      const x = rec(raw);
      const st = rec(x.status);
      if (typeof x.name !== "string" || typeof st.status !== "string" || !states.has(st.status)) continue;
      out.push({
        name: x.name,
        ...(typeof x.title === "string" && x.title ? { title: x.title } : {}),
        status: st.status as McpServerInfo["status"],
        ...(typeof st.error === "string" && st.error ? { error: st.error } : {}),
      });
    }
    return out;
  }

  async projectId(directory: string): Promise<string | null> {
    const d = rec(await this.request("GET", "/api/location", { query: this.loc(directory) }));
    const id = rec(d.project).id;
    return typeof id === "string" && id ? id : null;
  }

  async listSavedPermissions(projectID: string): Promise<SavedPermission[]> {
    const d = rec(await this.request("GET", "/api/permission/saved", { query: { projectID } }));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: SavedPermission[] = [];
    for (const raw of list) {
      // Only this project's rules, whatever the server returns.
      const saved = rec(raw).projectID === projectID ? toSaved(raw) : null;
      if (saved) out.push(saved);
    }
    return out.sort((a, b) => b.created - a.created);
  }

  async removeSavedPermission(id: string): Promise<void> {
    await this.request("DELETE", `/api/permission/saved/${encodeURIComponent(id)}`);
  }

  async updateSavedPermission(
    id: string,
    change: { action?: string; resource?: string },
  ): Promise<SavedPermission> {
    const d = rec(
      await this.request("PATCH", `/api/permission/saved/${encodeURIComponent(id)}`, { body: change }),
    );
    const saved = toSaved(d.data);
    if (!saved) throw new Error("Unexpected saved permission");
    return saved;
  }

  async setSessionPermissions(id: string, rules: PermissionRule[]): Promise<void> {
    // The whole list is replaced; `null` would leave it as it is.
    await this.request("PATCH", `/api/session/${encodeURIComponent(id)}`, { body: { permissions: rules } });
  }

  async agentRules(directory: string): Promise<Record<string, PermissionRule[]>> {
    const d = rec(await this.request("GET", "/api/agent", { query: this.loc(directory) }));
    const out: Record<string, PermissionRule[]> = {};
    for (const a of Array.isArray(d.data) ? d.data : []) {
      const id = str(rec(a).id);
      if (id) out[id] = parseRules(rec(a).permissions);
    }
    return out;
  }

  async resolveRevert(id: string, action: "commit" | "clear"): Promise<void> {
    const base = `/api/session/${encodeURIComponent(id)}/revert`;
    if (action === "commit") await this.request("POST", `${base}/commit`);
    else await this.request("DELETE", base);
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.request("PATCH", `/api/session/${encodeURIComponent(id)}`, { body: { title } });
  }

  async listPermissions(id: string): Promise<PermissionRequest[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/permission`));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(toPermissionRequest).filter((p): p is PermissionRequest => p !== null);
  }

  async replyPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    message?: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: message ? { decision, message } : { decision } },
    );
  }

  async sessionDiff(
    id: string,
    range: { from?: string; to?: string; full?: boolean } = {},
  ): Promise<FileDiffInfo[]> {
    const query: Record<string, string | undefined> = { from: range.from, to: range.to };
    // Omitting `context` yields full-file patches; a small context keeps payloads light otherwise.
    if (!range.full) query.context = "3";
    const d = rec(
      await this.request("GET", `/api/session/${encodeURIComponent(id)}/diff`, { query, timeoutMs: 30_000 }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    const out: FileDiffInfo[] = [];
    for (const f of list) {
      const r = rec(f);
      const file = str(r.file);
      if (!file) continue;
      out.push({
        file,
        patch: str(r.patch) ?? "",
        additions: typeof r.additions === "number" ? r.additions : 0,
        deletions: typeof r.deletions === "number" ? r.deletions : 0,
        status: r.status === "added" || r.status === "deleted" ? r.status : "modified",
      });
    }
    return out;
  }

  async listForms(id: string): Promise<FormRequest[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/form`));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(parseForm).filter((f): f is FormRequest => f !== null);
  }

  async replyForm(id: string, formId: string, answer: FormAnswer): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formId)}/reply`,
      {
        body: { answer },
      },
    );
  }

  async cancelForm(id: string, formId: string): Promise<void> {
    await this.request("DELETE", `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formId)}`);
  }

  async listInbox(id: string): Promise<PendingInboxItem[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/inbox`));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: PendingInboxItem[] = [];
    for (const raw of list) {
      const r = rec(raw);
      const payload = rec(r.payload);
      const inboxId = str(r.id);
      if (r.type !== "user" || !inboxId) continue;
      const files = Array.isArray(payload.files) ? payload.files : [];
      out.push({
        id: inboxId,
        text: str(payload.text) ?? "",
        raw: str(payload.text) ?? "",
        attachments: files.map((f) => str(rec(f).name) ?? "file"),
        delivery: r.delivery === "queue" ? "queue" : "steer",
      });
    }
    return out;
  }

  async setInboxDelivery(id: string, inboxId: string, delivery: InboxDelivery): Promise<void> {
    await this.request(
      "PATCH",
      `/api/session/${encodeURIComponent(id)}/inbox/${encodeURIComponent(inboxId)}`,
      { body: { delivery } },
    );
  }

  async cancelInbox(id: string, inboxId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/session/${encodeURIComponent(id)}/inbox/${encodeURIComponent(inboxId)}`,
    );
  }

  async firstUserText(id: string): Promise<string | null> {
    // A fresh request without a cursor may use `order`.
    const d = rec(
      await this.request("GET", `/api/session/${encodeURIComponent(id)}/message`, {
        query: { order: "asc", limit: "10", type: "user" },
      }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    for (const m of list) if (rec(m).type === "user") return str(rec(m).text);
    return null;
  }

  /** Opens the global event stream and reconnects with backoff until disposed. */
  subscribe(handlers: EventHandlers): EventSubscription {
    let disposed = false;
    let controller: AbortController | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (disposed) return;
      controller = new AbortController();
      let error: string;
      try {
        const res = await this.fetchImpl(this.buildUrl("/api/event"), {
          headers: { ...this.headers(false), accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new OpenCodeHttpError(res.status, null, `Event stream failed: HTTP ${res.status}`);
        attempt = 0;
        handlers.onOpen();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            try {
              handlers.onEvent(JSON.parse(msg.data));
            } catch {
              // Ignore malformed frames; never surface raw payloads.
            }
          }
        }
        error = "Event stream closed";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (disposed) return;
      handlers.onClose(error);
      const delay = this.reconnectDelays[Math.min(attempt, this.reconnectDelays.length - 1)];
      attempt++;
      timer = setTimeout(() => void connect(), delay);
    };
    void connect();
    return {
      dispose: () => {
        disposed = true;
        if (timer) clearTimeout(timer);
        controller?.abort();
      },
    };
  }
}
