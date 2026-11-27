// "Check OpenCode setup": one report of everything a working setup needs, from the
// `opencode` binary to each provider. The host gathers the facts; this module turns them
// into checks and Markdown, so it is tested without VS Code or a server. The report holds
// no secrets: paths, versions, ids and states only.

import type { AccountStatus, ModelOption } from "../shared/model";
import type { DiscoveryResult } from "./cliDiscovery";
import { integrationOf, type IntegrationInfo, type ProviderEntry } from "./providers";

/**
 * Below this many tokens of context OpenCode's system prompt and tool definitions leave no
 * room for the conversation. Ollama's default `num_ctx` (2048–4096) is far below it.
 */
export const MIN_LOCAL_CONTEXT = 16_000;

export type CheckLevel = "ok" | "warn" | "error" | "info";

export interface HealthCheck {
  level: CheckLevel;
  text: string;
  /** What to do about it, or more detail. */
  hint?: string;
}

export interface HealthSection {
  title: string;
  checks: HealthCheck[];
}

export interface HealthInput {
  platform: NodeJS.Platform;
  cli: DiscoveryResult;
  /** `opencode --version`; null when it could not be run (with `cliError`). */
  cliVersion: string | null;
  cliError?: string;
  /** The background service as `service.json` registers it; null when none is. */
  service: { url: string; pid: number | null } | null;
  /** A server URL set in Sidecar's settings, which is used instead of the service. */
  serverSetting: string;
  /** What `GET /api/info` answered; null with `serverError` when it did not. */
  server: { url: string; version: string; pid: number | null } | null;
  serverError?: string;
  /** The open folder as VS Code reports it, and as Sidecar sends it to OpenCode. */
  folder: { path: string; sent: string } | null;
  /** OpenCode's project for the folder; undefined when not checked, null when none. */
  projectID?: string | null;
  account: AccountStatus | null;
  integrations: IntegrationInfo[] | null;
  providers: ProviderEntry[] | null;
  models: ModelOption[] | null;
  /** OpenCode's default model (`provider/model`). */
  defaultModel: string | null;
  /** The last failed run's message for an integration id. */
  providerErrors: ReadonlyMap<string, string>;
  /** Directories on PATH (Windows: for the PATH check). */
  pathDirs: string[];
}

const ok = (text: string, hint?: string): HealthCheck => ({ level: "ok", text, ...(hint ? { hint } : {}) });
const warn = (text: string, hint?: string): HealthCheck => ({
  level: "warn",
  text,
  ...(hint ? { hint } : {}),
});
const bad = (text: string, hint?: string): HealthCheck => ({
  level: "error",
  text,
  ...(hint ? { hint } : {}),
});
const info = (text: string, hint?: string): HealthCheck => ({
  level: "info",
  text,
  ...(hint ? { hint } : {}),
});

const winDir = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();

function cliSection(i: HealthInput): HealthSection {
  const checks: HealthCheck[] = [];
  if (!i.cli.found) {
    checks.push(
      i.cli.configuredInvalid
        ? bad(
            "The opencode path in Sidecar's settings does not point at a program.",
            "Fix `opencodeSidecar.executablePath`, or clear it to search PATH.",
          )
        : bad(
            "The opencode program was not found.",
            `Install OpenCode, or set \`opencodeSidecar.executablePath\`. Searched ${i.cli.searched.length} locations.`,
          ),
    );
    return { title: "OpenCode program", checks };
  }
  const from = {
    setting: "from Sidecar's settings",
    PATH: "on PATH",
    "known-location": "in a known install folder",
  }[i.cli.source];
  checks.push(ok(`Found ${from}: \`${i.cli.path}\``));
  if (i.cliVersion) checks.push(ok(`Version ${i.cliVersion}`));
  else checks.push(warn("Could not run `opencode --version`.", i.cliError));
  return { title: "OpenCode program", checks };
}

function serviceSection(i: HealthInput): HealthSection {
  const checks: HealthCheck[] = [];
  const custom = i.serverSetting.trim();
  if (custom) checks.push(info(`Using the server set in Sidecar's settings: ${custom}`));
  else if (!i.service)
    checks.push(
      bad(
        "No OpenCode background service is registered.",
        "Run `opencode service start`, or Start OpenCode in Sidecar.",
      ),
    );
  else checks.push(ok(`Background service registered at ${i.service.url}`));
  if (!i.server) {
    if (i.service || custom) checks.push(bad("OpenCode did not answer.", i.serverError));
    return { title: "Background service", checks };
  }
  checks.push(ok(`Reachable: OpenCode ${i.server.version} at ${i.server.url}`));
  if (!custom && i.service?.pid != null && i.server.pid != null) {
    if (i.service.pid === i.server.pid) checks.push(ok(`Process ${i.server.pid} matches the registration`));
    else
      checks.push(
        bad(
          `A different process (${i.server.pid}) answers than the one registered (${i.service.pid}).`,
          "Run `opencode service stop`, then `opencode service start`.",
        ),
      );
  }
  if (i.cliVersion && i.server.version !== "unknown" && !i.cliVersion.includes(i.server.version))
    checks.push(
      warn(
        `The service runs ${i.server.version} but the program is ${i.cliVersion}.`,
        "Restart the service so both are the same version: `opencode service stop`, then `opencode service start`.",
      ),
    );
  return { title: "Background service", checks };
}

function accountSection(i: HealthInput): HealthSection {
  const checks: HealthCheck[] = [];
  const a = i.account;
  if (!i.server)
    return { title: "Sign-in and models", checks: [info("Not checked: OpenCode is not reachable.")] };
  if (!a) checks.push(warn("OpenCode's connections could not be read."));
  else if (a.opencode === "needs-auth")
    checks.push(warn("The OpenCode account sign-in has expired.", "Sign in again from the Providers panel."));
  else if (a.opencode === "connected") checks.push(ok("Signed in to an OpenCode account"));
  else if (a.otherProviders) checks.push(ok("A provider is connected"));
  else checks.push(info("No provider is signed in; only free models can be used."));

  const models = i.models;
  if (models === null) checks.push(bad("The model list could not be loaded."));
  else if (!models.length)
    checks.push(
      bad("OpenCode offers no models for this folder.", "Connect a provider in the Providers panel."),
    );
  else checks.push(ok(`${models.length} model${models.length === 1 ? "" : "s"} available`));
  if (models?.length) {
    if (!i.defaultModel) checks.push(info("OpenCode reports no default model; Sidecar picks one."));
    else if (models.some((m) => m.key === i.defaultModel))
      checks.push(ok(`Default model \`${i.defaultModel}\` is available`));
    else
      checks.push(
        bad(
          `The default model \`${i.defaultModel}\` is not available.`,
          "Its provider may be signed out, or the model renamed. Pick another model, or fix `model` in OpenCode's config.",
        ),
      );
  }
  return { title: "Sign-in and models", checks };
}

function providerSection(i: HealthInput): HealthSection {
  const checks: HealthCheck[] = [];
  if (!i.server) return { title: "Providers", checks: [info("Not checked: OpenCode is not reachable.")] };
  if (!i.integrations)
    return { title: "Providers", checks: [warn("OpenCode's integrations could not be read.")] };
  const names = new Map(i.integrations.map((x) => [x.id, x.name]));
  for (const x of i.integrations) {
    if (!x.connections.length) continue;
    const stale = x.connections.find((c) => c.needsAuth);
    const fine = x.connections.some((c) => !c.needsAuth);
    const err = i.providerErrors.get(x.id);
    if (!fine) checks.push(warn(`${x.name}: needs signing in again.`, stale?.needsAuth ?? undefined));
    else if (err) checks.push(warn(`${x.name}: the last run failed.`, err));
    else checks.push(ok(`${x.name}: connected`));
  }
  for (const [id, err] of i.providerErrors)
    if (!i.integrations.some((x) => x.id === id && x.connections.length))
      checks.push(warn(`${names.get(id) ?? id}: the last run failed.`, err));
  // Local servers: a model whose window is smaller than OpenCode's prompt and tools fails.
  for (const p of i.providers ?? []) {
    if (!p.localEndpoint) continue;
    const own = (i.models ?? []).filter(
      (m) => integrationOf(m.providerID, i.providers) === (p.integrationID ?? p.id),
    );
    const small = own.filter((m) => m.contextLimit !== null && m.contextLimit < MIN_LOCAL_CONTEXT);
    const unknown = own.filter((m) => m.contextLimit === null);
    checks.push(
      info(
        `${p.name} runs on this machine (${p.localEndpoint}), ${own.length} model${own.length === 1 ? "" : "s"}.`,
      ),
    );
    for (const m of small)
      checks.push(
        warn(
          `${p.name} · ${m.name}: a ${m.contextLimit!.toLocaleString("en-US")}-token context is too small for OpenCode.`,
          `OpenCode's instructions and tools need about ${MIN_LOCAL_CONTEXT / 1000}k tokens. Raise the model's context (Ollama: \`num_ctx\`, LM Studio: Context Length) and set \`limit.context\` in OpenCode's config.`,
        ),
      );
    if (unknown.length)
      checks.push(
        warn(
          `${p.name}: ${unknown.length === 1 ? `${unknown[0].name} reports` : `${unknown.length} models report`} no context size.`,
          `If the server uses a small default (Ollama's \`num_ctx\` is 2048–4096), replies fail or forget the task. Use at least ${MIN_LOCAL_CONTEXT / 1000}k and set \`limit.context\` in OpenCode's config.`,
        ),
      );
  }
  if (!checks.length) checks.push(info("No provider is connected."));
  return { title: "Providers", checks };
}

function windowsSection(i: HealthInput): HealthSection | null {
  if (i.platform !== "win32") return null;
  const checks: HealthCheck[] = [];
  if (i.cli.found) {
    const dir = winDir(i.cli.path.replace(/[\\/][^\\/]+$/, ""));
    if (i.pathDirs.some((d) => winDir(d) === dir)) checks.push(ok("The opencode folder is on PATH"));
    else
      checks.push(
        warn(
          "The opencode folder is not on PATH.",
          "Sidecar found it anyway, but terminals and other tools may not. Add it to PATH and restart VS Code.",
        ),
      );
    if (/\.(cmd|bat)$/i.test(i.cli.path))
      checks.push(info("opencode is an npm command script (.cmd); Sidecar runs it through cmd.exe."));
  }
  if (i.folder) {
    const upper = /^[A-Z]:/.test(i.folder.sent) || !/^[a-zA-Z]:/.test(i.folder.sent);
    if (!upper)
      checks.push(bad(`The folder is sent as \`${i.folder.sent}\`, with a lower-case drive letter.`));
    else if (i.folder.path !== i.folder.sent)
      checks.push(ok(`Drive letter upper-cased for OpenCode: \`${i.folder.path}\` → \`${i.folder.sent}\``));
    else checks.push(ok(`Folder sent as \`${i.folder.sent}\``));
    if (i.projectID === null)
      checks.push(
        warn("OpenCode has no project for this folder yet.", "It is created with the first session."),
      );
    else if (i.projectID) checks.push(ok("OpenCode knows the folder (project found)"));
  }
  return { title: "Windows", checks };
}

export function healthReport(input: HealthInput): HealthSection[] {
  return [
    cliSection(input),
    serviceSection(input),
    accountSection(input),
    providerSection(input),
    windowsSection(input),
  ].filter((s): s is HealthSection => s !== null);
}

const MARK: Record<CheckLevel, string> = { ok: "✅", warn: "⚠️", error: "❌", info: "ℹ️" };

/** The worst level in the report. */
export function overall(sections: HealthSection[]): CheckLevel {
  const all = sections.flatMap((s) => s.checks.map((c) => c.level));
  return all.includes("error") ? "error" : all.includes("warn") ? "warn" : "ok";
}

export function healthMarkdown(sections: HealthSection[], meta: { when: Date; sidecar: string }): string {
  const level = overall(sections);
  const problems = sections
    .flatMap((s) => s.checks)
    .filter((c) => c.level === "error" || c.level === "warn").length;
  const lines = [
    "# OpenCode setup check",
    "",
    `${MARK[level]} ${level === "ok" ? "Everything looks fine." : `${problems} thing${problems === 1 ? "" : "s"} to look at.`}`,
    "",
    `Sidecar ${meta.sidecar} · ${meta.when.toISOString().replace("T", " ").slice(0, 16)} UTC`,
  ];
  for (const s of sections) {
    lines.push("", `## ${s.title}`, "");
    for (const c of s.checks) {
      lines.push(`- ${MARK[c.level]} ${c.text}`);
      if (c.hint) lines.push(`  ${c.hint}`);
    }
  }
  return lines.join("\n") + "\n";
}
