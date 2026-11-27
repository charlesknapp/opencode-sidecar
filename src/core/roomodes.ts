// Roo Code and Kilo Code custom modes as OpenCode agents. A mode file is `.roomodes` or
// `.kilocodemodes` in the folder, or the extension's global `custom_modes.yaml` (older
// versions: `cline_custom_modes.json`), in JSON or YAML: `{ customModes: [{ slug, name,
// roleDefinition, whenToUse?, description?, customInstructions?, groups }] }`. JSON is
// read in full; YAML through Sidecar's subset reader (./yaml.ts), which covers what Roo
// Code writes and the documented examples.
//
// The mapping: slug → the agent's name, whenToUse (or description, or name) → description,
// roleDefinition + customInstructions (+ the mode's `.roo/rules-<slug>/` files) → the
// prompt, groups → permission rules on top of OpenCode's defaults (which allow everything),
// a model OpenCode has → model. An orchestrator-style mode becomes a primary agent that
// may start subagents; every other mode becomes `mode: all`, so it can be picked for a
// session and started by the orchestrator. What does not carry over exactly is listed in
// the file (as comments) and in the preview.

import type { AgentDraft, AgentMode, ModelOption } from "../shared/model";
import type { PermissionRule } from "../shared/approval";
import { toAgentName } from "./agentFile";
import { parseYaml, YamlError, type YamlValue } from "./yaml";

export interface RooGroup {
  group: string;
  /** edit: the files it may change, as a regular expression over the relative path. */
  fileRegex?: string;
  description?: string;
}

export interface RooMode {
  slug: string;
  name: string;
  roleDefinition: string;
  whenToUse: string;
  description: string;
  customInstructions: string;
  groups: RooGroup[];
  /** A model named in the mode (`model`, or an `apiConfiguration`'s model id). */
  model: string | null;
  /** Group entries Sidecar could not read. */
  unknown: string[];
}

type Rec = Record<string, YamlValue>;
const rec = (v: YamlValue | undefined): Rec => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v: YamlValue | undefined): string => (typeof v === "string" ? v.trim() : "");

/** The modes in a mode file. Throws (with the line for YAML) when it cannot be read. */
export function parseModesFile(text: string): RooMode[] {
  const src = text.replace(/^\uFEFF/, "");
  let data: YamlValue;
  if (/^\s*[{[]/.test(src)) {
    try {
      data = JSON.parse(src) as YamlValue;
    } catch (e) {
      throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  } else data = parseYaml(src);
  const list = Array.isArray(data) ? data : rec(data).customModes;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("customModes is not a list");
  const out: RooMode[] = [];
  for (const raw of list) {
    const m = rec(raw);
    const slug = str(m.slug);
    if (!slug) continue;
    const groups: RooGroup[] = [];
    const unknown: string[] = [];
    for (const g of Array.isArray(m.groups) ? m.groups : []) {
      if (typeof g === "string") groups.push({ group: g });
      else if (Array.isArray(g) && typeof g[0] === "string") {
        const o = rec(g[1]);
        groups.push({
          group: g[0],
          ...(str(o.fileRegex) ? { fileRegex: str(o.fileRegex) } : {}),
          ...(str(o.description) ? { description: str(o.description) } : {}),
        });
      } else unknown.push(JSON.stringify(g));
    }
    const api = rec(m.apiConfiguration);
    out.push({
      slug,
      name: str(m.name) || slug,
      roleDefinition: str(m.roleDefinition),
      whenToUse: str(m.whenToUse),
      description: str(m.description),
      customInstructions: str(m.customInstructions),
      groups,
      model: str(m.model) || str(api.modelId) || str(api.apiModelId) || str(api.model) || null,
      unknown,
    });
  }
  return out;
}

/** Whether a YAML or JSON problem is the file's (to show its message) or Sidecar's. */
export function modesFileError(e: unknown): string {
  if (e instanceof YamlError) return `Sidecar could not read this YAML: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * A Roo Code `fileRegex` as OpenCode globs, for the common shapes: an extension or a few
 * (`\.(md|mdx)$`), a folder (`^docs/`), literal names. Null when it cannot be matched
 * exactly by globs (character classes, quantifiers, …).
 */
export function regexToGlobs(re: string): string[] | null {
  let s = re.trim();
  const start = s.startsWith("^");
  if (start) s = s.slice(1);
  const end = s.endsWith("$") && !s.endsWith("\\$");
  if (end) s = s.slice(0, -1);
  // Pieces: literal text, `*` for .* / .+, or one group of literal alternatives.
  let alts: string[] = [""];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      if (!n || !/[./\-_()[\]{}+?*^$|]/.test(n)) return null;
      alts = alts.map((a) => a + n);
      i += 2;
    } else if (c === "." && (s[i + 1] === "*" || s[i + 1] === "+")) {
      alts = alts.map((a) => a + "*");
      i += 2;
    } else if (c === "(") {
      const close = s.indexOf(")", i);
      if (close < 0) return null;
      let inner = s.slice(i + 1, close);
      if (inner.startsWith("?:")) inner = inner.slice(2);
      const options: string[] = [];
      for (const part of inner.split("|")) {
        let lit = "";
        for (let j = 0; j < part.length; j++) {
          if (part[j] === "\\" && part[j + 1] && /[./\-_]/.test(part[j + 1])) lit += part[++j];
          else if (/[A-Za-z0-9/_-]/.test(part[j])) lit += part[j];
          else return null;
        }
        options.push(lit);
      }
      if (s[close + 1] === "?" || s[close + 1] === "*" || s[close + 1] === "+") return null;
      alts = alts.flatMap((a) => options.map((o) => a + o));
      i = close + 1;
    } else if (/[A-Za-z0-9/_-]/.test(c)) {
      if (/[?*+{]/.test(s[i + 1] ?? "")) return null;
      alts = alts.map((a) => a + c);
      i++;
    } else return null;
    if (alts.length > 20) return null;
  }
  const globs = alts.map((a) => `${start ? "" : "*"}${a}${end ? "" : "*"}`.replace(/\*{2,}/g, "*"));
  return globs.some((g) => g === "" || g === "*") ? null : [...new Set(globs)];
}

/** An orchestrator-style mode: it hands work to other modes (Roo Code's `new_task`). */
export function isOrchestrator(m: RooMode): boolean {
  return (
    /orchestrat|boomerang/i.test(`${m.slug} ${m.name}`) ||
    /\bnew_task\b/.test(`${m.roleDefinition}\n${m.customInstructions}`)
  );
}

/** A model the mode names, if OpenCode's catalog has it (`provider/model`, or a unique model id). */
export function matchModel(name: string | null, models: readonly ModelOption[]): ModelOption | null {
  if (!name) return null;
  const exact = models.find((m) => m.key === name);
  if (exact) return exact;
  const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const byId = models.filter((m) => m.id === name || m.id === bare);
  return byId.length === 1 ? byId[0] : null;
}

export interface ImportedAgent {
  name: string;
  draft: AgentDraft;
  /** Rules after the switches' (an edit restriction's allow rules). */
  rules: PermissionRule[];
  /** What does not carry over exactly, for the preview and the file's comments. */
  notes: string[];
  orchestrator: boolean;
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * One mode as an OpenCode agent. `rules` are the mode's instruction files (from
 * `.roo/rules-<slug>/`), `others` the names of the other modes imported with it (an
 * orchestrator is told it can start them).
 */
export function modeToAgent(
  m: RooMode,
  ctx: {
    models: readonly ModelOption[];
    rules?: { source: string; text: string }[];
    others?: readonly string[];
    scope?: AgentDraft["scope"];
  },
): ImportedAgent {
  const notes: string[] = [];
  const has = (g: string) => m.groups.some((x) => x.group === g);
  const orchestrator = isOrchestrator(m);
  const mode: AgentMode = orchestrator ? "primary" : "all";
  const permissions: AgentDraft["permissions"] = {};
  const rules: PermissionRule[] = [];

  if (!has("read")) {
    permissions.read = "deny";
    rules.push(
      { action: "glob", resource: "*", effect: "deny" },
      { action: "grep", resource: "*", effect: "deny" },
    );
  }
  const edits = m.groups.filter((g) => g.group === "edit");
  if (!edits.length) permissions.edit = "deny";
  else if (edits.every((g) => g.fileRegex)) {
    const globs = edits.map((g) => regexToGlobs(g.fileRegex!));
    if (globs.every((g): g is string[] => g !== null)) {
      permissions.edit = "deny";
      for (const g of [...new Set(globs.flat())])
        rules.push({ action: "edit", resource: g, effect: "allow" });
    } else {
      // A restriction OpenCode cannot express: ask for every edit rather than allow them all.
      permissions.edit = "ask";
      notes.push(
        `Edits were limited to ${edits.map((g) => g.fileRegex).join(", ")}; OpenCode matches globs, not regular expressions, so every edit asks first.`,
      );
    }
  }
  if (!has("command")) permissions.shell = "deny";
  if (has("browser")) {
    permissions.webfetch = "allow";
    permissions.websearch = "allow";
    notes.push("Roo Code's browser became web fetch and search; OpenCode's own browser stays off.");
  } else {
    permissions.webfetch = "deny";
    permissions.websearch = "deny";
  }
  if (!has("mcp") && m.groups.length)
    notes.push("MCP tools are not limited: OpenCode's permissions name each MCP tool, not a group.");
  if (orchestrator) permissions.subagent = "allow";
  const known = new Set(["read", "edit", "command", "browser", "mcp", "modes"]);
  const odd = [...m.groups.filter((g) => !known.has(g.group)).map((g) => g.group), ...m.unknown];
  if (odd.length) notes.push(`Unknown groups left out: ${odd.join(", ")}.`);

  const model = matchModel(m.model, ctx.models);
  if (m.model && !model)
    notes.push(`Model ${m.model} is not in OpenCode's catalog; it runs on the session's model.`);

  const parts = [m.roleDefinition, m.customInstructions].filter(Boolean);
  for (const r of ctx.rules ?? [])
    if (r.text.trim()) parts.push(`## Rules from ${r.source}\n\n${r.text.trim()}`);
  if (orchestrator && ctx.others?.length)
    parts.push(
      `To hand work to another mode (Roo Code's new_task), start it as a subagent with OpenCode's subagent tool: ${ctx.others.join(", ")}.`,
    );
  if (!m.roleDefinition) notes.push("The mode has no role definition.");

  return {
    name: toAgentName(m.slug),
    orchestrator,
    notes,
    rules,
    draft: {
      name: toAgentName(m.slug),
      description: one(m.whenToUse || m.description || m.name),
      mode,
      model: model?.key ?? null,
      variant: null,
      temperature: null,
      permissions,
      prompt: parts.join("\n\n"),
      scope: ctx.scope ?? "project",
    },
  };
}

/** The comments at the top of an imported agent's frontmatter. */
export function importComments(m: RooMode, source: string, notes: readonly string[]): string[] {
  const out = [`Imported from the ${one(m.name)} mode (${m.slug}) in ${source}.`];
  if (notes.length) out.push("Not carried over exactly:", ...notes.map((n) => `- ${one(n)}`));
  return out;
}
