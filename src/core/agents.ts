// The Agents panel: OpenCode's agents for a folder (`GET /api/agent`), where each custom
// one is defined, and the Roo Code / Kilo Code mode files that can be imported. OpenCode
// does not say where an agent comes from, so Sidecar reads the config folders OpenCode
// reports (`GET /api/config`: the global `~/.config/opencode`, then the folder's
// `.opencode`) and their `agents/` and `agent/` folders itself; an id with no file there
// is built in, or defined in an `opencode.json` document.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentMode, AgentRow, AgentsView } from "../shared/model";
import { parseRules, type PermissionRule } from "../shared/approval";
import { draftFromFile, parseAgentFile } from "./agentFile";
import { YamlError } from "./yaml";

/** An agent as OpenCode reports it, with what the panel shows. */
export interface AgentDetail {
  id: string;
  name: string;
  description: string;
  mode: AgentMode;
  hidden: boolean;
  /** `provider/model`, with `#variant`; null when it runs on the session's model. */
  model: string | null;
  /** The system prompt ("" when the provider's default is used). */
  system: string;
  temperature: number | null;
  steps: number | null;
  color: string | null;
  permissions: PermissionRule[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One of `GET /api/agent`'s `Agent.Info` records; null when it has no id. */
export function parseAgentDetail(raw: unknown): AgentDetail | null {
  const r = rec(raw);
  const id = str(r.id);
  if (!id) return null;
  const m = rec(r.model);
  const model =
    str(m.providerID) && str(m.id)
      ? `${str(m.providerID)}/${str(m.id)}${str(m.variant) ? `#${str(m.variant)}` : ""}`
      : null;
  const t = rec(rec(r.request).body).temperature;
  return {
    id,
    name: str(r.name) || id,
    description: str(r.description).trim(),
    mode: r.mode === "subagent" || r.mode === "all" ? r.mode : "primary",
    hidden: r.hidden === true,
    model,
    system: str(r.system),
    temperature: typeof t === "number" ? t : null,
    steps: typeof r.steps === "number" ? r.steps : null,
    color: str(r.color) || null,
    permissions: parseRules(r.permissions),
  };
}

/** What `GET /api/config` says about a folder: its config folders and the agents its documents define. */
export interface ConfigSources {
  /** Config folders, lowest priority first (the global one, then the folder's `.opencode`). */
  directories: string[];
  /** Agents defined in config documents (`opencode.json`'s `agents`), by id, with the document. */
  documentAgents: Record<string, string>;
  /** The documents' `instructions` entries, with the document; absent when there are none. */
  instructions?: ConfigInstruction[];
}

/** An entry of a config document's `instructions`, and the document it came from. */
export interface ConfigInstruction {
  entry: string;
  from: string;
}

/** Only the documents' `agents` ids and `instructions` are read: they can also hold provider keys. */
export function parseConfigSources(raw: unknown): ConfigSources {
  const out: ConfigSources = { directories: [], documentAgents: {} };
  const instructions: ConfigInstruction[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const r = rec(e);
    if (r.type === "directory" && str(r.path)) out.directories.push(str(r.path));
    else if (r.type === "document") {
      const from = str(r.path) || "config";
      for (const id of Object.keys(rec(rec(r.info).agents))) out.documentAgents[id] = from;
      const list = rec(r.info).instructions;
      for (const entry of Array.isArray(list) ? list : [])
        if (typeof entry === "string" && entry.trim()) instructions.push({ entry, from });
    }
  }
  if (instructions.length) out.instructions = instructions;
  return out;
}

// ----------------------------------------------------------------- paths

/** Path rules of the platform, so Windows paths are handled the same in tests on Linux. */
export function pathFor(platform: NodeJS.Platform): nodePath.PlatformPath {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Whether `child` is `parent` or inside it (case-insensitive on Windows, either slash). */
export function isInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = pathFor(platform);
  const norm = (s: string) => {
    const n = p.resolve(s);
    return platform === "win32" ? n.toLowerCase() : n;
  };
  const rel = p.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Where Sidecar writes a new agent: the config folder's `agents/<name>.md`. */
export function agentFilePath(
  configDir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(configDir, "agents", `${name}.md`);
}

/** The folder's own config folder (`<folder>/.opencode`). */
export function projectConfigDir(folder: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(folder, ".opencode");
}

/**
 * The global config folder from OpenCode's list: the first one outside the workspace
 * (OpenCode lists it first, at the lowest priority). On Windows OpenCode 2.4 uses
 * `%USERPROFILE%\.config\opencode`, not `%APPDATA%`.
 */
export function globalConfigDir(
  sources: ConfigSources,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return sources.directories.find((d) => !isInside(d, folder, platform)) ?? null;
}

// ----------------------------------------------------------------- files

export interface AgentFileRef {
  /** The id OpenCode gives it: the path under `agents/` without `.md`, with `/`. */
  id: string;
  path: string;
  scope: "project" | "global";
  /** Its text; null when it could not be read. */
  text: string | null;
}

/**
 * The agent files in the config folders, by id; a later folder's file wins (the folder's
 * own over the global one), as in OpenCode.
 */
export async function scanAgentFiles(
  configDirs: readonly string[],
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, AgentFileRef>> {
  const p = pathFor(platform);
  const out = new Map<string, AgentFileRef>();
  for (const dir of configDirs) {
    const scope = isInside(dir, folder, platform) ? "project" : "global";
    for (const sub of ["agent", "agents"]) {
      const root = p.join(dir, sub);
      for (const file of await listMarkdown(root, 3)) {
        const id = p.relative(root, file).replace(/\\/g, "/").replace(/\.md$/i, "");
        const text = await fs.readFile(file, "utf8").catch(() => null);
        out.set(id, { id, path: file, scope, text });
      }
    }
  }
  return out;
}

async function listMarkdown(dir: string, depth: number): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = nodePath.join(dir, e.name);
    if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
    else if (e.isDirectory() && depth > 1) out.push(...(await listMarkdown(full, depth - 1)));
  }
  return out;
}

/** Why Sidecar cannot edit a file in its form ("" when it can). */
function readProblem(text: string): string {
  try {
    parseAgentFile(text);
    return "";
  } catch (e) {
    return e instanceof YamlError ? e.message : String(e);
  }
}

/** OpenCode's own agents that are never shown (they title, summarize and compact sessions). */
const INTERNAL = new Set(["compaction", "title", "summary"]);

/** The Agents panel's rows: custom agents first (this folder's, then global), then built-in ones. */
export function deriveAgentRows(input: {
  details: readonly AgentDetail[];
  files: ReadonlyMap<string, AgentFileRef>;
  documentAgents: Readonly<Record<string, string>>;
  folder: string;
  platform?: NodeJS.Platform;
}): AgentRow[] {
  const platform = input.platform ?? process.platform;
  const p = pathFor(platform);
  const shown = (path: string, scope: "project" | "global") =>
    scope === "project" ? p.relative(input.folder, path).replace(/\\/g, "/") : path;
  const rows: AgentRow[] = [];
  const listed = new Set<string>();
  for (const a of input.details) {
    listed.add(a.id);
    const file = input.files.get(a.id);
    if (a.hidden && !file) continue;
    if (INTERNAL.has(a.id) && !file) continue;
    const base = {
      id: a.id,
      name: a.name,
      description: a.description,
      mode: a.mode,
      model: a.model,
      problem: null,
    };
    if (file) {
      const problem = file.text === null ? "Sidecar could not read the file." : readProblem(file.text);
      const row: AgentRow = {
        ...base,
        source: file.scope,
        file: shown(file.path, file.scope),
        editable: !problem,
        problem: problem ? `Edit it in the editor: ${problem}` : null,
      };
      if (!problem && file.text !== null) {
        const d = draftFromFile(file.text, a.id, file.scope);
        row.draft = d.draft;
        row.otherRules = d.otherRules;
        if (d.legacy) row.legacy = true;
      }
      rows.push(row);
    } else if (input.documentAgents[a.id])
      rows.push({ ...base, source: "config", file: input.documentAgents[a.id], editable: false });
    else rows.push({ ...base, source: "built-in", file: null, editable: false });
  }
  // Files OpenCode did not load: a frontmatter problem, or a mode it does not know.
  for (const f of input.files.values()) {
    if (listed.has(f.id)) continue;
    const why = f.text === null ? "Sidecar could not read the file." : readProblem(f.text);
    rows.push({
      id: f.id,
      name: f.id,
      description: "",
      mode: "primary",
      model: null,
      source: f.scope,
      file: shown(f.path, f.scope),
      editable: false,
      problem: why
        ? `OpenCode did not load it: ${why}`
        : "OpenCode did not load it. Check its frontmatter: mode must be primary, subagent or all.",
    });
  }
  const order = { project: 0, global: 1, config: 2, "built-in": 3 };
  return rows.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name));
}

export function emptyAgentsView(): AgentsView {
  return { agents: [], importable: null, projectDir: null, globalDir: null, busy: null };
}

// ------------------------------------------------------- Roo and Kilo modes

export interface ModeFileRef {
  path: string;
  /** As shown: `.roomodes`, `Roo Code (global)`, … */
  label: string;
  kind: "roo" | "kilo";
  scope: "project" | "global";
}

const ROO_ID = "rooveterinaryinc.roo-cline";
const KILO_ID = "kilocode.kilo-code";

/**
 * The `globalStorage` folders of the VS Code builds a Roo Code user may have had: the one
 * Sidecar runs in (`own`, the parent of its own storage), then VS Code, Insiders, Cursor
 * and VSCodium in their usual places.
 */
export function globalStorageDirs(
  own: string | null,
  env: { platform: NodeJS.Platform; home: string; appData?: string; xdgConfig?: string },
): string[] {
  const p = pathFor(env.platform);
  const base =
    env.platform === "win32"
      ? (env.appData ?? p.join(env.home, "AppData", "Roaming"))
      : env.platform === "darwin"
        ? p.join(env.home, "Library", "Application Support")
        : (env.xdgConfig ?? p.join(env.home, ".config"));
  const apps = ["Code", "Code - Insiders", "Cursor", "VSCodium"];
  const all = [own, ...apps.map((a) => p.join(base, a, "User", "globalStorage"))].filter(
    (d): d is string => !!d,
  );
  const seen = new Set<string>();
  return all.filter((d) => {
    const k = env.platform === "win32" ? p.resolve(d).toLowerCase() : p.resolve(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every place a mode file can be, in the order they are offered (the folder's first). */
export function modeFileCandidates(
  folder: string,
  storageDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ModeFileRef[] {
  const p = pathFor(platform);
  const out: ModeFileRef[] = [
    { path: p.join(folder, ".roomodes"), label: ".roomodes", kind: "roo", scope: "project" },
    { path: p.join(folder, ".kilocodemodes"), label: ".kilocodemodes", kind: "kilo", scope: "project" },
  ];
  for (const dir of storageDirs) {
    const app = p.basename(p.dirname(p.dirname(dir)));
    const where = app && app !== "Code" ? `, ${app}` : "";
    for (const [id, kind, name] of [
      [ROO_ID, "roo", "Roo Code"],
      [KILO_ID, "kilo", "Kilo Code"],
    ] as const)
      for (const file of ["custom_modes.yaml", "cline_custom_modes.json"])
        out.push({
          path: p.join(dir, id, "settings", file),
          label: `${name} (global${where})`,
          kind,
          scope: "global",
        });
  }
  return out;
}

/**
 * A mode's instruction files in the folder: `.roo/rules-<slug>/` (every text file, in
 * name order) and the older `.roorules-<slug>` / `.clinerules-<slug>`; for Kilo Code
 * `.kilocode/rules-<slug>/` and `.kilocoderules-<slug>`. At most 20 files of 64 KB each.
 */
export async function modeRuleFiles(
  folder: string,
  slug: string,
  kind: "roo" | "kilo",
  platform: NodeJS.Platform = process.platform,
): Promise<{ source: string; text: string }[]> {
  const p = pathFor(platform);
  const dirs = kind === "roo" ? [p.join(".roo", `rules-${slug}`)] : [p.join(".kilocode", `rules-${slug}`)];
  const singles = kind === "roo" ? [`.roorules-${slug}`, `.clinerules-${slug}`] : [`.kilocoderules-${slug}`];
  const out: { source: string; text: string }[] = [];
  const read = async (rel: string) => {
    if (out.length >= 20) return;
    const full = p.join(folder, rel);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile() || st.size > 64 * 1024) return;
    const text = await fs.readFile(full, "utf8").catch(() => "");
    if (text.includes("\0") || !text.trim()) return;
    out.push({ source: rel.replace(/\\/g, "/"), text });
  };
  for (const d of dirs)
    for (const f of await listFiles(p.join(folder, d), 2)) await read(p.relative(folder, f));
  for (const s of singles) await read(s);
  return out;
}

async function listFiles(dir: string, depth: number): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = nodePath.join(dir, e.name);
    if (e.isFile()) out.push(full);
    else if (e.isDirectory() && depth > 1) out.push(...(await listFiles(full, depth - 1)));
  }
  return out;
}
