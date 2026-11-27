// Large pastes held as chips: the webview sends each one beside the message with the
// token that marks its place, and the host puts the text there, exactly as pasted.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildPrompt, expandPastes, locateMentions } from "../src/core/context";
import { SessionController } from "../src/core/sessionController";
import type { PromptInput } from "../src/opencode/client";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

/** Text a model would see byte for byte: tabs, trailing spaces, blank lines, Unicode, `@`. */
const LOG = "\n\tat main (src/app.ts:10)  \n\n  ünïcödé ✓ 🚀\n@src/a.ts is not a mention here\n";

describe("pasted text in the prompt", () => {
  it("puts each paste where its token is, keeping its text exactly", () => {
    const p = buildPrompt(
      "  Why does this fail?\n[Pasted text #1]\nand [Pasted text #2]  ",
      [],
      [],
      [
        { token: "[Pasted text #1]", text: LOG },
        { token: "[Pasted text #2]", text: "second" },
      ],
    );
    assert.equal(p.text, `Why does this fail?\n${LOG}\nand second`);
  });

  it("keeps a paste's outer whitespace when it starts or ends the message", () => {
    // The typed text is trimmed before the paste goes in, so the paste itself is never trimmed.
    const p = buildPrompt("[Pasted text #1]", [], [], [{ token: "[Pasted text #1]", text: LOG }]);
    assert.equal(p.text, LOG);
  });

  it("drops a paste whose token was deleted, and leaves unknown tokens as typed", () => {
    const p = buildPrompt("look at [Pasted text #9]", [], [], [{ token: "[Pasted text #1]", text: "gone" }]);
    assert.equal(p.text, "look at [Pasted text #9]");
  });

  it("uses each token once, so the same token typed twice expands only the first", () => {
    const p = buildPrompt(
      "[Pasted text #1] [Pasted text #1]",
      [],
      [],
      [{ token: "[Pasted text #1]", text: "X" }],
    );
    assert.equal(p.text, "X [Pasted text #1]");
  });

  it("moves mention spans past the pastes in front of them; mentions inside a paste are text", () => {
    const text = "[Pasted text #1] then @src/a.ts";
    const p = buildPrompt(
      text,
      [],
      [{ kind: "file", absPath: "/repo/src/a.ts", relPath: "src/a.ts", text: "@src/a.ts" }],
      [{ token: "[Pasted text #1]", text: LOG }],
    );
    const at = LOG.length + " then ".length;
    assert.equal(p.text, `${LOG} then @src/a.ts`);
    assert.deepEqual(p.files, [
      {
        uri: pathToFileURL("/repo/src/a.ts").href,
        name: "src/a.ts",
        mention: { start: at, end: at + 9, text: "@src/a.ts" },
      },
    ]);
    assert.equal(p.text.slice(at, at + 9), "@src/a.ts");
  });

  it("leaves mentions before a paste where they are", () => {
    const text = "@explore read [Pasted text #1]";
    const found = locateMentions(text, [{ text: "@explore" }]);
    const out = expandPastes(text, [{ token: "[Pasted text #1]", text: "a\r\nb" }], found);
    assert.equal(out.text, "@explore read a\r\nb");
    assert.deepEqual(out.mentions[0].span, { start: 0, end: 8, text: "@explore" });
  });

  it("validates pastes from the view strictly", () => {
    const send = (pastes: unknown) => parseWebviewMessage({ type: "send", text: "x", pastes });
    assert.ok(send([{ token: "[Pasted text #1]", text: LOG }]));
    assert.equal(send([{ token: "[Pasted #1]", text: "a" }]), undefined);
    assert.equal(send([{ token: "[Pasted text #1]", text: "" }]), undefined);
    assert.equal(send([{ token: "[Pasted text #1]", text: "a", extra: 1 }]), undefined);
    assert.equal(send([{ token: "[Pasted text #1]", text: "a".repeat(500_001) }]), undefined);
    assert.equal(
      send(Array.from({ length: 21 }, () => ({ token: "[Pasted text #1]", text: "a" }))),
      undefined,
    );
    const big = { token: "[Pasted text #1]", text: "a".repeat(500_000) };
    assert.ok(send([big, big, big, big]));
    assert.equal(send([big, big, big, big, { ...big, text: "a" }]), undefined, "over 2,000,000 in all");
    assert.equal(send("no"), undefined);
  });

  it("the controller sends the expanded text, also as a steer while the agent works", async () => {
    const client = new MockClient();
    const c = new SessionController(
      client,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "", agent: "" }),
      { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
    );
    await c.setDirectory("/work/repo");
    const pastes = [{ token: "[Pasted text #1]", text: LOG }];
    assert.equal(await c.send("explain [Pasted text #1]", [], undefined, [], pastes), true);
    assert.equal(c.busy, true);
    assert.equal(await c.send("also [Pasted text #1]", [], "steer", [], pastes), true);
    const sent = client.callsTo("prompt").map((x) => x.args[1] as PromptInput);
    assert.equal(sent[0].text, `explain ${LOG}`);
    assert.equal(sent[1].text, `also ${LOG}`);
    assert.equal(sent[1].delivery, "steer");
  });
});
