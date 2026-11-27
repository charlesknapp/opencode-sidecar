// Builds the prompt for "Write commit message with OpenCode": the staged diff (or the
// agent's changes), cut to a size a small model handles, and the repository's recent
// subjects as examples of its style. The reply is cleaned into a plain message.

/** The most diff text a prompt carries, and the most one file may take of it. */
export const MAX_DIFF_CHARS = 12_000;
export const MAX_FILE_CHARS = 4_000;
/** Recent subjects shown as style examples. */
export const STYLE_EXAMPLES = 10;
/** Unchanged lines kept on each side of a change in full-file patches. */
const CONTEXT_LINES = 3;

export interface DiffSection {
  path: string;
  patch: string;
}

/** Splits `git diff` output into one section per file. */
export function splitGitDiff(diff: string): DiffSection[] {
  const out: DiffSection[] = [];
  for (const chunk of diff.replace(/\r\n/g, "\n").split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const head = /^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?)$/m.exec(chunk);
    out.push({ path: head?.[2] ?? head?.[1] ?? "", patch: chunk.replace(/\n+$/, "") });
  }
  return out;
}

/**
 * Drops unchanged lines further than a few lines from any change (OpenCode's session
 * diff carries whole files), marking each gap with `…`.
 */
export function trimContext(patch: string, keep = CONTEXT_LINES): string {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const changed = lines.map((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  const near = (i: number) => {
    for (let j = Math.max(0, i - keep); j <= Math.min(lines.length - 1, i + keep); j++)
      if (changed[j]) return true;
    return false;
  };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith(" ") || near(i)) out.push(l);
    else if (out.at(-1) !== " …") out.push(" …");
  }
  return out.join("\n");
}

const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock)$/;

/**
 * The diff text for the prompt: each file trimmed and cut to MAX_FILE_CHARS, lockfiles
 * named but not shown, and files past MAX_DIFF_CHARS listed by name only.
 */
export function diffForPrompt(
  sections: readonly DiffSection[],
  max = MAX_DIFF_CHARS,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  const unseen: string[] = [];
  let used = 0;
  let truncated = false;
  for (const s of sections) {
    if (LOCKFILE.test(s.path)) {
      parts.push(`(${s.path}: lockfile changed, diff left out)`);
      continue;
    }
    let patch = trimContext(s.patch);
    if (patch.length > MAX_FILE_CHARS) {
      const cut = patch.lastIndexOf("\n", MAX_FILE_CHARS);
      const rest = patch.slice(cut > 0 ? cut : MAX_FILE_CHARS).split("\n").length;
      patch = `${patch.slice(0, cut > 0 ? cut : MAX_FILE_CHARS)}\n… (${rest} more lines of ${s.path} left out)`;
      truncated = true;
    }
    if (used + patch.length > max && parts.length) {
      unseen.push(s.path);
      truncated = true;
      continue;
    }
    parts.push(patch);
    used += patch.length;
  }
  if (unseen.length) parts.push(`(Also changed, diff left out: ${unseen.join(", ")})`);
  return { text: parts.join("\n\n"), truncated };
}

/** Subjects to show as examples: not merges or reverts, at most STYLE_EXAMPLES. */
export function styleExamples(messages: readonly string[]): string[] {
  return messages
    .map((m) => m.split(/\r?\n/)[0].trim())
    .filter((s) => s && !/^(Merge|Revert) /.test(s))
    .slice(0, STYLE_EXAMPLES);
}

export function buildCommitPrompt(input: {
  sections: readonly DiffSection[];
  recent: readonly string[];
  source: "staged" | "agent";
}): string {
  const examples = styleExamples(input.recent);
  const { text } = diffForPrompt(input.sections);
  const lines = [
    "Write a git commit message for the changes below.",
    "Reply with the commit message only: no code fences, no quotes, no explanation.",
    "Use a short subject line (under 72 characters), then, only if it helps, a blank line and a short body.",
  ];
  if (examples.length)
    lines.push(
      "Match the style of this repository's recent commit subjects:",
      ...examples.map((s) => `- ${s}`),
    );
  lines.push(
    "",
    input.source === "staged" ? "Staged changes:" : "Changes made by the agent (not yet staged):",
    text,
  );
  return lines.join("\n");
}

/** The model's reply as a commit message: fences, quotes and a "Commit message:" label removed. */
export function cleanCommitMessage(reply: string): string {
  let t = reply.replace(/\r\n/g, "\n").trim();
  // Reasoning some models put before the answer.
  t = t.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  const fenced = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(t);
  if (fenced) t = fenced[2].trim();
  t = t.replace(/^(\*\*)?commit message:?(\*\*)?:?\s*/i, "");
  if (/^(["'`])[^\n]*\1$/.test(t)) t = t.slice(1, -1);
  return t
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
