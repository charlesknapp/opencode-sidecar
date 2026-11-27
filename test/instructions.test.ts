import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfigSources } from "../src/core/agents";
import {
  AGENTS_TEMPLATE,
  appendBullet,
  instructionView,
  rememberLine,
  startAgentsFile,
} from "../src/core/instructions";
import { HttpOpenCodeClient } from "../src/opencode/client";
import type { InstructionRow } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";

const files = (...list: string[]) => {
  const set = new Set(list.map((f) => f.toLowerCase()));
  return (f: string) => set.has(f.toLowerCase());
};
const brief = (rows: InstructionRow[]) => rows.map((r) => `${r.kind} ${r.label} ${r.state}`);

describe("the instruction files OpenCode reads", () => {
  const WIN = {
    home: "C:\\Users\\me",
    configDir: "C:\\Users\\me\\.config\\opencode",
    platform: "win32" as const,
    instructions: [],
  };

  it("reads each folder's AGENTS.md, or its CLAUDE.md, from the folder up to home (Windows)", () => {
    const v = instructionView({
      ...WIN,
      folder: "C:\\Users\\me\\code\\repo\\pkg",
      projectDir: "C:\\Users\\me\\code\\repo",
      isFile: files(
        "C:\\Users\\me\\code\\repo\\pkg\\CLAUDE.md",
        "C:\\Users\\me\\code\\repo\\AGENTS.md",
        "C:\\Users\\me\\code\\repo\\CLAUDE.md",
        "C:\\Users\\me\\code\\AGENTS.md",
        "C:\\Users\\me\\AGENTS.md",
      ),
    });
    assert.deepEqual(brief(v.rows), [
      "global ~/.config/opencode/AGENTS.md missing",
      "project CLAUDE.md loaded",
      "project ~/code/repo/AGENTS.md loaded",
      "project ~/code/repo/CLAUDE.md shadowed",
      "project ~/code/AGENTS.md loaded",
      "project ~/AGENTS.md loaded",
    ]);
    assert.equal(v.rows[3].note, "Not read: AGENTS.md beside it wins");
    assert.equal(v.projectFile, "C:\\Users\\me\\code\\repo\\AGENTS.md", "at the project root");
    assert.equal(v.projectExists, true);
    assert.equal(v.projectLabel, "~/code/repo/AGENTS.md");
    assert.equal(v.claudeFile, null, "the CLAUDE.md beside AGENTS.md is not read anyway");
  });

  it("stops at the project root for a folder outside home, and offers to create AGENTS.md", () => {
    const v = instructionView({
      folder: "/srv/repo",
      projectDir: "/srv/repo",
      home: "/home/me",
      configDir: "/home/me/.config/opencode",
      platform: "linux",
      instructions: [],
      isFile: files("/srv/AGENTS.md", "/home/me/.claude/CLAUDE.md"),
    });
    assert.deepEqual(brief(v.rows), [
      "global ~/.config/opencode/AGENTS.md missing",
      "global ~/.claude/CLAUDE.md loaded",
      "project AGENTS.md missing",
    ]);
    assert.equal(v.projectExists, false);
    assert.equal(v.projectFile, "/srv/repo/AGENTS.md");
    assert.equal(v.claudeFile, null);
  });

  it("does not read the Claude global file when the global AGENTS.md exists", () => {
    const v = instructionView({
      folder: "/home/me/repo",
      projectDir: "/home/me/repo",
      home: "/home/me",
      configDir: "/home/me/.config/opencode",
      platform: "linux",
      instructions: [],
      isFile: files(
        "/home/me/.config/opencode/AGENTS.md",
        "/home/me/.claude/CLAUDE.md",
        "/home/me/repo/AGENTS.md",
      ),
    });
    assert.deepEqual(brief(v.rows).slice(0, 2), [
      "global ~/.config/opencode/AGENTS.md loaded",
      "global ~/.claude/CLAUDE.md shadowed",
    ]);
    assert.equal(v.globalExists, true);
  });

  it("names the root's CLAUDE.md that a new AGENTS.md would stop OpenCode reading", () => {
    const at = (...list: string[]) =>
      instructionView({
        folder: "/home/me/repo/app",
        projectDir: "/home/me/repo",
        home: "/home/me",
        configDir: "/home/me/.config/opencode",
        platform: "linux",
        instructions: [],
        isFile: files(...list),
      });
    const v = at("/home/me/repo/CLAUDE.md");
    assert.equal(v.projectFile, "/home/me/repo/AGENTS.md", "Remember this always writes AGENTS.md");
    assert.equal(v.projectLabel, "~/repo/AGENTS.md");
    assert.equal(v.claudeFile, "/home/me/repo/CLAUDE.md");
    const missing = v.rows.find((r) => r.path === v.projectFile);
    assert.equal(missing?.state, "missing");
    assert.match(missing?.note ?? "", /stop reading CLAUDE\.md here; Create can copy/);
    // A CLAUDE.md below the root stays read: the new AGENTS.md goes to the root.
    const below = at("/home/me/repo/app/CLAUDE.md");
    assert.equal(below.claudeFile, null);
    assert.equal(below.rows.find((r) => r.path === below.projectFile)?.note, undefined);
  });

  it("reads only the global file for a folder outside OpenCode's project", () => {
    const v = instructionView({
      folder: "/tmp/x",
      projectDir: "/srv/repo",
      home: "/home/me",
      configDir: "/home/me/.config/opencode",
      platform: "linux",
      instructions: [],
      isFile: files("/tmp/x/AGENTS.md"),
    });
    assert.deepEqual(brief(v.rows), ["global ~/.config/opencode/AGENTS.md missing"]);
    assert.match(v.notes[0], /outside OpenCode's project/);
    assert.equal(v.projectFile, "/tmp/x/AGENTS.md");
    // Outside the project no CLAUDE.md is read, so a new AGENTS.md hides none.
    const claude = instructionView({
      folder: "/tmp/x",
      projectDir: "/srv/repo",
      home: "/home/me",
      configDir: "/home/me/.config/opencode",
      platform: "linux",
      instructions: [],
      isFile: files("/tmp/x/CLAUDE.md"),
    });
    assert.equal(claude.claudeFile, null);
  });

  it("lists the config's instructions: found up to the project root, ~/, absolute, globs and URLs", () => {
    const v = instructionView({
      ...WIN,
      folder: "C:\\work\\repo\\app",
      projectDir: "C:\\work\\repo",
      instructions: [
        { entry: "docs/rules.md", from: "C:\\work\\repo\\opencode.json" },
        { entry: "missing.md", from: "C:\\work\\repo\\opencode.json" },
        { entry: "~/notes/style.md", from: "C:\\Users\\me\\.config\\opencode\\opencode.json" },
        { entry: "C:\\shared\\team.md", from: "C:\\work\\repo\\opencode.json" },
        { entry: ".cursor/rules/*.md", from: "C:\\work\\repo\\opencode.json" },
        { entry: "https://example.com/rules.md", from: "C:\\work\\repo\\opencode.json" },
      ],
      isFile: files(
        "C:\\work\\repo\\AGENTS.md",
        "C:\\work\\repo\\docs\\rules.md",
        "C:\\Users\\me\\notes\\style.md",
      ),
    });
    assert.deepEqual(brief(v.rows.filter((r) => r.kind === "config")), [
      "config C:\\work\\repo\\docs\\rules.md loaded",
      "config C:\\work\\repo\\missing.md missing",
      "config ~/notes/style.md loaded",
      "config C:\\shared\\team.md missing",
      "config .cursor/rules/*.md pattern",
      "config https://example.com/rules.md url",
    ]);
    assert.equal(v.rows.find((r) => r.state === "url")?.note, "From C:\\work\\repo\\opencode.json");
  });

  it("reads the config documents' instructions and nothing else from them", () => {
    const sources = parseConfigSources([
      { type: "directory", path: "C:\\Users\\me\\.config\\opencode" },
      {
        type: "document",
        path: "C:\\repo\\opencode.json",
        info: { instructions: ["extra.md", "", 3], provider: { x: { options: { apiKey: "sk-secret" } } } },
      },
    ]);
    assert.deepEqual(sources.instructions, [{ entry: "extra.md", from: "C:\\repo\\opencode.json" }]);
    assert.ok(!JSON.stringify(sources).includes("sk-secret"));
    assert.equal(parseConfigSources([]).instructions, undefined);
  });
});

describe("Remember this", () => {
  it("makes one line of the text, without a bullet the user typed", () => {
    assert.equal(rememberLine("  - Run   npm test\n before pushing "), "Run npm test before pushing");
    assert.equal(rememberLine("* x"), "x");
    assert.equal(rememberLine("   "), "");
  });

  it("adds the line at the end in the file's line endings, keeping its BOM", () => {
    assert.equal(appendBullet("# Rules\n- a\n", "b"), "# Rules\n- a\n- b\n");
    assert.equal(appendBullet("# Rules\r\n- a", "b"), "# Rules\r\n- a\r\n- b\r\n");
    assert.equal(appendBullet("\uFEFF# R\r\n", "b"), "\uFEFF# R\r\n- b\r\n");
  });

  it("starts a missing or empty file from the template", () => {
    assert.equal(appendBullet(null, "Use pnpm"), `${AGENTS_TEMPLATE}- Use pnpm\n`);
    assert.equal(appendBullet("\n\n", "x"), `${AGENTS_TEMPLATE}- x\n`);
    assert.ok(AGENTS_TEMPLATE.endsWith("## Notes\n\n"));
  });

  it("starts a new AGENTS.md from a copy of CLAUDE.md, keeping its line endings and BOM", () => {
    assert.equal(startAgentsFile(null), AGENTS_TEMPLATE);
    assert.equal(startAgentsFile(" \n"), AGENTS_TEMPLATE, "an empty CLAUDE.md gives the template");
    assert.equal(startAgentsFile("﻿"), AGENTS_TEMPLATE);
    assert.equal(
      appendBullet(startAgentsFile("# Claude\n- use tabs\n"), "Use pnpm"),
      "# Claude\n- use tabs\n- Use pnpm\n",
    );
    assert.equal(
      appendBullet(startAgentsFile("﻿# Claude\r\n- use tabs"), "Use pnpm"),
      "﻿# Claude\r\n- use tabs\r\n- Use pnpm\r\n",
    );
    assert.equal(appendBullet(startAgentsFile(null), "x"), appendBullet(null, "x"));
  });

  it("accepts the panel's messages and nothing else", () => {
    for (const m of [
      { type: "loadInstructions" },
      { type: "openInstruction", path: "C:\\repo\\AGENTS.md" },
      { type: "createInstructions", scope: "project" },
      { type: "createInstructions", scope: "global" },
      { type: "remember", text: "Use pnpm" },
      { type: "remember", text: "" },
    ])
      assert.deepEqual(parseWebviewMessage(m), m, m.type);
    assert.equal(parseWebviewMessage({ type: "createInstructions", scope: "system" }), undefined);
    assert.equal(parseWebviewMessage({ type: "remember", text: "x".repeat(20_001) }), undefined);
    assert.equal(parseWebviewMessage({ type: "remember", text: "x", file: "/etc/passwd" }), undefined);
    assert.equal(parseWebviewMessage({ type: "openInstruction", path: "" }), undefined);
  });

  it("reads the project folder from OpenCode's location", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({
          directory: "C:\\repo\\src",
          project: { id: "p1", directory: "C:\\repo", canonical: "C:\\repo" },
        }),
      )) as typeof fetch;
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn);
    assert.equal(await c.projectDirectory("C:\\repo\\src"), "C:\\repo");
    const none = new HttpOpenCodeClient(
      { url: "http://127.0.0.1:9" },
      (async () => new Response(JSON.stringify({ directory: "/x" }))) as typeof fetch,
    );
    assert.equal(await none.projectDirectory("/x"), null);
  });
});
