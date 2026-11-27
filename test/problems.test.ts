import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPrompt, chipFor } from "../src/core/context";
import {
  diagnosticCode,
  excerptAround,
  formatProblems,
  groupProblems,
  MAX_PROBLEMS,
  problemsChip,
  workspaceRelative,
  type FoundProblem,
  type ProblemsAttachment,
} from "../src/core/problems";
import { splitUserText } from "../src/shared/userText";

const WIN_ROOT = "c:\\Users\\me\\repo";

function problem(over: Partial<FoundProblem> = {}): FoundProblem {
  return {
    absPath: "C:\\Users\\me\\repo\\src\\a.ts",
    relPath: "src/a.ts",
    languageId: "typescript",
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    source: "ts",
    code: "2322",
    line: 3,
    column: 7,
    endLine: 3,
    ...over,
  };
}

function attachment(found: FoundProblem[], cap = MAX_PROBLEMS): ProblemsAttachment {
  return { kind: "problems", id: "p1", ...groupProblems(found, cap) };
}

describe("problems: paths", () => {
  it("makes Windows paths relative with / whatever the drive letter's case", () => {
    assert.equal(workspaceRelative(WIN_ROOT, "C:\\Users\\me\\repo\\src\\a.ts"), "src/a.ts");
    assert.equal(workspaceRelative("C:\\Users\\me\\repo", "c:\\users\\me\\repo\\lib\\b.ts"), "lib/b.ts");
    assert.equal(workspaceRelative(WIN_ROOT, "C:\\Users\\me\\other\\a.ts"), null, "outside the folder");
    assert.equal(workspaceRelative(WIN_ROOT, "D:\\repo\\a.ts"), null, "another drive");
    assert.equal(workspaceRelative(WIN_ROOT, WIN_ROOT), null, "the folder itself");
  });

  it("handles POSIX paths and refuses ../ escapes", () => {
    assert.equal(workspaceRelative("/w/app", "/w/app/src/x.py"), "src/x.py");
    assert.equal(workspaceRelative("/w/app", "/w/app-2/x.py"), null);
    assert.equal(workspaceRelative("/w/app", "/w/x.py"), null);
  });
});

describe("problems: diagnostics", () => {
  it("reads every form of a diagnostic code", () => {
    assert.equal(diagnosticCode("no-unused-vars"), "no-unused-vars");
    assert.equal(diagnosticCode(2322), "2322");
    assert.equal(diagnosticCode({ value: 7016, target: {} }), "7016");
    assert.equal(diagnosticCode(undefined), undefined);
    assert.equal(diagnosticCode(""), undefined);
  });

  it("takes a few lines around a problem, within the file, with long lines cut", () => {
    const doc = ["a", "b", "c", "d", "e", "x".repeat(500)];
    assert.deepEqual(excerptAround(doc, 3, 3), { start: 1, lines: ["a", "b", "c", "d", "e"] });
    assert.deepEqual(excerptAround(doc, 1, 1, 1), { start: 1, lines: ["a", "b"] });
    const last = excerptAround(doc, 6, 6, 1)!;
    assert.equal(last.start, 5);
    assert.equal(last.lines[1].length, 241, "240 characters and an ellipsis");
    assert.equal(excerptAround(doc, 9, 9), undefined, "a line past the end (file changed)");
    assert.equal(excerptAround([], 1, 1), undefined);
    // A long range is capped.
    const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    assert.equal(excerptAround(long, 10, 90)!.lines.length, 12);
  });
});

describe("problems: grouping and capping", () => {
  it("groups by file in path order, each file's problems by line", () => {
    const a = attachment([
      problem({ relPath: "src/b.ts", absPath: "/r/src/b.ts", line: 9 }),
      problem({ line: 20, severity: "warning", source: "eslint", code: "no-unused-vars" }),
      problem({ line: 3 }),
      problem({ relPath: "src/b.ts", absPath: "/r/src/b.ts", line: 2 }),
    ]);
    assert.deepEqual(
      a.files.map((f) => [f.relPath, f.problems.map((p) => p.line)]),
      [
        ["src/a.ts", [3, 20]],
        ["src/b.ts", [2, 9]],
      ],
    );
    assert.equal(a.total, 4);
    assert.ok(!("absPath" in a.files[0].problems[0]), "the file is not repeated on each problem");
  });

  it("keeps errors before warnings when capping and says how many were left out", () => {
    const found = [
      ...Array.from({ length: 40 }, (_, i) =>
        problem({ relPath: "a.ts", absPath: "/r/a.ts", line: i + 1, severity: "warning" }),
      ),
      ...Array.from({ length: 33 }, (_, i) => problem({ relPath: "z.ts", absPath: "/r/z.ts", line: i + 1 })),
    ];
    const a = attachment(found);
    const kept = a.files.flatMap((f) => f.problems);
    assert.equal(kept.length, 50);
    assert.equal(kept.filter((p) => p.severity === "error").length, 33, "every error is kept");
    assert.equal(a.total, 73);
    assert.deepEqual(
      a.files.map((f) => f.relPath),
      ["a.ts", "z.ts"],
    );
    const text = formatProblems(a);
    assert.match(text, /^Problems from VS Code \(33 errors, 17 warnings in 2 files\):\n/);
    assert.match(text, /Only the first 50 of 73 problems are listed\.\n```$/);
    assert.equal(problemsChip(a).label, "50 of 73 problems · 2 files");
    assert.match(problemsChip(a).detail, /\(first 50 of 73\)/);
  });

  it("an empty list or a zero cap lists nothing", () => {
    assert.deepEqual(groupProblems([]), { files: [], total: 0 });
    assert.deepEqual(groupProblems([problem()], 0), { files: [], total: 1 });
  });
});

describe("problems: prompt text", () => {
  it("names the file, place, severity, source and code, message and the code around it", () => {
    const a = attachment([
      problem({ excerpt: { start: 1, lines: ["const a = 1;", "", 'const n: number = "x";', "export {};"] } }),
    ]);
    const text = formatProblems(a);
    assert.equal(
      text,
      [
        "Problems from VS Code (1 error in src/a.ts):",
        "```text",
        "src/a.ts",
        "- line 3:7, error ts(2322): Type 'string' is not assignable to type 'number'.",
        "    1 | const a = 1;",
        "    2 |",
        '  > 3 | const n: number = "x";',
        "    4 | export {};",
        "```",
      ].join("\n"),
    );
  });

  it("shows a range, a source or code alone, and keeps a multi-line message under its bullet", () => {
    const a = attachment([
      problem({ line: 4, endLine: 6, source: undefined, code: "E1", message: "first\nsecond" }),
      problem({ line: 9, code: undefined, source: "eslint", severity: "warning", message: "unused" }),
    ]);
    const text = formatProblems(a);
    assert.match(text, /- lines 4-6, error E1: first\n {4}second/);
    assert.match(text, /- line 9:7, warning eslint: unused/);
  });

  it("uses a longer fence when the code contains backticks", () => {
    const a = attachment([problem({ excerpt: { start: 3, lines: ["const s = ```;"] } })]);
    const text = formatProblems(a);
    assert.match(text, /\n````text\n/);
    assert.match(text, /\n````$/);
  });

  it("goes into the prompt as text with the typed message and comes back as a chip", () => {
    const a = attachment([problem(), problem({ relPath: "lib/c.ts", absPath: "/r/lib/c.ts", line: 1 })]);
    const p = buildPrompt("Fix these problems.", [a]);
    assert.equal(p.files.length, 0);
    assert.match(p.text, /^Fix these problems\.\n\nProblems from VS Code \(2 errors in 2 files\):/);
    assert.deepEqual(splitUserText(p.text), {
      text: "Fix these problems.",
      snippets: ["Problems: 2 errors in 2 files"],
    });
    // Sent without a typed message, the problems alone are the prompt.
    assert.match(buildPrompt("", [a]).text, /^Problems from VS Code/);
  });

  it("makes a chip with the count and the file", () => {
    const one = attachment([problem(), problem({ line: 8, severity: "warning" })]);
    assert.deepEqual(chipFor(one), {
      id: "p1",
      label: "2 problems · a.ts",
      detail: "1 error, 1 warning in src/a.ts\nsrc/a.ts",
      kind: "problems",
    });
    const outside = attachment([problem({ relPath: "C:\\elsewhere\\x.ts", absPath: "C:\\elsewhere\\x.ts" })]);
    assert.equal(chipFor(outside).label, "1 problem · x.ts", "a Windows path outside the folder");
    const many = attachment(
      Array.from({ length: 10 }, (_, i) => problem({ relPath: `f${i}.ts`, absPath: `/r/f${i}.ts` })),
    );
    assert.match(chipFor(many).detail, /f7\.ts\nand 2 more$/);
  });
});
