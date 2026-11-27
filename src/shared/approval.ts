// Approval modes: one-click sets of OpenCode permission rules for a session, and the
// helpers that read them back. Pure, shared by the host and the webview.
//
// How OpenCode 2.4 decides (checked against the live server): a request's action and
// resources are matched against the agent's rules followed by the session's
// `permissions`; the last matching rule wins and no match means "ask". Patterns are
// globs (`*` any text, `?` one character, a trailing ` *` also matches nothing),
// case-insensitive, with `\` read as `/`. When that says "ask", the folder's saved
// "always allow" rules can still allow it.

export type RuleEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: RuleEffect;
}

export type ApprovalMode = "ask" | "balanced" | "auto";
/** What the badge shows: a mode, no Sidecar rules ("default"), or rules that are no mode. */
export type ApprovalState = ApprovalMode | "default" | "custom";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "balanced", "auto"];

export const MODE_LABELS: Record<ApprovalState, string> = {
  ask: "Ask",
  balanced: "Balanced",
  auto: "Auto",
  default: "Default",
  custom: "Custom",
};

/** One line each, shown in the menu: what the mode's rules do. */
export const MODE_LINES: Record<ApprovalMode | "default", string> = {
  ask: "Asks before every edit, command and web request.",
  balanced: "Reads and edits in the folder run; commands, web requests and outside files ask.",
  auto: "Nothing asks; destructive commands are blocked (rm -rf, force push).",
  default: "No Sidecar rules: the agent's own OpenCode rules decide.",
};

/** Shell commands Auto blocks (deny rules after its allow rules), Unix and Windows. */
export const DESTRUCTIVE_COMMANDS: readonly string[] = [
  "rm -rf *",
  "rm -fr *",
  "git push --force*",
  "git push -f*",
  "git push * --force*",
  "git push * -f",
  "git push * -f *",
  "git reset --hard*",
  "git clean -*f*",
  "Remove-Item *-Recurse*",
  "rmdir /s*",
  "rd /s*",
];

const rule = (action: string, effect: RuleEffect, resource = "*"): PermissionRule => ({
  action,
  resource,
  effect,
});

/** Each mode's catch-all rule per action, before it is fitted to the agent. */
const BASE: Record<ApprovalMode, PermissionRule[]> = {
  ask: [
    rule("edit", "ask"),
    rule("shell", "ask"),
    rule("external_directory", "ask"),
    rule("webfetch", "ask"),
    rule("websearch", "ask"),
  ],
  balanced: [
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("grep", "allow"),
    rule("edit", "allow"),
    rule("shell", "ask"),
    rule("external_directory", "ask"),
    rule("webfetch", "ask"),
    rule("websearch", "ask"),
  ],
  auto: [
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("grep", "allow"),
    rule("edit", "allow"),
    rule("shell", "allow"),
    rule("external_directory", "allow"),
    rule("webfetch", "allow"),
    rule("websearch", "allow"),
  ],
};

/** Actions every OpenCode build knows, offered in the rule editor beside the reported ones. */
export const KNOWN_ACTIONS: readonly string[] = [
  "shell",
  "edit",
  "read",
  "glob",
  "grep",
  "external_directory",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
];

/** OpenCode's pattern match (`Permission` in OpenCode 2.4), so previews agree with it. */
export function globMatch(value: string, pattern: string): boolean {
  let re = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // "npm test *" also matches "npm test".
  if (re.endsWith(" .*")) re = re.slice(0, -3) + "( .*)?";
  return new RegExp(`^${re}$`, "si").test(value.replace(/\\/g, "/"));
}

/** `*`, `**` or `* *`: a pattern that matches anything. */
export function isUniversal(pattern: string): boolean {
  return /^\*+(?: \*)?$/.test(pattern);
}

/** What OpenCode decides for one resource under these rules (last match wins; none = ask). */
export function evaluate(rules: readonly PermissionRule[], action: string, resource: string): RuleEffect {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (globMatch(action, r.action) && globMatch(resource, r.resource)) return r.effect;
  }
  return "ask";
}

/** The agent's catch-all effect for an action (its last `*` rule that applies), or ask. */
function catchAll(agent: readonly PermissionRule[], action: string): { effect: RuleEffect; at: number } {
  for (let i = agent.length - 1; i >= 0; i--) {
    const r = agent[i];
    if (globMatch(action, r.action) && isUniversal(r.resource)) return { effect: r.effect, at: i };
  }
  return { effect: "ask", at: -1 };
}

/**
 * The session rules for a mode, fitted to the agent's own rules (null when unknown): an
 * action the agent denies outright is left alone (Plan keeps not editing), an action the
 * agent already treats that way gets no rule, and otherwise the mode's catch-all replaces
 * the agent's while the agent's exceptions (such as asking before reading `.env` files)
 * are repeated after it so they still apply.
 */
export function presetRules(mode: ApprovalMode, agent: readonly PermissionRule[] | null): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const base of BASE[mode]) {
    if (!agent) {
      out.push({ ...base });
      continue;
    }
    const own = catchAll(agent, base.action);
    if (own.effect === "deny" || own.effect === base.effect) continue;
    out.push({ ...base });
    for (const r of agent.slice(own.at + 1))
      if (globMatch(base.action, r.action) && !isUniversal(r.resource) && r.effect !== base.effect)
        out.push({ action: base.action, resource: r.resource, effect: r.effect });
  }
  if (mode === "auto" && (!agent || catchAll(agent, "shell").effect !== "deny"))
    for (const c of DESTRUCTIVE_COMMANDS) out.push(rule("shell", "deny", c));
  return out;
}

export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect;
}

export function sameRules(a: readonly PermissionRule[], b: readonly PermissionRule[]): boolean {
  return a.length === b.length && a.every((r, i) => sameRule(r, b[i]));
}

/**
 * Reads a session's rules back: the mode whose rules they start with (fitted to the
 * agent, or to any other agent the session may have had when a mode was picked), and
 * the rules after them, which are the user's own. No mode: "default" when there are no
 * rules, "custom" otherwise. Two modes can be the same rules for an agent (Ask and
 * Balanced for Plan, which never edits): `prefer` (the mode last picked) breaks the tie.
 */
export function classifyRules(
  rules: readonly PermissionRule[],
  agents: ReadonlyArray<readonly PermissionRule[] | null>,
  prefer: ApprovalMode | null = null,
): { mode: ApprovalState; modeRules: PermissionRule[]; custom: PermissionRule[] } {
  let best: { mode: ApprovalMode; rules: PermissionRule[] } | null = null;
  for (const agent of [...agents, null])
    for (const mode of APPROVAL_MODES) {
      const p = presetRules(mode, agent);
      if (!p.length || p.length > rules.length || !p.every((r, i) => sameRule(r, rules[i]))) continue;
      const longer = !best || p.length > best.rules.length;
      const tie = best && p.length === best.rules.length && mode === prefer && best.mode !== prefer;
      if (longer || tie) best = { mode, rules: p };
    }
  if (best) return { mode: best.mode, modeRules: best.rules, custom: rules.slice(best.rules.length) };
  return { mode: rules.length ? "custom" : "default", modeRules: [], custom: [...rules] };
}

/** Splits a command at `&&`, `||`, `;` and `|` outside quotes; returns the first part. */
function firstCommand(command: string): string {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) return command.slice(0, i);
  }
  return command;
}

/** Words, keeping quoted parts (with their quotes) together. */
function words(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

const INTERPRETERS = new Set([
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
  "powershell.exe",
  "cmd",
  "cmd.exe",
]);

/**
 * A pattern for commands like this one: the program and up to two subcommand words
 * (`npm test`, `npm run build`, `git status`), then ` *`. An interpreter keeps the
 * script it runs (`node scripts/build.js *`); PowerShell's call operator keeps the
 * program it calls. Only the first of chained commands is used.
 */
export function generalizeCommand(command: string): string {
  const line = firstCommand(command.split(/\r?\n/)[0] ?? "").trim();
  const w = words(line);
  if (!w.length) return "";
  const keep = [w[0]];
  let i = 1;
  if ((w[0] === "&" || w[0] === ".") && w[1]) keep.push(w[i++]);
  const program = (
    keep[keep.length - 1]
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .pop() ?? ""
  ).toLowerCase();
  // A PowerShell cmdlet (Verb-Noun) or a path takes arguments, not subcommands.
  const cmdlet = /^[a-z]+-[a-z]+$/i.test(program);
  // A switch that names what runs: python -m, cmd /c, pwsh -File or -Command.
  if (INTERPRETERS.has(program) && /^(-m|\/[ck]|-file|-command)$/i.test(w[i] ?? "") && w[i + 1])
    keep.push(w[i], w[i + 1]);
  else if (INTERPRETERS.has(program) && w[i] && !w[i].startsWith("-")) keep.push(w[i]);
  else if (!cmdlet && !/[\\/]/.test(keep[keep.length - 1]))
    for (let n = 0; n < 2 && i < w.length && /^[a-z][\w:-]*$/i.test(w[i]); n++) keep.push(w[i++]);
  return `${keep.join(" ")} *`;
}

/**
 * A pattern that also covers requests like this one: commands as above, web requests by
 * their site, paths by their folder; other resources as they are.
 */
export function generalizePattern(action: string, resource: string): string {
  if (/(bash|shell|command|exec)/i.test(action)) return generalizeCommand(resource) || resource;
  const site = /^https?:\/\/[^/\\?#@\s*]+/i.exec(resource)?.[0];
  if (site) return `${site}/*`;
  const cut = Math.max(resource.lastIndexOf("/"), resource.lastIndexOf("\\"));
  if (cut > 0 && !resource.endsWith("*")) return `${resource.slice(0, cut + 1)}*`;
  return resource;
}

/** A rule list as OpenCode sends it; malformed entries are dropped. */
export function parseRules(v: unknown): PermissionRule[] {
  if (!Array.isArray(v)) return [];
  const out: PermissionRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.action !== "string" || typeof r.resource !== "string") continue;
    if (r.effect === "allow" || r.effect === "ask" || r.effect === "deny")
      out.push({ action: r.action, resource: r.resource, effect: r.effect });
  }
  return out;
}

/** Whether a webview-supplied rule is well formed (bounded strings, a known effect). */
export function isRule(v: unknown): v is PermissionRule {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).every((k) => k === "action" || k === "resource" || k === "effect") &&
    typeof r.action === "string" &&
    /^[\w.*?:-]{1,100}$/.test(r.action) &&
    typeof r.resource === "string" &&
    r.resource.trim().length > 0 &&
    r.resource.length <= 2000 &&
    (r.effect === "allow" || r.effect === "ask" || r.effect === "deny")
  );
}
