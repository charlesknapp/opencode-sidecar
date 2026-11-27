// The instruction files OpenCode 2.4.2 reads for a folder, worked out the way its build
// does (checked live by the hash OpenCode reports for them, `session.instructions.updated`):
//
// - Global: `<config>/AGENTS.md`, or without it `~/.claude/CLAUDE.md`.
// - Project: every folder from the open one up to the home folder (or, for a folder outside
//   home, up to the project root): its AGENTS.md, or its CLAUDE.md when it has none. Only
//   when the folder is inside OpenCode's project. AGENTS.md files below the folder load
//   later, as the agent reads there, and are not listed.
// - The config's `instructions`: relative paths and globs from the folder up to the project
//   root, `~/` from home, absolute paths as written, http(s) URLs fetched by OpenCode.
//
// VS Code stays out of this module; the file system is passed in.

import type { InstructionRow, InstructionsView } from "../shared/model";
import { isInside, pathFor, type ConfigInstruction } from "./agents";

export interface InstructionInput {
  folder: string;
  /** OpenCode's project folder for it (`GET /api/location`); null when unknown. */
  projectDir: string | null;
  home: string;
  /** OpenCode's global config folder (`GET /api/config`'s first directory). */
  configDir: string;
  instructions: ConfigInstruction[];
  isFile: (file: string) => boolean;
  platform?: NodeJS.Platform;
}

/** What a new AGENTS.md starts with. */
export const AGENTS_TEMPLATE = [
  "# Project instructions",
  "",
  "OpenCode reads this file at the start of every session in this project.",
  "Keep it short: how to build and test, conventions, and things to avoid.",
  "",
  "## Notes",
  "",
  "",
].join("\n");

const GLOB = /[*?[\]{}]/;

/** The folders from `start` up to `stop` (both included); just `start` when `stop` is not above it. */
function upFrom(start: string, stop: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  if (!isInside(start, stop, platform)) return [start];
  const out: string[] = [];
  for (let d = p.resolve(start); ; d = p.dirname(d)) {
    out.push(d);
    if (isInside(stop, d, platform) || p.dirname(d) === d) return out;
  }
}

export function instructionView(input: InstructionInput): InstructionsView {
  const platform = input.platform ?? process.platform;
  const p = pathFor(platform);
  const { folder, home, isFile } = input;
  const rows: InstructionRow[] = [];
  const seen = new Set<string>();
  const key = (f: string) => (platform === "win32" ? p.resolve(f).toLowerCase() : p.resolve(f));
  const label = (f: string) => {
    if (isInside(f, folder, platform)) return p.relative(folder, f).split(p.sep).join("/") || ".";
    if (isInside(f, home, platform)) return `~/${p.relative(home, f).split(p.sep).join("/")}`;
    return f;
  };
  const add = (row: Omit<InstructionRow, "label"> & { label?: string }) => {
    const k = row.state === "url" || row.state === "pattern" ? `${row.kind}:${row.path}` : key(row.path);
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ ...row, label: row.label ?? label(row.path) });
  };

  // Global.
  const globalFile = p.join(input.configDir, "AGENTS.md");
  const claudeGlobal = p.join(home, ".claude", "CLAUDE.md");
  const globalExists = isFile(globalFile);
  add({ path: globalFile, kind: "global", state: globalExists ? "loaded" : "missing" });
  if (isFile(claudeGlobal))
    add({
      path: claudeGlobal,
      kind: "global",
      state: globalExists ? "shadowed" : "loaded",
      ...(globalExists ? { note: "Not read while the global AGENTS.md exists" } : {}),
    });

  // Project.
  const project = input.projectDir ?? folder;
  const inProject = isInside(folder, project, platform);
  const root = inProject ? project : folder;
  const notes: string[] = [];
  if (inProject) {
    const stop = isInside(folder, home, platform) ? home : project;
    for (const dir of upFrom(folder, stop, platform)) {
      const agents = p.join(dir, "AGENTS.md");
      const claude = p.join(dir, "CLAUDE.md");
      const hasAgents = isFile(agents);
      if (hasAgents) add({ path: agents, kind: "project", state: "loaded" });
      if (isFile(claude))
        add({
          path: claude,
          kind: "project",
          state: hasAgents ? "shadowed" : "loaded",
          ...(hasAgents ? { note: "Not read: AGENTS.md beside it wins" } : {}),
        });
    }
  } else notes.push("This folder is outside OpenCode's project, so OpenCode reads only the global file.");
  const projectFile = p.join(root, "AGENTS.md");
  const projectExists = isFile(projectFile);
  if (!projectExists) add({ path: projectFile, kind: "project", state: "missing" });

  // The config's `instructions`.
  for (const { entry, from } of input.instructions) {
    const note = `From ${label(from)}`;
    if (/^https?:\/\//i.test(entry)) {
      add({ path: entry, label: entry, kind: "config", state: "url", note });
      continue;
    }
    const expanded = entry.startsWith("~/") ? p.join(home, entry.slice(2)) : entry;
    if (GLOB.test(expanded)) {
      add({ path: expanded, label: entry, kind: "config", state: "pattern", note });
      continue;
    }
    if (p.isAbsolute(expanded)) {
      add({ path: expanded, kind: "config", state: isFile(expanded) ? "loaded" : "missing", note });
      continue;
    }
    const found = upFrom(folder, root, platform)
      .map((d) => p.join(d, expanded))
      .filter((f) => isFile(f));
    for (const f of found) add({ path: f, kind: "config", state: "loaded", note });
    if (!found.length) add({ path: p.join(root, expanded), kind: "config", state: "missing", note });
  }

  // "Remember this" adds to the project file OpenCode reads: AGENTS.md, or the root's
  // CLAUDE.md while there is no AGENTS.md (a new AGENTS.md would hide it).
  const rootClaude = p.join(root, "CLAUDE.md");
  const rememberFile = !projectExists && isFile(rootClaude) ? rootClaude : projectFile;
  return {
    rows,
    projectFile,
    projectExists,
    rememberFile,
    rememberLabel: label(rememberFile),
    globalFile,
    globalExists,
    notes,
    canInit: false,
  };
}

/** Text for one bullet: a single line, without a leading bullet the user typed. */
export function rememberLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s+/, "");
}

/**
 * `content` with `- line` added at the end, in the file's own line endings (and its BOM);
 * a missing or empty file starts from the template.
 */
export function appendBullet(content: string | null, line: string): string {
  const bom = content?.startsWith("\uFEFF") ? "\uFEFF" : "";
  let body = (content ?? "").slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  if (!body.trim()) body = AGENTS_TEMPLATE.split("\n").join(eol);
  else if (!body.endsWith("\n")) body += eol;
  return `${bom}${body}- ${rememberLine(line)}${eol}`;
}
