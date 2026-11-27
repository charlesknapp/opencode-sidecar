// Provider setup: OpenCode's integration list (how each provider can be connected and
// how it is) and provider list (which are active, and where they point), reduced to what
// the Providers panel and the setup check show. Pure, so it is tested without a server.
// Credentials are never read: OpenCode's integration list has none, and connection labels
// (which can hold an email address) are dropped on arrival like provider settings.

import type { FormField, ModelOption, ProviderChoice, ProviderRow, ProvidersView } from "../shared/model";
import { parseField } from "./forms";

export type MethodType = "oauth" | "key" | "command" | "external" | "env";

export interface IntegrationMethod {
  type: MethodType;
  /** OpenCode's method id (`methodID`); null for key and env methods, which have none. */
  id: string | null;
  label: string;
  /** env: the variables OpenCode reads. */
  envNames: string[];
  /** Questions OpenCode asks before it connects (a deployment type, an AWS profile, …). */
  fields: FormField[];
}

export interface IntegrationConnection {
  /** A stored credential (`credential`) or an environment variable OpenCode found (`env`). */
  kind: "credential" | "env";
  /** The credential's id, for Disconnect; null for an environment variable. */
  credentialID: string | null;
  method: "key" | "oauth" | "external" | "env";
  /** env: the variable's name (a name, never its value). */
  envName: string | null;
  /** OpenCode's note when the connection needs signing in again. */
  needsAuth: string | null;
}

export interface IntegrationInfo {
  id: string;
  name: string;
  methods: IntegrationMethod[];
  connections: IntegrationConnection[];
  /** An MCP server's sign-in (`metadata.source: "mcp"`): the MCP panel's, not a provider. */
  mcp?: true;
}

export interface ProviderEntry {
  id: string;
  name: string;
  /** The integration that holds its credentials; null for one set up only in the config. */
  integrationID: string | null;
  activation: "auto" | "enabled" | "disabled";
  /** `host:port` of an endpoint on this machine (Ollama, LM Studio, …); null otherwise. */
  localEndpoint: string | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const METHOD_TYPES: MethodType[] = ["oauth", "key", "command", "external", "env"];

function parseMethod(raw: unknown): IntegrationMethod | null {
  const m = rec(raw);
  const type = METHOD_TYPES.find((t) => t === m.type);
  if (!type) return null;
  const id = str(m.id);
  // OAuth, command and external methods are started by their id.
  if ((type === "oauth" || type === "command" || type === "external") && !id) return null;
  const fields = Array.isArray(m.form)
    ? m.form.map(parseField).filter((f): f is FormField => f !== null)
    : [];
  const envNames = Array.isArray(m.names) ? m.names.filter((n): n is string => typeof n === "string") : [];
  return {
    type,
    id: type === "key" || type === "env" ? null : id,
    label: str(m.label) ?? "",
    envNames,
    fields,
  };
}

function parseConnection(raw: unknown): IntegrationConnection | null {
  const c = rec(raw);
  const status = rec(c.status);
  const needsAuth = status.status === "needs_auth" ? (str(status.message) ?? "Sign in again.") : null;
  if (c.type === "env")
    return { kind: "env", credentialID: null, method: "env", envName: str(c.name), needsAuth };
  if (c.type !== "credential") return null;
  const method = c.method === "oauth" || c.method === "external" ? c.method : "key";
  return { kind: "credential", credentialID: str(c.id), method, envName: null, needsAuth };
}

/** One `Integration.Info`. Labels and metadata are not kept. */
export function parseIntegration(raw: unknown): IntegrationInfo | null {
  const i = rec(raw);
  const id = str(i.id);
  if (!id) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    id,
    name: str(i.name) ?? id,
    methods: list(i.methods)
      .map(parseMethod)
      .filter((m): m is IntegrationMethod => m !== null),
    connections: list(i.connections)
      .map(parseConnection)
      .filter((c): c is IntegrationConnection => c !== null),
    ...(rec(i.metadata).source === "mcp" ? { mcp: true as const } : {}),
  };
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;

/**
 * One `Provider.Info`. Only `settings.baseURL` is looked at, and only to tell whether it
 * points at this machine; the rest of `settings`, `headers` and `body` can hold keys.
 */
export function parseProvider(raw: unknown): ProviderEntry | null {
  const p = rec(raw);
  const id = str(p.id);
  if (!id) return null;
  let localEndpoint: string | null = null;
  const base = str(rec(p.settings).baseURL);
  if (base) {
    try {
      const u = new URL(base);
      if (LOOPBACK.test(u.hostname)) localEndpoint = u.host;
    } catch {
      // Not a URL (a {env:…} placeholder): not known to be local.
    }
  }
  const activation = p.activation === "enabled" || p.activation === "disabled" ? p.activation : "auto";
  return { id, name: str(p.name) ?? id, integrationID: str(p.integrationID), activation, localEndpoint };
}

/** Popular providers, offered first under Connect before anything is typed. */
export const POPULAR_PROVIDERS = [
  "opencode",
  "anthropic",
  "openai",
  "github-copilot",
  "google",
  "openrouter",
  "opencode-go",
  "amazon-bedrock",
  "xai",
  "deepseek",
  "groq",
  "mistral",
  "lmstudio",
];

export function methodName(m: IntegrationMethod): string {
  switch (m.type) {
    case "oauth":
      return m.label || "Sign in";
    case "key":
      return m.label || "API key";
    case "command":
      return m.label || "Command";
    case "external":
      return m.label || "External credentials";
    case "env":
      return `Environment variable ${m.envNames.join(" or ")}`;
  }
}

/** The methods Sidecar can run (an environment variable is set outside VS Code). */
export function runnableMethods(i: IntegrationInfo): IntegrationMethod[] {
  return i.methods.filter((m) => m.type !== "env");
}

function via(c: IntegrationConnection): string {
  switch (c.method) {
    case "oauth":
      return "OAuth";
    case "key":
      return "API key";
    case "external":
      return "External credentials";
    case "env":
      return c.envName ? `Environment variable ${c.envName}` : "Environment variable";
  }
}

function methodSummary(i: IntegrationInfo): string {
  const kinds = new Set(i.methods.map((m) => m.type));
  const parts: string[] = [];
  if (kinds.has("oauth")) parts.push("Sign in");
  if (kinds.has("key")) parts.push("API key");
  if (kinds.has("command")) parts.push("Command");
  if (kinds.has("external")) parts.push("External");
  if (kinds.has("env") && parts.length === 0) parts.push("Environment variable");
  return parts.join(" · ");
}

export interface ProvidersInput {
  integrations: IntegrationInfo[];
  /** Active providers; null when OpenCode could not list them. */
  providers: ProviderEntry[] | null;
  models: ModelOption[] | null;
  /** The last failed run's message for an integration (or provider) id. */
  errors: ReadonlyMap<string, string>;
  busy?: ProvidersView["busy"];
}

/** The integration a provider's credentials live in (its own id when OpenCode names none). */
export function integrationOf(providerID: string, providers: ProviderEntry[] | null): string {
  return providers?.find((p) => p.id === providerID)?.integrationID ?? providerID;
}

export function deriveProviders(input: ProvidersInput): ProvidersView {
  const { integrations, providers, errors } = input;
  const models = new Map<string, number>();
  for (const m of input.models ?? []) {
    const id = integrationOf(m.providerID, providers);
    models.set(id, (models.get(id) ?? 0) + 1);
  }
  const byId = new Map(integrations.map((i) => [i.id, i]));
  const connected: ProviderRow[] = [];
  const shown = new Set<string>();
  for (const i of integrations) {
    if (!i.connections.length || i.mcp) continue;
    shown.add(i.id);
    const ok = i.connections.filter((c) => !c.needsAuth);
    const stale = i.connections.find((c) => c.needsAuth);
    const error = errors.get(i.id) ?? null;
    const state: ProviderRow["state"] = !ok.length ? "needs-auth" : error ? "error" : "connected";
    const local = providers?.some((p) => p.integrationID === i.id && p.localEndpoint);
    connected.push({
      id: i.id,
      name: i.name,
      state,
      via: [...new Set((ok.length ? ok : i.connections).map(via))].join(", "),
      error: state === "needs-auth" ? (stale?.needsAuth ?? null) : error,
      models: models.get(i.id) ?? 0,
      canReauth: runnableMethods(i).length > 0,
      canDisconnect: i.connections.some((c) => c.kind === "credential" && c.credentialID),
      ...(local ? { local: true } : {}),
    });
  }
  // Active providers with no connection: OpenCode's free models, or one set up in the config.
  for (const p of providers ?? []) {
    const id = p.integrationID ?? p.id;
    if (shown.has(id) || p.activation === "disabled") continue;
    shown.add(id);
    const i = byId.get(id);
    const error = errors.get(id) ?? null;
    connected.push({
      id,
      name: i?.name ?? p.name,
      state: error ? "error" : "connected",
      via: id === "opencode" ? "Free models, no sign-in" : "OpenCode config",
      error,
      models: models.get(id) ?? 0,
      canReauth: !!i && runnableMethods(i).length > 0,
      canDisconnect: false,
      ...(p.localEndpoint ? { local: true } : {}),
    });
  }
  const rank = (r: ProviderRow) => (r.state === "connected" ? 1 : 0);
  connected.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const available: ProviderChoice[] = [];
  for (const i of integrations) {
    if (shown.has(i.id) || i.mcp) continue;
    const popular = POPULAR_PROVIDERS.includes(i.id);
    available.push({ id: i.id, name: i.name, methods: methodSummary(i), ...(popular ? { popular } : {}) });
  }
  const pop = (c: ProviderChoice) => (c.popular ? POPULAR_PROVIDERS.indexOf(c.id) : POPULAR_PROVIDERS.length);
  available.sort((a, b) => pop(a) - pop(b) || a.name.localeCompare(b.name));
  return { connected, available, busy: input.busy ?? null };
}
