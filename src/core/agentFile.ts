// OpenCode agent files: Markdown with YAML frontmatter, in a config folder's `agents/`
// (or the older `agent/`). The body is the system prompt. Checked against OpenCode 2.4.2:
//
// - Frontmatter keys: description, mode (primary | subagent | all; anything else and the
//   agent is dropped), model (`provider/model#variant`), permissions (rules), request
//   (`body.temperature` and other request overlays), steps, hidden, color, disabled.
// - OpenCode 1's fields still load (tools, permission, temperature, top_p, maxSteps,
//   disable), but only while the file has none of permissions, request, system or disabled:
//   one of those and OpenCode ignores every OpenCode 1 field. So a save that writes
//   permissions or request also converts the OpenCode 1 fields (`legacyRules`).
// - A non-empty body wins over a `system` key; unknown keys are ignored.
//
// Editing is round-trip safe: only the keys whose value changed are rewritten, in place,
// and every other line (unknown keys, comments, blank lines, the line endings and a BOM)
// is kept as it was.

import type { AgentAction, AgentDraft, AgentMode } from "../shared/model";
import type { PermissionRule, RuleEffect } from "../shared/approval";
import { RESERVED_NAME } from "../shared/agentName";
import { parseYaml, topLevelKey, yamlEntry, YamlError, type YamlValue } from "./yaml";

export { validateAgentName } from "../shared/agentName";

export const AGENT_ACTIONS: readonly AgentAction[] = [
  "read",
  "edit",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
];

const MODES: readonly AgentMode[] = ["primary", "subagent", "all"];
/** Keys only OpenCode 2 reads; with one of them, OpenCode 1's keys are ignored. */
const V2_KEYS = ["permissions", "request", "system", "disabled"];
const LEGACY_KEYS = ["tools", "permission", "temperature", "top_p", "maxSteps", "disable"];

/** Turns any mode slug or title into a valid agent name (`Docs Writer!` → `docs-writer`). */
export function toAgentName(raw: string): string {
  let s = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  if (!s) s = "agent";
  if (RESERVED_NAME.test(s)) s += "-agent";
  return s;
}

// -------------------------------------------------------------- the file

export interface AgentFile {
  bom: boolean;
  eol: "\n" | "\r\n";
  /** The frontmatter's lines (between the `---` lines); null when the file has none. */
  head: string[] | null;
  /** Everything after the closing `---` line; null when nothing follows it, not even a line break. */
  body: string | null;
  /** The frontmatter's top-level keys. */
  data: Record<string, YamlValue>;
}

/** Splits an agent file. Throws a YamlError when its frontmatter cannot be read. */
export function parseAgentFile(text: string): AgentFile {
  const bom = text.startsWith("\uFEFF");
  const src = bom ? text.slice(1) : text;
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { bom, eol, head: null, body: src, data: {} };
  const close = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (close < 0) throw new YamlError("The frontmatter has no closing ---", lines.length);
  const head = lines.slice(1, close);
  let value: YamlValue;
  try {
    value = parseYaml(head.join("\n"));
  } catch (e) {
    // Line numbers in the file, not in the frontmatter.
    if (e instanceof YamlError) throw new YamlError(e.message.replace(/ \(line \d+\)$/, ""), e.line + 1);
    throw e;
  }
  if (value !== null && (typeof value !== "object" || Array.isArray(value)))
    throw new YamlError("The frontmatter must be `key: value` lines", 2);
  const rest = lines.slice(close + 1);
  return { bom, eol, head, body: rest.length ? rest.join(eol) : null, data: value ?? {} };
}

const rec = (v: YamlValue | undefined): Record<string, YamlValue> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const text = (v: YamlValue | undefined): string => (typeof v === "string" ? v : "");

/** `provider/model` and its variant from either of OpenCode's model forms. */
export function fileModel(v: YamlValue | undefined): { model: string | null; variant: string | null } {
  if (typeof v === "string") {
    const m = /^([^/#]+\/[^#]+)(?:#(.+))?$/.exec(v.trim());
    return m ? { model: m[1], variant: m[2] ?? null } : { model: null, variant: null };
  }
  const r = rec(v);
  if (typeof r.providerID === "string" && typeof r.model === "string")
    return {
      model: `${r.providerID}/${r.model}`,
      variant: typeof r.variant === "string" ? r.variant : null,
    };
  return { model: null, variant: null };
}

/** The file uses OpenCode 1's fields and OpenCode still reads them (no OpenCode 2 key). */
export function isLegacy(data: Record<string, YamlValue>): boolean {
  return LEGACY_KEYS.some((k) => k in data) && !V2_KEYS.some((k) => k in data);
}

/** OpenCode 1 tool names as OpenCode 2 permission actions. */
const LEGACY_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  task: "subagent",
};

const isEffect = (v: YamlValue | undefined): v is RuleEffect => v === "allow" || v === "ask" || v === "deny";

/**
 * OpenCode 1's `tools` (on or off) and `permission` (an effect, or patterns with effects)
 * as OpenCode 2 rules, in the order OpenCode 2.4.2 converts them: tools, then permission,
 * the first of two equal rules kept.
 */
export function legacyRules(data: Record<string, YamlValue>): PermissionRule[] {
  const out: PermissionRule[] = [];
  const add = (r: PermissionRule) => {
    if (!out.some((o) => o.action === r.action && o.resource === r.resource && o.effect === r.effect))
      out.push(r);
  };
  const action = (k: string) => LEGACY_ACTION[k] ?? k;
  for (const [k, v] of Object.entries(rec(data.tools)))
    if (typeof v === "boolean") add({ action: action(k), resource: "*", effect: v ? "allow" : "deny" });
  for (const [k, v] of Object.entries(rec(data.permission))) {
    if (isEffect(v)) add({ action: action(k), resource: "*", effect: v });
    else
      for (const [pattern, e] of Object.entries(rec(v)))
        if (isEffect(e)) add({ action: action(k), resource: pattern, effect: e });
  }
  return out;
}

function fileRules(data: Record<string, YamlValue>): PermissionRule[] {
  if (isLegacy(data)) return legacyRules(data);
  const list = Array.isArray(data.permissions) ? data.permissions : [];
  const out: PermissionRule[] = [];
  for (const raw of list) {
    const r = rec(raw);
    if (typeof r.action === "string" && typeof r.resource === "string" && isEffect(r.effect))
      out.push({ action: r.action, resource: r.resource, effect: r.effect });
  }
  return out;
}

const isFormRule = (r: PermissionRule): boolean =>
  r.resource === "*" && (AGENT_ACTIONS as readonly string[]).includes(r.action);

/** The form's switches from a rule list: each action's last catch-all rule. */
export function rulesToSwitches(rules: readonly PermissionRule[]): AgentDraft["permissions"] {
  const out: AgentDraft["permissions"] = {};
  for (const r of rules) if (isFormRule(r)) out[r.action as AgentAction] = r.effect;
  return out;
}

/**
 * A rule list with the form's switches applied to `rules`. A switched action's catch-all
 * takes the place of its last one in the list (the earlier ones are overruled by it, since
 * the last match wins), so the rules around it decide as before; one the list did not have
 * goes first, before any narrower rule. An inherited action loses its catch-alls.
 */
export function switchesToRules(
  switches: AgentDraft["permissions"],
  rules: readonly PermissionRule[] = [],
): PermissionRule[] {
  const last = new Map<string, number>();
  rules.forEach((r, i) => {
    if (isFormRule(r)) last.set(r.action, i);
  });
  const head: PermissionRule[] = [];
  for (const a of AGENT_ACTIONS) {
    const e = switches[a];
    if (e && !last.has(a)) head.push({ action: a, resource: "*", effect: e });
  }
  const out: PermissionRule[] = [];
  rules.forEach((r, i) => {
    if (!isFormRule(r)) out.push(r);
    else if (last.get(r.action) === i && switches[r.action as AgentAction])
      out.push({ action: r.action, resource: "*", effect: switches[r.action as AgentAction]! });
  });
  return [...head, ...out];
}

function temperatureOf(data: Record<string, YamlValue>): number | null {
  const t = isLegacy(data) ? data.temperature : rec(rec(data.request).body).temperature;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/** The prompt: the body, or a `system` key when the body is empty (OpenCode's order). */
function promptOf(f: AgentFile): string {
  const body = (f.body ?? "").replace(/\r\n/g, "\n").trim();
  return body || text(f.data.system).trim();
}

/** The form's fields for an agent file, the rules it has no switch for, and whether it is OpenCode 1's. */
export function draftFromFile(
  source: string,
  name: string,
  scope: AgentDraft["scope"],
): { draft: AgentDraft; otherRules: number; legacy: boolean } {
  const f = parseAgentFile(source);
  const d = f.data;
  const { model, variant } = fileModel(d.model);
  const rules = fileRules(d);
  return {
    draft: {
      name,
      description: text(d.description).trim(),
      mode: MODES.find((m) => m === d.mode) ?? "primary",
      model,
      variant,
      temperature: temperatureOf(d),
      permissions: rulesToSwitches(rules),
      prompt: promptOf(f),
      scope,
    },
    otherRules: rules.filter((r) => !isFormRule(r)).length,
    legacy: isLegacy(d),
  };
}

const modelValue = (d: AgentDraft): string | null =>
  d.model ? (d.variant ? `${d.model}#${d.variant}` : d.model) : null;

const yamlRules = (rules: readonly PermissionRule[]): YamlValue =>
  rules.map((r) => ({ action: r.action, resource: r.resource, effect: r.effect }));

/** A new agent file. `comments` go at the top of the frontmatter (an import's notes). */
export function newAgentFile(d: AgentDraft, comments: readonly string[] = []): string {
  const lines: string[] = comments.map((c) => `# ${c}`.trimEnd());
  if (d.description.trim()) lines.push(...yamlEntry("description", d.description.trim()));
  lines.push(...yamlEntry("mode", d.mode));
  const model = modelValue(d);
  if (model) lines.push(...yamlEntry("model", model));
  if (d.temperature !== null) lines.push(...yamlEntry("request", { body: { temperature: d.temperature } }));
  const rules = switchesToRules(d.permissions);
  if (rules.length) lines.push(...yamlEntry("permissions", yamlRules(rules)));
  return ["---", ...lines, "---", "", d.prompt.replace(/\r\n/g, "\n").trim(), ""].join("\n");
}

/** A new agent file with extra rules after the switches' (an import's edit restrictions). */
export function newAgentFileWithRules(
  d: AgentDraft,
  rules: readonly PermissionRule[],
  comments: readonly string[] = [],
): string {
  const text = newAgentFile({ ...d, permissions: {} }, comments);
  const all = switchesToRules(d.permissions, rules);
  if (!all.length) return text;
  const f = parseAgentFile(text);
  return render({
    ...f,
    head: setEntry(f.head ?? [], "permissions", yamlEntry("permissions", yamlRules(all))),
  });
}

/**
 * The file with the draft's changes. Keys whose value did not change are left exactly as
 * they were; an OpenCode 1 file has its tools, permission and temperature converted, since
 * OpenCode ignores them once the file has permissions or request.
 */
export function updateAgentFile(source: string, d: AgentDraft): string {
  const f = parseAgentFile(source);
  const before = draftFromFile(source, d.name, d.scope).draft;
  const data = f.data;
  let head: string[] = f.head ? [...f.head] : [];
  const legacy = isLegacy(data);
  const set = (key: string, value: YamlValue | undefined) => {
    head = setEntry(head, key, value === undefined ? null : yamlEntry(key, value));
  };

  if (d.description.trim() !== before.description) set("description", d.description.trim() || undefined);
  if (d.mode !== before.mode) set("mode", d.mode);
  if (modelValue(d) !== modelValue(before)) set("model", modelValue(d) ?? undefined);

  const rulesChanged = AGENT_ACTIONS.some((a) => d.permissions[a] !== before.permissions[a]);
  if (legacy && (rulesChanged || d.temperature !== before.temperature)) {
    // Writing permissions or request makes OpenCode ignore OpenCode 1's keys, so everything
    // they set moves to OpenCode 2's keys first, then the old keys go.
    const request = structuredClone(rec(data.request));
    const body = rec(request.body);
    if (d.temperature !== null) body.temperature = d.temperature;
    if (typeof data.top_p === "number") body.top_p = data.top_p;
    if (Object.keys(body).length) request.body = body;
    if (Object.keys(request).length) set("request", request);
    if (typeof data.maxSteps === "number" && !("steps" in data)) set("steps", data.maxSteps);
    if (data.disable === true && !("disabled" in data)) set("disabled", true);
    const rules = switchesToRules(d.permissions, legacyRules(data));
    set("permissions", rules.length ? yamlRules(rules) : undefined);
    for (const k of LEGACY_KEYS) set(k, undefined);
  } else if (!legacy) {
    if (d.temperature !== before.temperature) {
      const request = structuredClone(rec(data.request));
      const body = rec(request.body);
      if (d.temperature === null) delete body.temperature;
      else body.temperature = d.temperature;
      if (Object.keys(body).length) request.body = body;
      else delete request.body;
      set("request", Object.keys(request).length ? request : undefined);
    }
    if (rulesChanged) {
      const rules = switchesToRules(d.permissions, fileRules(data));
      set("permissions", rules.length ? yamlRules(rules) : undefined);
    }
  }

  let body = f.body;
  const prompt = d.prompt.replace(/\r\n/g, "\n").trim();
  if (prompt !== before.prompt) {
    // The body is the prompt; a `system` key it replaced would only mislead a reader.
    if (!(f.body ?? "").trim() && typeof data.system === "string") set("system", undefined);
    body = ["", prompt, ""].join("\n");
  }
  return render({ ...f, head: f.head === null && !head.length ? null : head, body });
}

/** Writes the file back with its own line endings. */
function render(f: Pick<AgentFile, "bom" | "eol" | "head" | "body">): string {
  const body = f.body === null ? null : f.body.replace(/\r?\n/g, f.eol);
  const out =
    f.head === null
      ? (body ?? "")
      : ["---", ...f.head, "---"].join(f.eol) + (body === null ? "" : f.eol + body);
  return (f.bom ? "\uFEFF" : "") + out;
}

/**
 * Replaces a top-level key's lines (its value's lines too) with `lines`, removes it
 * (`null`) or adds it at the end. Comments and blank lines around it stay where they are.
 */
export function setEntry(head: readonly string[], key: string, lines: string[] | null): string[] {
  const out = [...head];
  const start = out.findIndex((l) => topLevelKey(l) === key);
  if (start < 0) {
    if (!lines) return out;
    let end = out.length;
    while (end > 0 && out[end - 1].trim() === "") end--;
    out.splice(end, 0, ...lines);
    return out;
  }
  let end = start + 1;
  while (end < out.length && (out[end] === "" || /^\s/.test(out[end]) || /^-(\s|$)/.test(out[end]))) end++;
  // Blank lines at the end of the range belong between entries, not to this one.
  while (end > start + 1 && out[end - 1].trim() === "") end--;
  out.splice(start, end - start, ...(lines ?? []));
  return out;
}
