import type { DiffLine, FileChange, FileDiff, TodoEntry, TodoStatus, ToolCategory } from "./model";

export interface ToolDescription {
  title: string;
  category: ToolCategory;
  facts: Array<[string, string]>;
  command: string | null;
  path: string | null;
  pattern: string | null;
  /** The model's description of the call (not for subagents, whose description is their title). */
  description: string | null;
  /** For a write call: the first lines of the content and the total line count. */
  written: { lines: string[]; total: number } | null;
  /** For a subagent call: the exact prompt (capped at MAX_PROMPT characters). */
  prompt: string | null;
  /** For the todo tool: the list it writes. */
  todos: TodoEntry[] | null;
}

const MAX_PROMPT = 20_000;

/** Inline previews stay small: the full change is one click away in VS Code's diff editor. */
export const MAX_DIFF_LINES = 80;
const MAX_LINE = 400;

const MAX_FACT = 300;

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function clip(value: string, max = MAX_FACT): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function categorize(name: string): ToolCategory {
  const n = name.toLowerCase();
  // Before the edit rule: "todowrite" is a list, not a file write.
  if (/^todo(write|read)?$/.test(n)) return "todo";
  if (/^(generate_(image|video)|(experimental_)?(image|video)_generate)$/.test(n)) return "media";
  if (/^(read|view|cat|open)/.test(n)) return "read";
  if (/(grep|glob|find|search|list|ls|codesearch)/.test(n) && !/web/.test(n)) return "search";
  if (/(shell|bash|exec|command|terminal)/.test(n)) return "shell";
  if (/(edit|write|patch|replace|create|delete|move|rename)/.test(n)) return "edit";
  if (/(web|fetch|http|url)/.test(n)) return "web";
  if (/(task|agent|subagent)/.test(n)) return "agent";
  return "other";
}

/** Builds a compact, human-readable description of a tool call from its name and input. */
export function describeTool(name: string, input: Record<string, unknown> | null): ToolDescription {
  const category = categorize(name);
  const inp = input ?? {};
  const path =
    str(inp.path) ?? str(inp.filePath) ?? str(inp.file_path) ?? str(inp.file) ?? str(inp.target) ?? null;
  const pattern = str(inp.pattern) ?? str(inp.query) ?? str(inp.glob) ?? null;
  const command = category === "shell" ? (str(inp.command) ?? str(inp.cmd) ?? null) : null;
  const facts: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(inp)) {
    if (category === "todo" && key === "todos") continue; // shown as the checklist
    if (category === "edit" && /^(oldString|newString|content|patch|diff|old_string|new_string)$/.test(key)) {
      continue; // shown via the diff editor instead of inline
    }
    if (key === "command" && command) continue;
    const s = str(value);
    if (s !== null) facts.push([key, clip(s)]);
    else if (Array.isArray(value)) facts.push([key, clip(value.map((v) => str(v) ?? "…").join(", "))]);
  }

  let title: string;
  switch (category) {
    case "read":
      title = path ? `Read ${basename(path)}` : "Read file";
      break;
    case "search":
      title = pattern
        ? `Searched ${clip(pattern, 60)}`
        : path
          ? `Listed ${basename(path)}`
          : "Searched files";
      break;
    case "shell":
      title = command ? clip(firstLine(command), 80) : "Ran command";
      break;
    case "edit":
      title = path ? `Edited ${basename(path)}` : "Edited files";
      break;
    case "web": {
      const url = str(inp.url) ?? pattern;
      title = url ? `Fetched ${clip(url, 60)}` : "Web request";
      break;
    }
    case "agent": {
      const desc = str(inp.description) ?? str(inp.prompt);
      title = desc ? `Subagent: ${clip(firstLine(desc), 60)}` : "Ran subagent";
      break;
    }
    case "todo":
      title = todoSummary(todos(inp.todos));
      break;
    case "media":
      title = /video/.test(name.toLowerCase()) ? "Video" : "Image";
      break;
    default:
      title = name;
  }
  const content = typeof inp.content === "string" ? inp.content : null;
  return {
    title,
    category,
    facts,
    command,
    path,
    pattern,
    description:
      category === "agent"
        ? null
        : category === "media"
          ? (str(inp.prompt) ?? str(inp.description))
          : str(inp.description),
    written: category === "edit" && content !== null ? preview(content) : null,
    prompt: category === "agent" ? (str(inp.prompt)?.slice(0, MAX_PROMPT) ?? null) : null,
    todos: category === "todo" && Array.isArray(inp.todos) ? todos(inp.todos) : null,
  };
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

/** The well-formed entries of a todo list, in order; an unknown status counts as pending. */
function todos(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  const out: TodoEntry[] = [];
  for (const t of value) {
    if (!t || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    const content = str(rec.content);
    if (content === null || typeof rec.content !== "string") continue;
    const status = TODO_STATUSES.find((s) => s === rec.status) ?? "pending";
    out.push({ content, status });
  }
  return out;
}

/** OpenCode's own summary: "2/5 completed, 1 in progress, 2 pending". */
function todoSummary(list: TodoEntry[]): string {
  if (!list.length) return "Todos cleared";
  const count = (s: TodoStatus) => list.filter((t) => t.status === s).length;
  return [
    `${count("completed")}/${list.length} completed`,
    ...(["in_progress", "pending", "cancelled"] as const).flatMap((s) =>
      count(s) ? [`${count(s)} ${s.replace("_", " ")}`] : [],
    ),
  ].join(", ");
}

function preview(content: string): { lines: string[]; total: number } {
  const all = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return {
    lines: all.slice(0, MAX_DIFF_LINES).map((l) => l.slice(0, MAX_LINE)),
    total: content === "" ? 0 : all.length,
  };
}

/**
 * Lines of a unified patch for an inline preview: hunk lines only (file headers
 * dropped), a "gap" between hunks, capped at `max` lines with the rest counted.
 */
export function diffLines(patch: string, max = MAX_DIFF_LINES): { lines: DiffLine[]; more: number } {
  const lines: DiffLine[] = [];
  let total = 0;
  let hunks = 0;
  let inHunk = false;
  const push = (line: DiffLine) => {
    total++;
    if (lines.length < max) lines.push(line);
  };
  for (const raw of patch.split("\n")) {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l.startsWith("@@")) {
      if (hunks++ > 0) push({ t: "gap", text: "" });
      inHunk = true;
      continue;
    }
    // A new file's headers end the hunk (multi-file patches).
    if (/^(Index: |diff |={5,})/.test(l)) {
      inHunk = false;
      continue;
    }
    if (!inHunk || l.startsWith("\\")) continue;
    const t = l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === " " ? "ctx" : null;
    if (t) push({ t, text: l.slice(1, MAX_LINE + 1) });
  }
  return { lines, more: total - lines.length };
}

/** Inline diffs from edit-tool metadata (`metadata.files[].patch`). */
export function fileDiffsFromMetadata(metadata: Record<string, unknown> | null): FileDiff[] {
  const files = metadata?.files;
  if (!Array.isArray(files)) return [];
  const out: FileDiff[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const path = str(rec.file) ?? str(rec.path);
    const patch = typeof rec.patch === "string" ? rec.patch : null;
    if (!path || !patch) continue;
    const d = diffLines(patch);
    if (d.lines.length) out.push({ path, ...d });
  }
  return out;
}

function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i) + " …";
}

/**
 * Session a subagent tool call runs in: `metadata.sessionID` once OpenCode started it, or the
 * `sessionID` input when an existing subagent is continued (as OpenCode's TUI reads it).
 */
export function subagentSessionOf(
  metadata: Record<string, unknown> | null,
  input: Record<string, unknown> | null,
): string | null {
  return str(metadata?.sessionID) ?? str(metadata?.sessionId) ?? str(input?.sessionID) ?? null;
}

/** Extracts per-file change counts from edit-tool metadata (`metadata.files`). */
export function fileChangesFromMetadata(metadata: Record<string, unknown> | null): FileChange[] {
  const files = metadata?.files;
  if (!Array.isArray(files)) return [];
  const out: FileChange[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const path = str(rec.file) ?? str(rec.path);
    if (!path) continue;
    const status = rec.status === "added" || rec.status === "deleted" ? rec.status : "modified";
    out.push({
      path,
      additions: typeof rec.additions === "number" ? rec.additions : 0,
      deletions: typeof rec.deletions === "number" ? rec.deletions : 0,
      status,
    });
  }
  return out;
}

export function mergeFileChanges(into: Map<string, FileChange>, changes: FileChange[]): void {
  for (const c of changes) {
    const prev = into.get(c.path);
    if (!prev) into.set(c.path, { ...c });
    else
      into.set(c.path, {
        path: c.path,
        additions: prev.additions + c.additions,
        deletions: prev.deletions + c.deletions,
        status: prev.status === "added" ? "added" : c.status,
      });
  }
}
