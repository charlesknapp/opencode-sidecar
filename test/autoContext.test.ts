import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoAttachment, autoKey, isAutoId, type EditorSnapshot } from "../src/core/autoContext";
import { buildPrompt, chipFor, MAX_SELECTION_CHARS } from "../src/core/context";
import type { ContextAttachment } from "../src/shared/model";

const editor = (over: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  absPath: "c:\\repo\\src\\app.ts",
  relPath: "src/app.ts",
  languageId: "typescript",
  sensitive: false,
  ...over,
});
const sel = { startLine: 3, endLine: 5, text: "a\nb\nc" };

describe("editor context (autoContext)", () => {
  it("is the file when nothing is selected, the lines when something is", () => {
    assert.deepEqual(autoAttachment(editor(), null, []), {
      kind: "file",
      id: "auto:c:\\repo\\src\\app.ts",
      relPath: "src/app.ts",
      absPath: "c:\\repo\\src\\app.ts",
    });
    const a = autoAttachment(editor({ selection: sel }), null, []);
    assert.equal(a?.kind, "selection");
    assert.equal(a?.id, "auto:c:\\repo\\src\\app.ts#3-5");
    assert.deepEqual(chipFor(a!), {
      id: "auto:c:\\repo\\src\\app.ts#3-5",
      label: "app.ts:3-5",
      detail: "src/app.ts lines 3-5",
    });
    assert.ok(isAutoId(a!.id));
    assert.ok(!isAutoId("3f2a-uuid"));
  });

  it("follows the editor: another file or other lines is another chip", () => {
    const one = autoAttachment(editor({ selection: sel }), null, []);
    const two = autoAttachment(editor({ selection: { ...sel, endLine: 9 } }), null, []);
    const other = autoAttachment(editor({ absPath: "c:\\repo\\b.ts", relPath: "b.ts" }), null, []);
    assert.notEqual(one?.id, two?.id);
    assert.equal(other?.relPath, "b.ts");
  });

  it("stays away once removed, for that file or those lines only", () => {
    const snap = editor({ selection: sel });
    assert.equal(autoAttachment(snap, autoKey(snap), []), null);
    assert.ok(autoAttachment(editor(), autoKey(snap), []), "the whole file is another key");
    assert.equal(autoAttachment(editor(), autoKey(editor()), []), null);
  });

  it("is nothing without an editor, outside the folder or for a sensitive file", () => {
    assert.equal(autoAttachment(null, null, []), null);
    assert.equal(autoAttachment(editor({ relPath: null }), null, []), null);
    assert.equal(autoAttachment(editor({ relPath: ".env", sensitive: true }), null, []), null);
  });

  it("falls back to the file for a blank or too large selection", () => {
    const blank = autoAttachment(editor({ selection: { ...sel, text: "  \n " } }), null, []);
    assert.equal(blank?.kind, "file");
    const huge = autoAttachment(
      editor({ selection: { ...sel, text: "x".repeat(MAX_SELECTION_CHARS + 1) } }),
      null,
      [],
    );
    assert.equal(huge?.kind, "file");
  });

  it("is left out when the same file or lines are attached by hand", () => {
    const file: ContextAttachment = {
      kind: "file",
      id: "f",
      relPath: "src/app.ts",
      absPath: "c:\\repo\\src\\app.ts",
    };
    assert.equal(autoAttachment(editor(), null, [file]), null);
    assert.equal(autoAttachment(editor({ selection: sel }), null, [file]), null, "the file covers its lines");
    const lines: ContextAttachment = {
      kind: "selection",
      id: "s",
      relPath: "src/app.ts",
      absPath: "c:\\repo\\src\\app.ts",
      startLine: 3,
      endLine: 5,
      text: "a\nb\nc",
      languageId: "typescript",
    };
    assert.equal(autoAttachment(editor({ selection: sel }), null, [lines]), null);
    assert.ok(autoAttachment(editor(), null, [lines]), "other lines do not cover the whole file");
  });

  it("is sent like an attachment: the selection inline, the file as a file", () => {
    const a = autoAttachment(editor({ selection: sel }), null, [])!;
    assert.match(buildPrompt("Explain", [a]).text, /Selected code from `src\/app\.ts` \(lines 3-5\)/);
    const f = autoAttachment(editor({ absPath: "/repo/src/app.ts" }), null, [])!;
    assert.equal(buildPrompt("Explain", [f]).files[0].name, "src/app.ts");
  });
});
