// Finds the OpenCode server to talk to.
//
// OpenCode 2.x runs a shared, local background service (`opencode service ...`).
// It registers itself in `$XDG_STATE_HOME/opencode/service.json` (default
// `~/.local/state/opencode/service.json`) with its loopback URL and a per-service
// password. The official CLI and `@opencode/client` discover it the same way:
// read that file, then probe `GET /api/info` with HTTP Basic auth
// (`opencode:<password>`) and check the reported pid.
//
// The password is held in memory only for the lifetime of the connection. It is
// never written to extension storage, settings or logs.

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Endpoint } from "./client";

export interface ServiceRegistration {
  url: string;
  password?: string;
  pid?: number;
  version?: string;
}

export type DiscoveryOutcome =
  | { ok: true; endpoint: Endpoint; version: string; source: "service" | "setting" }
  | {
      ok: false;
      reason: "not-registered" | "not-responding" | "unauthorized" | "invalid-setting";
      detail: string;
    };

export function serviceFilePath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const state =
    env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(home, ".local", "state");
  return path.join(state, "opencode", "service.json");
}

export function parseRegistration(text: string | undefined): ServiceRegistration | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.url !== "string") return undefined;
    return {
      url: j.url,
      password: typeof j.password === "string" ? j.password : undefined,
      pid: typeof j.pid === "number" ? j.pid : undefined,
      version: typeof j.version === "string" ? j.version : undefined,
    };
  } catch {
    return undefined;
  }
}

export function basicAuth(password: string): string {
  return "Basic " + Buffer.from("opencode:" + password).toString("base64");
}

export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The address to connect to for a server URL. A service bound to every interface
 * (`opencode service set hostname 0.0.0.0`) registers its bind address, which is not
 * a destination: `0.0.0.0` and `::` mean this machine, so they become 127.0.0.1 and ::1.
 * Any other URL is returned unchanged.
 */
export function connectableUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0") u.hostname = "127.0.0.1";
  else if (host === "::") u.hostname = "[::1]";
  else return raw;
  // Keep the registered form otherwise: no trailing slash added to a bare origin.
  return /^[^/]*\/\/[^/]*$/.test(raw) ? u.href.replace(/\/$/, "") : u.href;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export interface DiscoveryDeps {
  readFile: (file: string) => Promise<string | undefined>;
  fetch: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

async function probe(
  endpoint: Endpoint,
  fetchImpl: typeof fetch,
  expectPid?: number,
): Promise<DiscoveryOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(new URL("/api/info", endpoint.url), {
      headers: endpoint.authorization ? { authorization: endpoint.authorization } : {},
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "not-responding",
      detail: `No response from ${endpoint.url} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (res.status === 401)
    return { ok: false, reason: "unauthorized", detail: `${endpoint.url} rejected the credentials` };
  if (!res.ok)
    return { ok: false, reason: "not-responding", detail: `${endpoint.url} answered HTTP ${res.status}` };
  let info: Record<string, unknown>;
  try {
    info = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not-responding", detail: `${endpoint.url} did not return server info` };
  }
  if (expectPid !== undefined && typeof info.pid === "number" && info.pid !== expectPid) {
    return {
      ok: false,
      reason: "not-responding",
      detail: "A different process answered on the registered port",
    };
  }
  return {
    ok: true,
    endpoint,
    version: typeof info.version === "string" ? info.version : "unknown",
    source: "service",
  };
}

export async function discoverServer(
  settings: { serverUrl: string; allowRemote: boolean },
  deps: DiscoveryDeps,
): Promise<DiscoveryOutcome> {
  const registered = parseRegistration(await deps.readFile(serviceFilePath(deps.env, deps.home)));
  const registration = registered && { ...registered, url: connectableUrl(registered.url) };
  const configured = connectableUrl(settings.serverUrl.trim());

  if (configured) {
    if (!/^https?:\/\//i.test(configured)) {
      return {
        ok: false,
        reason: "invalid-setting",
        detail: "opencodeSidecar.serverUrl must start with http:// or https://",
      };
    }
    if (!isLoopbackUrl(configured) && !settings.allowRemote) {
      return {
        ok: false,
        reason: "invalid-setting",
        detail:
          "opencodeSidecar.serverUrl is not a loopback address. Enable opencodeSidecar.allowRemoteServer to use it.",
      };
    }
    let authorization: string | undefined;
    if (registration?.password && sameOrigin(registration.url, configured))
      authorization = basicAuth(registration.password);
    else if (deps.env?.OPENCODE_SERVER_PASSWORD) authorization = basicAuth(deps.env.OPENCODE_SERVER_PASSWORD);
    const outcome = await probe({ url: configured, authorization }, deps.fetch);
    return outcome.ok ? { ...outcome, source: "setting" } : outcome;
  }

  if (!registration) {
    return {
      ok: false,
      reason: "not-registered",
      detail: "No OpenCode background service is registered on this machine",
    };
  }
  if (!isLoopbackUrl(registration.url)) {
    return {
      ok: false,
      reason: "invalid-setting",
      detail: "The registered OpenCode service is not on a loopback address; refusing to connect",
    };
  }
  const authorization = registration.password ? basicAuth(registration.password) : undefined;
  return probe({ url: registration.url, authorization }, deps.fetch, registration.pid);
}

/**
 * Starts the shared background service with the documented CLI command
 * (`opencode service start`). OpenCode itself guarantees a single service per
 * user and binds it to 127.0.0.1.
 */
export function startService(
  executable: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; output: string }> {
  return runCli(executable, ["service", "start"], timeoutMs);
}

/**
 * How to run the CLI. npm installs it on Windows as `opencode.cmd`, which Node cannot start
 * directly (spawn EINVAL), so a command script runs through cmd.exe with its path and
 * arguments quoted.
 */
export function cliInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(executable))
    return { file: executable, args, verbatim: false };
  const line = [executable, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(" ");
  return { file: comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export function runCli(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  const run = cliInvocation(executable, args);
  return new Promise((resolve) => {
    try {
      execFile(
        run.file,
        run.args,
        { timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: run.verbatim },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
          resolve({ ok: !error, output: error ? `${error.message}\n${output}`.trim() : output });
        },
      );
    } catch (e) {
      // Thrown before the process starts (EINVAL, EACCES): reported like a failed run.
      resolve({ ok: false, output: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** The version `opencode --version` prints ("opencode v2.4.2" → "2.4.2"); null when it fails. */
export async function cliVersion(executable: string): Promise<{ version: string | null; output: string }> {
  const r = await runCli(executable, ["--version"], 10_000);
  const m = r.ok ? /\d+\.\d+\.\d+[\w.+-]*/.exec(r.output) : null;
  return { version: m ? m[0] : null, output: r.output };
}
