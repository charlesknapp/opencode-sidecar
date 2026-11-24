import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageFor } from "../src/shared/languages";

describe("code fence languages for Open in editor", () => {
  const known = ["typescript", "python", "shellscript", "json", "plaintext"];
  it("maps common fence names to VS Code's ids", () => {
    assert.equal(languageFor("ts", known), "typescript");
    assert.equal(languageFor("Py", known), "python");
    assert.equal(languageFor("bash", known), "shellscript");
    assert.equal(languageFor(" json ", known), "json");
  });
  it("falls back to plain text for unknown or missing languages", () => {
    assert.equal(languageFor("cobol", known), "plaintext");
    assert.equal(languageFor("", known), "plaintext");
    assert.equal(languageFor("rs", known), "plaintext", "an alias VS Code doesn't know here");
  });
});
