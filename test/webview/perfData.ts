// A long session for the webview's performance check: turns of a prompt, the agent's
// thinking, a file read, an edit with a large diff, a shell command with a large output and
// a Markdown answer, as OpenCode's tools report them (outputs and diffs at Sidecar's caps).

import type { DiffLine, TranscriptItem } from "../../src/shared/model";
import { emptyDetail, MAX_TOOL_OUTPUT } from "../../src/shared/transcript";
import { MAX_DIFF_LINES } from "../../src/shared/tools";

const CODE = [
  "export async function refreshToken(session: Session, opts: RefreshOptions = {}): Promise<Token> {",
  "  const now = Date.now();",
  "  if (session.token && session.token.expires > now + (opts.skewMs ?? 30_000)) return session.token;",
  '  const res = await fetch(`${session.base}/oauth/token`, { method: "POST", body: form(session) });',
  "  if (!res.ok) throw new AuthError(res.status, await res.text());",
  "  return (session.token = parseToken(await res.json()));",
  "}",
];

const ANSWER =
  "## What changed\n\n- `refreshToken` now checks the clock skew\n- the retry waits **twice** as long\n\n" +
  "| File | Lines |\n|--|--|\n| src/auth/token.ts | +12 −4 |\n\n```ts\nconst skew = opts.skewMs ?? 30_000;\n```\n\nThe tests pass.";

function diff(turn: number): DiffLine[] {
  const lines: DiffLine[] = [];
  for (let i = 0; lines.length < MAX_DIFF_LINES; i++) {
    const text = CODE[i % CODE.length].replace("refreshToken", `refreshToken${turn}`);
    lines.push({ t: i % 5 === 0 ? "del" : i % 5 === 1 ? "add" : "ctx", text });
  }
  return lines;
}

function output(turn: number): string {
  let s = "";
  for (let i = 0; s.length < MAX_TOOL_OUTPUT; i++)
    s += `  ✓ auth/token.test.ts › refreshes token ${turn}.${i} (${(i * 7) % 90} ms)\n`;
  return s.slice(0, MAX_TOOL_OUTPUT);
}

/** About `messages` timeline entries: turns of six (a prompt, thinking, read, edit, shell, answer). */
export function longSession(messages: number): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const base = Date.UTC(2026, 10, 20, 9);
  for (let turn = 0; out.length < messages; turn++) {
    const at = base + turn * 60_000;
    const tool = (id: string, name: string, title: string, category: "read" | "edit" | "shell") => ({
      kind: "tool" as const,
      id: `tool:${id}${turn}`,
      name,
      title,
      category,
      status: "completed" as const,
      detail: emptyDetail(),
    });
    const read = tool("r", "read", "Read token.ts", "read");
    read.detail.path = "/w/app/src/auth/token.ts";
    const edit = tool("e", "edit", "Edited token.ts", "edit");
    edit.detail.path = "/w/app/src/auth/token.ts";
    edit.detail.files = [{ path: "src/auth/token.ts", status: "modified", additions: 16, deletions: 16 }];
    edit.detail.diffs = [{ path: "src/auth/token.ts", lines: diff(turn), more: 24 }];
    const shell = tool("s", "shell", "npm test", "shell");
    shell.detail.command = "npm test -- auth";
    shell.detail.output = output(turn);
    shell.detail.outputTruncated = true;
    shell.detail.exitCode = 0;
    out.push(
      {
        kind: "user",
        id: `user:u${turn}`,
        text: `Make the token refresh handle clock skew (${turn}).`,
        attachments: [],
        time: at,
      },
      {
        kind: "reasoning",
        id: `think:t${turn}:0`,
        text: "Looking at the refresh path first.",
        streaming: false,
        started: at + 1000,
        ended: at + 4000,
      },
      read,
      edit,
      shell,
      { kind: "assistant", id: `text:a${turn}:0`, text: ANSWER, streaming: false, time: at + 30_000 },
    );
  }
  return out.slice(0, messages);
}
