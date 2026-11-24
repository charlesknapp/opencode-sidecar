import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionMarkdown } from "../src/core/exportMarkdown";
import type { TranscriptItem } from "../src/shared/model";

const tool = (over: Partial<Extract<TranscriptItem, { kind: "tool" }>["detail"]> = {}): TranscriptItem => ({
  kind: "tool",
  id: "tool:1",
  name: "Shell",
  title: "Run the tests",
  category: "shell",
  status: "completed",
  detail: {
    facts: [],
    command: "npm test",
    cwd: null,
    output: "lots of output that is left out",
    outputTruncated: false,
    exitCode: 1,
    files: [],
    error: null,
    subagent: null,
    ...over,
  },
});

describe("session export to Markdown", () => {
  it("writes the conversation: prompts, answers, tool calls, decisions and reports", () => {
    const md = sessionMarkdown(
      [
        { kind: "user", id: "user:u1", text: "Why do tests fail?", attachments: ["src/a.ts"] },
        { kind: "reasoning", id: "r1", text: "secret thinking", streaming: false },
        { kind: "assistant", id: "text:a1", text: "Let me run them.", streaming: false },
        tool(),
        {
          kind: "permission",
          id: "perm:p1",
          sensitive: [],
          status: "reject",
          feedback: "Use the dry run",
          request: {
            id: "p1",
            sessionID: "s",
            action: "bash",
            resources: ["rm -rf dist"],
            canAlways: false,
            message: null,
            toolId: null,
          },
        },
        {
          kind: "turn-summary",
          id: "ts1",
          files: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
        },
        {
          kind: "handback",
          id: "hb1",
          childID: "c",
          agent: "explore",
          state: "completed",
          description: "Map callers",
          report: "Two callers.\nBoth in src/.",
        },
        { kind: "user", id: "user:u2", text: "Thanks", attachments: [] },
        { kind: "assistant", id: "text:a2", text: "Done.", streaming: false },
      ],
      { title: "Flaky tests", exported: 0, model: "p/m", directory: "/repo" },
    );
    assert.equal(
      md,
      [
        "# Flaky tests",
        "",
        "_Exported from Sidecar for OpenCode · model `p/m` · in `/repo`_",
        "",
        "## You",
        "",
        "Why do tests fail?",
        "",
        "Attached: `src/a.ts`",
        "",
        "## OpenCode",
        "",
        "Let me run them.",
        "",
        "- **Shell** Run the tests",
        "",
        "```sh",
        "npm test",
        "```",
        "  Exit code 1",
        "",
        "- Permission `bash rm -rf dist`: declined",
        "  Instead: Use the dry run",
        "",
        "Changed: `src/a.ts` +3 −1",
        "",
        "> **Report from explore** · Map callers",
        ">",
        "> Two callers.",
        "> Both in src/.",
        "",
        "## You",
        "",
        "Thanks",
        "",
        "## OpenCode",
        "",
        "Done.",
        "",
      ].join("\n"),
    );
    assert.ok(!md.includes("secret thinking"), "thinking is left out");
    assert.ok(!md.includes("lots of output"), "tool output is left out");
  });

  it("keeps a command containing backticks inside its code block", () => {
    const md = sessionMarkdown([tool({ command: "echo ```x```", exitCode: 0 })], { title: "T", exported: 0 });
    assert.match(md, /````sh\necho ```x```\n````/);
  });
});
