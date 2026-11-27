import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
  draftFromFile,
  fileModel,
  isLegacy,
  legacyRules,
  newAgentFile,
  newAgentFileWithRules,
  parseAgentFile,
  setEntry,
  switchesToRules,
  toAgentName,
  updateAgentFile,
  validateAgentName,
} from "../src/core/agentFile";
import {
  agentFilePath,
  deriveAgentRows,
  globalConfigDir,
  globalStorageDirs,
  isInside,
  modeFileCandidates,
  modeRuleFiles,
  parseAgentDetail,
  parseConfigSources,
  scanAgentFiles,
  type AgentDetail,
} from "../src/core/agents";
import {
  importComments,
  isOrchestrator,
  matchModel,
  modeToAgent,
  parseModesFile,
  regexToGlobs,
} from "../src/core/roomodes";
import { SessionController } from "../src/core/sessionController";
import { parseYaml, yamlEntry, yamlString, YamlError } from "../src/core/yaml";
import { evaluate } from "../src/shared/approval";
import type { AgentDraft, ModelOption } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const draft = (o: Partial<AgentDraft> = {}): AgentDraft => ({
  name: "docs",
  description: "Writes docs",
  mode: "primary",
  model: null,
  variant: null,
  temperature: null,
  permissions: {},
  prompt: "You write docs.",
  scope: "project",
  ...o,
});

const MODELS: ModelOption[] = [
  {
    key: "opencode/big-pickle",
    providerID: "opencode",
    id: "big-pickle",
    name: "Big Pickle",
    providerName: "OpenCode",
    contextLimit: 200000,
    variants: ["high"],
  },
  {
    key: "anthropic/claude-sonnet-5-5",
    providerID: "anthropic",
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    providerName: "Anthropic",
    contextLimit: 200000,
    variants: [],
  },
];

describe("YAML subset", () => {
  it("reads mappings, lists, compact nested lists and comments", () => {
    const v = parseYaml(
      [
        "# leading comment",
        "a: 1 # trailing",
        "b:",
        "  - x",
        "  - - edit",
        "    - fileRegex: \\.md$",
        "      description: Markdown",
        "  - k: v",
        "    k2: v2",
        "c:",
        "- same indent list",
        "d: {x: 1, y: [a, 'b c'], z: \"q\"}",
        "e: [ ]",
        '"quoted key": yes',
      ].join("\n"),
    );
    assert.deepEqual(v, {
      a: 1,
      b: ["x", ["edit", { fileRegex: "\\.md$", description: "Markdown" }], { k: "v", k2: "v2" }],
      c: ["same indent list"],
      d: { x: 1, y: ["a", "b c"], z: "q" },
      e: [],
      "quoted key": "yes",
    });
  });

  it("reads scalars: null, booleans, numbers, quoted strings and escapes", () => {
    assert.deepEqual(
      parseYaml(
        "n: ~\nm:\nt: true\nf: False\ni: -12\nx: 0.25\ne: 1e3\ns: 'it''s'\nd: \"tab\\there \\u00e9 \\\"q\\\"\"\nurl: http://a.b/c#x\np: C:\\Users\\me",
      ),
      {
        n: null,
        m: null,
        t: true,
        f: false,
        i: -12,
        x: 0.25,
        e: 1000,
        s: "it's",
        d: 'tab\there é "q"',
        url: "http://a.b/c#x",
        p: "C:\\Users\\me",
      },
    );
  });

  it("reads block scalars with chomping and folding", () => {
    const v = parseYaml(
      [
        "lit: |",
        "  one",
        "    two",
        "",
        "  three",
        "",
        "keep: |+",
        "  k",
        "",
        "strip: >-",
        "  a",
        "  b",
        "",
        "  c",
        "fold: >",
        "  x",
        "    y",
        "  z",
        "next: 1",
      ].join("\n"),
    );
    assert.deepEqual(v, {
      lit: "one\n  two\n\nthree\n",
      keep: "k\n\n",
      strip: "a b\nc",
      fold: "x\n  y\nz\n",
      next: 1,
    });
  });

  it("reads multi-line plain and quoted scalars", () => {
    assert.deepEqual(parseYaml('a: one\n  two\n\n  three\nb: "x\n  y"\nc: 1'), {
      a: "one two\nthree",
      b: "x y",
      c: 1,
    });
  });

  it("refuses what it does not support, naming the line", () => {
    for (const [src, line] of [
      ["a: &x 1", 1],
      ["a: 1\nb: *x", 2],
      ["a: !!str 1", 1],
      ["a: [1, 2", 1],
      ["a: 1\na: 2", 2],
      ["a:\n\tb: 1", 2],
      ["a: 1\n  b: 2", 2],
      ['a: "bad \\q"', 1],
    ] as const) {
      assert.throws(
        () => parseYaml(src),
        (e: unknown) => e instanceof YamlError && e.line === line,
        src,
      );
    }
  });

  it("writes strings that read back the same", () => {
    for (const s of [
      "plain",
      "*",
      "a: b",
      "# x",
      "true",
      "12",
      "",
      " lead",
      "multi\nline",
      'quote"s',
      "C:\\x",
      "- dash",
      "ünïcode",
    ]) {
      const out = parseYaml(`k: ${yamlString(s)}`) as Record<string, unknown>;
      assert.equal(out.k, s, s);
    }
    assert.equal(yamlString("*"), '"*"');
    assert.equal(yamlString("docs-writer"), "docs-writer");
  });

  it("writes nested entries as block YAML", () => {
    const lines = yamlEntry("permissions", [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*.md", effect: "allow" },
    ]);
    assert.deepEqual(lines, [
      "permissions:",
      "  - action: edit",
      '    resource: "*"',
      "    effect: deny",
      "  - action: edit",
      '    resource: "*.md"',
      "    effect: allow",
    ]);
    assert.deepEqual(parseYaml(lines.join("\n")), {
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "*.md", effect: "allow" },
      ],
    });
    assert.deepEqual(yamlEntry("request", { body: { temperature: 0.2 } }), [
      "request:",
      "  body:",
      "    temperature: 0.2",
    ]);
  });
});

describe("agent names", () => {
  it("accepts file-safe ids and refuses the rest", () => {
    assert.equal(validateAgentName("docs-writer_2"), null);
    assert.equal(validateAgentName("A1"), null);
    assert.match(validateAgentName("")!, /name/);
    assert.match(validateAgentName("-x")!, /letters/);
    assert.match(validateAgentName("has space")!, /letters/);
    assert.match(validateAgentName("team/review")!, /letters/);
    assert.match(validateAgentName("..")!, /letters/);
    assert.match(validateAgentName("x".repeat(65))!, /64/);
  });

  it("refuses Windows device names and names taken in another case", () => {
    for (const n of ["con", "NUL", "com1", "Lpt9", "aux"]) assert.match(validateAgentName(n)!, /Windows/, n);
    assert.match(validateAgentName("Build", ["build", "plan"])!, /exists/);
    assert.equal(validateAgentName("builder", ["build"]), null);
  });

  it("turns mode slugs and titles into valid names", () => {
    assert.equal(toAgentName("docs-writer"), "docs-writer");
    assert.equal(toAgentName("📝 Documentation Writer!"), "Documentation-Writer");
    assert.equal(toAgentName("Café crème"), "Cafe-creme");
    assert.equal(toAgentName("con"), "con-agent");
    assert.equal(toAgentName("!!!"), "agent");
    for (const s of ["a b", "x/y", "--z--", "é"]) assert.equal(validateAgentName(toAgentName(s)), null, s);
  });
});

describe("agent files", () => {
  const FULL = [
    "---",
    "# My reviewer",
    "description: Reviews changes",
    "mode: subagent",
    "model: opencode/big-pickle#high",
    "custom_key: keep me # with a comment",
    "permissions:",
    "  - action: edit",
    '    resource: "*"',
    "    effect: deny",
    '  - { action: shell, resource: "git *", effect: allow }',
    'color: "#ff6b6b"',
    "---",
    "",
    "Review the diff.",
    "",
  ].join("\n");

  it("reads the form's fields", () => {
    const { draft: d, otherRules, legacy } = draftFromFile(FULL, "reviewer", "project");
    assert.deepEqual(d, {
      name: "reviewer",
      description: "Reviews changes",
      mode: "subagent",
      model: "opencode/big-pickle",
      variant: "high",
      temperature: null,
      permissions: { edit: "deny" },
      prompt: "Review the diff.",
      scope: "project",
    });
    assert.equal(otherRules, 1);
    assert.equal(legacy, false);
  });

  it("writes back exactly what it read when nothing changed (LF, CRLF, BOM, no body)", () => {
    const crlf = FULL.replace(/\n/g, "\r\n");
    for (const src of [FULL, crlf, "\uFEFF" + FULL, "---\nmode: all\n---", "No frontmatter\n", ""]) {
      const d = draftFromFile(src, "x", "project").draft;
      assert.equal(updateAgentFile(src, d), src, JSON.stringify(src));
    }
  });

  it("changes only what changed, keeping unknown keys, comments and line endings", () => {
    const crlf = FULL.replace(/\n/g, "\r\n");
    const d = draftFromFile(crlf, "reviewer", "project").draft;
    const out = updateAgentFile(crlf, { ...d, description: "Reviews carefully", temperature: 0.3 });
    assert.ok(!/[^\r]\n/.test(out), "CRLF kept");
    const lines = out.split("\r\n");
    assert.equal(lines[1], "# My reviewer");
    assert.equal(lines[2], "description: Reviews carefully");
    assert.ok(lines.includes("custom_key: keep me # with a comment"));
    assert.ok(
      lines.includes('  - { action: shell, resource: "git *", effect: allow }'),
      "untouched rules stay as written",
    );
    assert.ok(out.endsWith("\r\nReview the diff.\r\n"));
    const back = draftFromFile(out, "reviewer", "project").draft;
    assert.equal(back.temperature, 0.3);
    assert.equal(parseAgentFile(out).data.custom_key, "keep me");
  });

  it("rewrites the rules: a changed switch in its place, a new one first, the others kept", () => {
    const d = draftFromFile(FULL, "reviewer", "project").draft;
    const out = updateAgentFile(FULL, { ...d, permissions: { edit: "ask", webfetch: "deny" } });
    assert.deepEqual(parseAgentFile(out).data.permissions, [
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "git *", effect: "allow" },
    ]);
    // A catch-all after a narrower rule stays after it, so the narrower one stays overruled.
    assert.deepEqual(
      switchesToRules({ shell: "deny" }, [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "shell", resource: "git *", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
      ]),
      [
        { action: "shell", resource: "git *", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
      ],
    );
    assert.ok(out.includes("# My reviewer") && out.includes("custom_key"));
    // All switches back to inherit: only the kept rule remains.
    const none = updateAgentFile(out, { ...d, permissions: {} });
    assert.deepEqual(parseAgentFile(none).data.permissions, [
      { action: "shell", resource: "git *", effect: "allow" },
    ]);
  });

  it("removes cleared fields and changes the model and prompt", () => {
    const d = draftFromFile(FULL, "reviewer", "project").draft;
    const out = updateAgentFile(FULL, {
      ...d,
      description: "",
      model: "anthropic/claude-sonnet-5-5",
      variant: null,
      prompt: "New\r\nprompt",
    });
    const f = parseAgentFile(out);
    assert.equal(f.data.description, undefined);
    assert.equal(f.data.model, "anthropic/claude-sonnet-5-5");
    assert.equal(draftFromFile(out, "reviewer", "project").draft.prompt, "New\nprompt");
    assert.ok(!out.includes("\r"));
  });

  it("adds frontmatter to a file that had none", () => {
    const out = updateAgentFile(
      "Just a prompt\n",
      draft({ name: "x", prompt: "Just a prompt", mode: "subagent", description: "" }),
    );
    assert.equal(out, "---\nmode: subagent\n---\nJust a prompt\n");
  });

  it("reads the model's object form", () => {
    assert.deepEqual(fileModel({ providerID: "opencode", model: "big-pickle", variant: "high" }), {
      model: "opencode/big-pickle",
      variant: "high",
    });
    assert.deepEqual(fileModel("not-a-model"), { model: null, variant: null });
  });

  it("writes new files OpenCode reads back the same", () => {
    const text = newAgentFile(
      draft({
        description: 'Docs: "quoted" #1',
        mode: "all",
        model: "opencode/big-pickle",
        variant: "high",
        temperature: 0.2,
        permissions: { edit: "deny", shell: "ask" },
        prompt: "Line one\n\n  indented: two\n",
      }),
      ["Imported from x", "- note: one"],
    );
    const f = parseAgentFile(text);
    assert.equal(text.split("\n")[1], "# Imported from x");
    assert.deepEqual(f.data, {
      description: 'Docs: "quoted" #1',
      mode: "all",
      model: "opencode/big-pickle#high",
      request: { body: { temperature: 0.2 } },
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    });
    assert.equal(draftFromFile(text, "docs", "project").draft.prompt, "Line one\n\n  indented: two");
  });

  it("puts an import's extra rules after the switches", () => {
    const text = newAgentFileWithRules(draft({ permissions: { edit: "deny" } }), [
      { action: "edit", resource: "*.md", effect: "allow" },
    ]);
    assert.deepEqual(parseAgentFile(text).data.permissions, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*.md", effect: "allow" },
    ]);
  });

  it("names the line of a frontmatter problem in the file", () => {
    assert.throws(
      () => parseAgentFile("---\nmode: primary\ndescription: [unclosed\n---\n"),
      (e: unknown) => e instanceof YamlError && e.line === 3,
    );
    assert.throws(() => parseAgentFile("---\nmode: primary\n"), /closing/);
    assert.throws(() => parseAgentFile("---\n- a\n---\n"), /key: value/);
  });

  it("setEntry replaces a block value, appends a new key and leaves comments between keys", () => {
    const head = ["a: 1", "b:", "  - x", "  - y", "", "# about c", "c: |", "  text", "", "  more"];
    assert.deepEqual(setEntry(head, "b", ["b: []"]), [
      "a: 1",
      "b: []",
      "",
      "# about c",
      "c: |",
      "  text",
      "",
      "  more",
    ]);
    assert.deepEqual(setEntry(head, "c", null), ["a: 1", "b:", "  - x", "  - y", "", "# about c"]);
    assert.deepEqual(setEntry(["a: 1", ""], "z", ["z: 2"]), ["a: 1", "z: 2", ""]);
  });
});

describe("OpenCode 1 agent files", () => {
  // The rules OpenCode 2.4.2 listed for this file (GET /api/agent), without its defaults.
  const V1 = [
    "---",
    "tools:",
    "  task: false",
    '  "mcp_*": false',
    "  glob: true",
    "  todowrite: false",
    "permission:",
    "  bash:",
    '    "git *": allow',
    '    "*": ask',
    "  webfetch: deny",
    "  external_directory: ask",
    "  edit: allow",
    "temperature: 0.7",
    "top_p: 0.9",
    "maxSteps: 4",
    "---",
    "L",
  ].join("\n");
  const LIVE = [
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "mcp_*", resource: "*", effect: "deny" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "todowrite", resource: "*", effect: "deny" },
    { action: "shell", resource: "git *", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "allow" },
  ];

  it("converts tools and permission the way OpenCode does", () => {
    const data = parseAgentFile(V1).data;
    assert.equal(isLegacy(data), true);
    assert.deepEqual(legacyRules(data), LIVE);
    assert.deepEqual(
      legacyRules({ tools: { write: false, bash: false }, permission: { edit: "deny", webfetch: "ask" } }),
      [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "ask" },
      ],
    );
  });

  it("is not OpenCode 1's once a key only OpenCode 2 reads is there", () => {
    for (const k of ["permissions: []", "request: {}", "system: x", "disabled: false"])
      assert.equal(isLegacy(parseAgentFile(`---\ntemperature: 1\n${k}\n---\n`).data), false, k);
    assert.equal(isLegacy(parseAgentFile("---\ntemperature: 1\nsteps: 2\n---\n").data), true);
  });

  it("leaves the old fields alone when only the description changes", () => {
    const d = draftFromFile(V1, "old", "project").draft;
    assert.equal(d.temperature, 0.7);
    assert.equal(d.permissions.edit, "allow");
    const out = updateAgentFile(V1, { ...d, description: "Now described" });
    assert.ok(
      out.includes("tools:") &&
        out.includes("temperature: 0.7") &&
        out.includes("description: Now described"),
    );
  });

  it("converts every old field when a permission changes", () => {
    const d = draftFromFile(V1, "old", "project").draft;
    const out = updateAgentFile(V1, { ...d, permissions: { ...d.permissions, read: "deny" } });
    const data = parseAgentFile(out).data;
    for (const k of ["tools", "permission", "temperature", "top_p", "maxSteps"])
      assert.equal(data[k], undefined, k);
    assert.deepEqual(data.request, { body: { temperature: 0.7, top_p: 0.9 } });
    assert.equal(data.steps, 4);
    const rules = data.permissions as Array<{ action: string; resource: string; effect: string }>;
    assert.deepEqual(rules[0], { action: "read", resource: "*", effect: "deny" });
    // The same decisions as before for everything else.
    for (const [a, r] of [
      ["shell", "git status"],
      ["shell", "rm x"],
      ["webfetch", "u"],
      ["edit", "f"],
      ["mcp_x", "y"],
      ["subagent", "z"],
    ])
      assert.equal(evaluate(rules as never, a, r), evaluate(LIVE as never, a, r), `${a} ${r}`);
  });
});

describe("Roo Code and Kilo Code modes", () => {
  // The shapes from Roo Code's documentation and real .roomodes files.
  const JSON_MODES = JSON.stringify({
    customModes: [
      {
        slug: "docs-writer",
        name: "📝 Documentation Writer",
        roleDefinition: "You are a technical writer.",
        whenToUse: "Use this mode for writing and editing documentation.",
        customInstructions: "Focus on clarity.",
        groups: [
          "read",
          ["edit", { fileRegex: "\\.(md|mdx)$", description: "Markdown files only" }],
          "browser",
        ],
        source: "project",
      },
      {
        slug: "tester",
        name: "Tester",
        roleDefinition: "You write tests.",
        groups: ["read", ["edit", { fileRegex: "(\\.test\\.ts|\\.spec\\.ts)$" }], "command", "mcp"],
      },
      {
        slug: "weird",
        name: "Weird",
        roleDefinition: "R",
        groups: ["read", ["edit", { fileRegex: "src/[a-z]+\\.ts$" }]],
      },
      { name: "No slug" },
    ],
  });
  const YAML_MODES = [
    "customModes:",
    "  - slug: orchestrator",
    "    name: 🪃 Orchestrator",
    "    roleDefinition: >-",
    "      You are a strategic workflow orchestrator who coordinates complex tasks",
    "      by delegating them to specialized modes.",
    "    customInstructions: |",
    "      Use the new_task tool to delegate.",
    "      Track progress.",
    "    groups: []",
    "    source: global",
    "  - slug: ask-only",
    "    name: Ask",
    "    description: Questions only",
    "    roleDefinition: You answer questions.",
    "    groups:",
    "      - read # reading only",
    "    model: claude-sonnet-5-5",
  ].join("\n");

  it("reads JSON and YAML mode files, skipping modes without a slug", () => {
    const j = parseModesFile(JSON_MODES);
    assert.deepEqual(
      j.map((m) => m.slug),
      ["docs-writer", "tester", "weird"],
    );
    assert.deepEqual(j[0].groups, [
      { group: "read" },
      { group: "edit", fileRegex: "\\.(md|mdx)$", description: "Markdown files only" },
      { group: "browser" },
    ]);
    const y = parseModesFile(YAML_MODES);
    assert.equal(
      y[0].roleDefinition,
      "You are a strategic workflow orchestrator who coordinates complex tasks by delegating them to specialized modes.",
    );
    assert.equal(y[0].customInstructions, "Use the new_task tool to delegate.\nTrack progress.");
    assert.deepEqual(y[1].groups, [{ group: "read" }]);
    assert.equal(y[1].model, "claude-sonnet-5-5");
    assert.deepEqual(parseModesFile(""), []);
    assert.deepEqual(parseModesFile("{}"), []);
    assert.throws(() => parseModesFile("{ bad json"), /JSON/);
    assert.throws(() => parseModesFile("customModes: nope"), /list/);
  });

  it("converts edit file patterns to globs when it can", () => {
    assert.deepEqual(regexToGlobs("\\.(md|mdx)$"), ["*.md", "*.mdx"]);
    assert.deepEqual(regexToGlobs("\\.md$"), ["*.md"]);
    assert.deepEqual(regexToGlobs(".*\\.md$"), ["*.md"]);
    assert.deepEqual(regexToGlobs("^docs/"), ["docs/*"]);
    assert.deepEqual(regexToGlobs("^docs/.*\\.md$"), ["docs/*.md"]);
    assert.deepEqual(regexToGlobs("(\\.test\\.ts|\\.spec\\.ts)$"), ["*.test.ts", "*.spec.ts"]);
    assert.deepEqual(regexToGlobs("(?:README|CHANGELOG)\\.md$"), ["*README.md", "*CHANGELOG.md"]);
    for (const re of ["src/[a-z]+\\.ts$", "\\.(js|ts)x?$", "\\d+", "a{2}", ".*", "^$", "\\w"])
      assert.equal(regexToGlobs(re), null, re);
  });

  it("maps groups to permission rules that decide like Roo Code did", () => {
    const [docs, tester, weird] = parseModesFile(JSON_MODES).map((m) => modeToAgent(m, { models: MODELS }));
    assert.equal(docs.name, "docs-writer");
    assert.equal(docs.draft.mode, "all");
    assert.equal(docs.draft.description, "Use this mode for writing and editing documentation.");
    assert.equal(docs.draft.prompt, "You are a technical writer.\n\nFocus on clarity.");
    const rules = switchesToRules(docs.draft.permissions, docs.rules);
    assert.equal(evaluate(rules, "edit", "docs/guide.md"), "allow");
    assert.equal(evaluate(rules, "edit", "src/a.mdx"), "allow");
    assert.equal(evaluate(rules, "edit", "src/a.ts"), "deny");
    assert.equal(evaluate(rules, "shell", "npm test"), "deny");
    assert.equal(evaluate(rules, "webfetch", "https://x"), "allow");
    assert.ok(docs.notes.some((n) => /browser/.test(n)));
    assert.ok(docs.notes.some((n) => /MCP/.test(n)));
    const t = switchesToRules(tester.draft.permissions, tester.rules);
    assert.equal(evaluate(t, "edit", "src/a.test.ts"), "allow");
    assert.equal(evaluate(t, "edit", "src/a.ts"), "deny");
    assert.equal(evaluate(t, "shell", "npm test"), "ask", "no rule: OpenCode's default decides");
    assert.equal(evaluate(t, "webfetch", "u"), "deny");
    assert.ok(!tester.notes.some((n) => /MCP/.test(n)));
    // A pattern globs cannot express: edits ask, and the note says why.
    assert.equal(weird.draft.permissions.edit, "ask");
    assert.ok(weird.notes.some((n) => n.includes("src/[a-z]+\\.ts$")));
  });

  it("makes an orchestrator a primary agent that starts the other modes", () => {
    const [orch, ask] = parseModesFile(YAML_MODES);
    assert.equal(isOrchestrator(orch), true);
    assert.equal(isOrchestrator(ask), false);
    const a = modeToAgent(orch, { models: MODELS, others: ["docs-writer", "tester"] });
    assert.equal(a.draft.mode, "primary");
    assert.equal(a.orchestrator, true);
    assert.equal(a.draft.permissions.subagent, "allow");
    assert.deepEqual(
      [a.draft.permissions.read, a.draft.permissions.edit, a.draft.permissions.shell],
      ["deny", "deny", "deny"],
      "no groups: it only delegates",
    );
    assert.match(a.draft.prompt, /subagent tool: docs-writer, tester\.$/);
    assert.ok(!a.notes.some((n) => /MCP/.test(n)), "no groups at all: nothing to say about MCP");
  });

  it("keeps a model OpenCode has and notes one it does not", () => {
    const [, ask] = parseModesFile(YAML_MODES);
    assert.equal(modeToAgent(ask, { models: MODELS }).draft.model, "anthropic/claude-sonnet-5-5");
    assert.equal(matchModel("opencode/big-pickle", MODELS)?.key, "opencode/big-pickle");
    assert.equal(matchModel("openrouter/big-pickle", MODELS)?.key, "opencode/big-pickle");
    assert.equal(matchModel("gpt-9", MODELS), null);
    const missing = modeToAgent({ ...ask, model: "gpt-9" }, { models: MODELS });
    assert.equal(missing.draft.model, null);
    assert.ok(missing.notes.some((n) => /gpt-9/.test(n)));
  });

  it("handles missing fields", () => {
    const [m] = parseModesFile('{"customModes":[{"slug":"bare"}]}');
    const a = modeToAgent(m, { models: [] });
    assert.equal(a.draft.description, "bare");
    assert.equal(a.draft.prompt, "");
    assert.ok(a.notes.some((n) => /role definition/.test(n)));
    assert.equal(a.draft.permissions.edit, "deny");
    const odd = parseModesFile('{"customModes":[{"slug":"o","groups":["read","teleport",{"x":1}]}]}')[0];
    assert.ok(modeToAgent(odd, { models: [] }).notes.some((n) => /teleport/.test(n) && /"x"/.test(n)));
  });

  it("adds the mode's rule files to the prompt and writes the notes as comments", () => {
    const [m] = parseModesFile(JSON_MODES);
    const a = modeToAgent(m, {
      models: [],
      rules: [{ source: ".roo/rules-docs-writer/1.md", text: "Use sentence case.\n" }],
    });
    assert.match(a.draft.prompt, /## Rules from \.roo\/rules-docs-writer\/1\.md\n\nUse sentence case\.$/);
    const text = newAgentFileWithRules(a.draft, a.rules, importComments(m, ".roomodes", a.notes));
    assert.match(
      text,
      /^---\n# Imported from the 📝 Documentation Writer mode \(docs-writer\) in \.roomodes\.\n# Not carried over exactly:\n# - /,
    );
    const back = draftFromFile(text, a.name, "project");
    assert.equal(back.draft.mode, "all");
    assert.equal(back.otherRules, 2);
  });
});

describe("agent sources", () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-agents-")));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("parses OpenCode's agent records", () => {
    const a = parseAgentDetail({
      id: "v2a",
      name: "v2a",
      model: { id: "big-pickle", providerID: "opencode", variant: "high" },
      request: { settings: {}, headers: {}, body: { temperature: 0.2 } },
      system: "You are V2A.",
      description: "V2 agent",
      mode: "subagent",
      hidden: false,
      color: "#ff6b6b",
      steps: 8,
      permissions: [{ action: "edit", resource: "*", effect: "deny" }, { bad: 1 }],
    });
    assert.deepEqual(a, {
      id: "v2a",
      name: "v2a",
      description: "V2 agent",
      mode: "subagent",
      hidden: false,
      model: "opencode/big-pickle#high",
      system: "You are V2A.",
      temperature: 0.2,
      steps: 8,
      color: "#ff6b6b",
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
    });
    assert.equal(parseAgentDetail({ name: "x" }), null);
    assert.equal(parseAgentDetail({ id: "x", mode: "weird" })?.mode, "primary");
  });

  it("parses OpenCode's config list (folders and documents' agents)", () => {
    const s = parseConfigSources([
      { type: "directory", path: "C:\\Users\\me\\.config\\opencode" },
      {
        type: "document",
        path: "C:\\repo\\opencode.json",
        info: { agents: { reviewer: {} }, provider: { x: { apiKey: "k" } } },
      },
      { type: "directory", path: "C:\\repo\\.opencode" },
    ]);
    assert.deepEqual(s, {
      directories: ["C:\\Users\\me\\.config\\opencode", "C:\\repo\\.opencode"],
      documentAgents: { reviewer: "C:\\repo\\opencode.json" },
    });
    assert.equal(globalConfigDir(s, "c:\\repo", "win32"), "C:\\Users\\me\\.config\\opencode");
    assert.deepEqual(parseConfigSources(null), { directories: [], documentAgents: {} });
  });

  it("handles Windows paths: drive letter case, either slash", () => {
    assert.equal(isInside("C:\\Repo\\.opencode\\agents", "c:/repo", "win32"), true);
    assert.equal(isInside("C:\\repo2", "C:\\repo", "win32"), false);
    assert.equal(isInside("C:\\Users\\me\\.config\\opencode", "C:\\repo", "win32"), false);
    assert.equal(isInside("/Repo/x", "/repo", "linux"), false);
    assert.equal(
      agentFilePath("C:\\repo\\.opencode", "docs", "win32"),
      "C:\\repo\\.opencode\\agents\\docs.md",
    );
    assert.equal(
      agentFilePath("/home/me/.config/opencode", "docs", "linux"),
      "/home/me/.config/opencode/agents/docs.md",
    );
  });

  it("finds Roo Code and Kilo Code mode files on Windows", () => {
    const dirs = globalStorageDirs("C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage", {
      platform: "win32",
      home: "C:\\Users\\me",
      appData: "C:\\Users\\me\\AppData\\Roaming",
    });
    assert.deepEqual(dirs, [
      "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage",
      "C:\\Users\\me\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage",
      "C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage",
      "C:\\Users\\me\\AppData\\Roaming\\VSCodium\\User\\globalStorage",
    ]);
    const files = modeFileCandidates("C:\\repo", dirs.slice(0, 2), "win32");
    assert.deepEqual(
      files.slice(0, 2).map((f) => [f.path, f.label]),
      [
        ["C:\\repo\\.roomodes", ".roomodes"],
        ["C:\\repo\\.kilocodemodes", ".kilocodemodes"],
      ],
    );
    assert.ok(
      files.some(
        (f) =>
          f.path ===
            "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\custom_modes.yaml" &&
          f.label === "Roo Code (global)",
      ),
    );
    assert.ok(
      files.some(
        (f) => f.path.endsWith("kilocode.kilo-code\\settings\\custom_modes.yaml") && f.kind === "kilo",
      ),
    );
    assert.ok(files.some((f) => f.label === "Roo Code (global, Code - Insiders)"));
    assert.deepEqual(
      globalStorageDirs(null, { platform: "darwin", home: "/Users/me" })[0],
      "/Users/me/Library/Application Support/Code/User/globalStorage",
    );
  });

  it("scans agents/ and agent/ (nested ids too); the folder's file wins over the global one", async () => {
    const global = path.join(tmp, "global");
    const folder = path.join(tmp, "repo");
    const write = (f: string, t: string) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    };
    write(path.join(global, "agents", "shared.md"), "---\nmode: all\n---\nG\n");
    write(path.join(global, "agent", "old.md"), "---\nmode: primary\n---\nO\n");
    write(path.join(folder, ".opencode", "agents", "shared.md"), "---\nmode: subagent\n---\nP\n");
    write(path.join(folder, ".opencode", "agents", "team", "rev.md"), "---\ndescription: nested\n---\nN\n");
    write(path.join(folder, ".opencode", "agents", "broken.md"), "---\ndescription: [x\n---\n");
    write(path.join(folder, ".opencode", "agents", "notes.txt"), "not an agent");
    const files = await scanAgentFiles([global, path.join(folder, ".opencode")], folder);
    assert.deepEqual([...files.keys()].sort(), ["broken", "old", "shared", "team/rev"]);
    assert.equal(files.get("shared")?.scope, "project");
    assert.equal(files.get("old")?.scope, "global");

    const detail = (id: string, mode: AgentDetail["mode"] = "primary"): AgentDetail => ({
      id,
      name: id,
      description: "",
      mode,
      hidden: false,
      model: null,
      system: "",
      temperature: null,
      steps: null,
      color: null,
      permissions: [],
    });
    const rows = deriveAgentRows({
      details: [
        detail("build"),
        detail("title"),
        { ...detail("hidden"), hidden: true },
        detail("shared", "subagent"),
        detail("old"),
        detail("team/rev"),
        detail("cfg"),
      ],
      files,
      documentAgents: { cfg: path.join(folder, "opencode.json") },
      folder,
    });
    assert.deepEqual(
      rows.map((r) => [r.id, r.source, r.editable]),
      [
        ["broken", "project", false],
        ["shared", "project", true],
        ["team/rev", "project", true],
        ["old", "global", true],
        ["cfg", "config", false],
        ["build", "built-in", false],
      ],
    );
    assert.equal(rows.find((r) => r.id === "shared")?.file, ".opencode/agents/shared.md");
    assert.match(rows.find((r) => r.id === "broken")!.problem!, /did not load it.*line 2/);
    assert.equal(rows.find((r) => r.id === "shared")?.draft?.mode, "subagent");
  });

  it("reads a mode's rule files in name order, skipping binary and large ones", async () => {
    const folder = path.join(tmp, "rules");
    const d = path.join(folder, ".roo", "rules-docs");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "b.md"), "Second");
    fs.writeFileSync(path.join(d, "a.md"), "First");
    fs.writeFileSync(path.join(d, "bin.dat"), "x\0y");
    fs.writeFileSync(path.join(d, "big.md"), "x".repeat(70 * 1024));
    fs.writeFileSync(path.join(folder, ".roorules-docs"), "Legacy");
    fs.mkdirSync(path.join(folder, ".kilocode", "rules-docs"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".kilocode", "rules-docs", "k.md"), "Kilo");
    const roo = await modeRuleFiles(folder, "docs", "roo");
    assert.deepEqual(
      roo.map((r) => [r.source, r.text]),
      [
        [".roo/rules-docs/a.md", "First"],
        [".roo/rules-docs/b.md", "Second"],
        [".roorules-docs", "Legacy"],
      ],
    );
    assert.deepEqual(
      (await modeRuleFiles(folder, "docs", "kilo")).map((r) => r.source),
      [".kilocode/rules-docs/k.md"],
    );
    assert.deepEqual(await modeRuleFiles(folder, "none", "roo"), []);
  });
});

describe("agents in the session controller", () => {
  const DIR = "/work/repo";
  function setup() {
    const client = new MockClient();
    const logs: string[] = [];
    const log = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const c = new SessionController(
      client,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      log,
      () => ({ model: "", agent: "" }),
      { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, agentWaitMs: 40, agentPollMs: 5 },
    );
    return { client, c, logs };
  }
  const detail = (id: string): AgentDetail => ({
    id,
    name: id,
    description: "",
    mode: "primary",
    hidden: false,
    model: null,
    system: "",
    temperature: null,
    steps: null,
    color: null,
    permissions: [],
  });

  it("waits until OpenCode lists the agent, without reloading", async () => {
    const { client, c } = setup();
    await c.setDirectory(DIR);
    let n = 0;
    client.agentDetails = () => (++n >= 3 ? [detail("docs")] : []);
    assert.equal(await c.awaitAgents((l) => l.some((a) => a.id === "docs")), true);
    assert.equal(client.callsTo("reloadConfig").length, 0);
    assert.ok(client.callsTo("listAgentDetails").length >= 3);
  });

  it("reloads OpenCode's config when the file is not picked up, then checks again", async () => {
    const { client, c, logs } = setup();
    await c.setDirectory(DIR);
    let reloaded = false;
    client.agentDetails = () => (reloaded ? [detail("docs")] : []);
    const orig = client.reloadConfig.bind(client);
    client.reloadConfig = async () => {
      await orig();
      reloaded = true;
    };
    const before = client.callsTo("listAgents").length;
    assert.equal(await c.awaitAgents((l) => l.some((a) => a.id === "docs")), true);
    assert.equal(client.callsTo("reloadConfig").length, 1);
    assert.ok(logs.some((l) => /reloading/.test(l)));
    assert.ok(client.callsTo("listAgents").length > before, "the catalog is refreshed");
  });

  it("gives up when the agent never shows, also when the reload fails", async () => {
    const { client, c, logs } = setup();
    await c.setDirectory(DIR);
    client.connectErrors.set("reloadConfig", new Error("503 Directory not found"));
    assert.equal(await c.awaitAgents(() => false), false);
    assert.ok(logs.some((l) => /Reloading OpenCode's config failed/.test(l)));
  });

  it("refreshes the catalog on agent.updated", async () => {
    const { client, c } = setup();
    await c.setDirectory(DIR);
    const before = client.callsTo("listAgents").length;
    c.handleRawEvent({ id: "e", created: 1, type: "agent.updated", location: { directory: DIR }, data: {} });
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(client.callsTo("listAgents").length > before);
  });
});

describe("agent messages from the webview", () => {
  const ok = (m: unknown) => parseWebviewMessage(m) !== undefined;

  it("accepts a well-formed form and refuses anything else", () => {
    assert.ok(ok({ type: "saveAgent", draft: draft(), editing: null }));
    assert.ok(
      ok({
        type: "saveAgent",
        draft: draft({ permissions: { edit: "deny" }, temperature: 0.5 }),
        editing: "team/rev",
        open: true,
      }),
    );
    assert.ok(!ok({ type: "saveAgent", draft: { ...draft(), extra: 1 }, editing: null }));
    assert.ok(!ok({ type: "saveAgent", draft: draft({ mode: "weird" as never }), editing: null }));
    assert.ok(
      !ok({ type: "saveAgent", draft: draft({ permissions: { browser: "allow" } as never }), editing: null }),
    );
    assert.ok(
      !ok({ type: "saveAgent", draft: draft({ permissions: { edit: "maybe" } as never }), editing: null }),
    );
    assert.ok(!ok({ type: "saveAgent", draft: draft({ temperature: 9 }), editing: null }));
    assert.ok(!ok({ type: "saveAgent", draft: draft({ scope: "elsewhere" as never }), editing: null }));
    assert.ok(!ok({ type: "saveAgent", draft: draft(), editing: "../../etc/passwd" }));
    assert.ok(!ok({ type: "saveAgent", draft: draft(), editing: "C:\\x" }));
  });

  it("checks agent ids and import keys", () => {
    assert.ok(ok({ type: "deleteAgent", id: "docs" }));
    assert.ok(ok({ type: "openAgentFile", id: "team/rev" }));
    assert.ok(!ok({ type: "deleteAgent", id: "../x" }));
    assert.ok(!ok({ type: "deleteAgent", id: "/abs" }));
    assert.ok(!ok({ type: "deleteAgent", id: "a\nb" }));
    assert.ok(ok({ type: "importModes", keys: ["C:\\repo\\.roomodes#docs"], scope: "project" }));
    assert.ok(!ok({ type: "importModes", keys: [1], scope: "project" }));
    assert.ok(!ok({ type: "importModes", keys: [], scope: "nowhere" }));
    assert.ok(ok({ type: "previewImport" }) && ok({ type: "loadAgents" }));
  });
});
