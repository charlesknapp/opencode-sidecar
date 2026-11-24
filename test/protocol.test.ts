import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWebviewMessage } from "../src/shared/protocol";

describe("webview message schema", () => {
  it("accepts well-formed messages", () => {
    assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
    assert.deepEqual(parseWebviewMessage({ type: "send", text: "hi" }), { type: "send", text: "hi" });
    assert.ok(parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "once" }));
    assert.ok(parseWebviewMessage({ type: "openAgentDiff", path: "src/a.ts" }));
    assert.deepEqual(parseWebviewMessage({ type: "loadSavedPermissions" }), { type: "loadSavedPermissions" });
    for (const m of [
      { type: "deleteSession", id: "ses_1" },
      { type: "setDelivery", id: "msg_1", delivery: "queue" },
      { type: "exportSession" },
      { type: "loadMcpServers" },
      { type: "insertCode", text: "x = 1" },
      { type: "openCode", text: "x = 1", lang: "py" },
    ])
      assert.deepEqual(parseWebviewMessage(m), m, m.type);
    assert.equal(parseWebviewMessage({ type: "deleteSession" }), undefined);
    assert.equal(parseWebviewMessage({ type: "setDelivery", id: "msg_1", delivery: "later" }), undefined);
    assert.equal(parseWebviewMessage({ type: "openCode", text: "x", lang: "x".repeat(41) }), undefined);
    assert.equal(parseWebviewMessage({ type: "insertCode", text: "x", path: "/etc/passwd" }), undefined);
    assert.deepEqual(parseWebviewMessage({ type: "removeSavedPermission", id: "ps_1" }), {
      type: "removeSavedPermission",
      id: "ps_1",
    });
    assert.equal(parseWebviewMessage({ type: "removeSavedPermission", id: 3 }), undefined);
    assert.equal(parseWebviewMessage({ type: "removeSavedPermission", id: "ps_1", all: true }), undefined);
  });

  it("rejects unknown types and non-objects", () => {
    for (const bad of [
      null,
      undefined,
      1,
      "send",
      [],
      { type: "eval", code: "1" },
      { type: "__proto__" },
      { type: "toString" },
    ]) {
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
    }
  });

  it("rejects wrong field types", () => {
    assert.equal(parseWebviewMessage({ type: "send", text: 42 }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectSession", id: "" }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectModel" }), undefined);
  });

  it("rejects unexpected extra fields", () => {
    assert.equal(parseWebviewMessage({ type: "stop", force: true }), undefined);
    assert.equal(parseWebviewMessage({ type: "send", text: "x", files: ["/etc/passwd"] }), undefined);
  });

  it("only allows real permission decisions", () => {
    assert.equal(
      parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "allow-all" }),
      undefined,
    );
    assert.equal(
      parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "always" })?.type,
      "respondPermission",
    );
  });

  it("bounds message sizes", () => {
    assert.equal(parseWebviewMessage({ type: "send", text: "x".repeat(200_001) }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectSession", id: "x".repeat(513) }), undefined);
  });
});

describe("subagent messages", () => {
  it("accepts opening, closing and stopping a subagent", () => {
    assert.deepEqual(parseWebviewMessage({ type: "openSubagent", sessionID: "ses_a" }), {
      type: "openSubagent",
      sessionID: "ses_a",
    });
    assert.ok(parseWebviewMessage({ type: "closeSubagent" }));
    assert.ok(parseWebviewMessage({ type: "stopSubagent", sessionID: "ses_a" }));
  });

  it("rejects missing, oversized or extra fields", () => {
    for (const bad of [
      { type: "openSubagent" },
      { type: "openSubagent", sessionID: "" },
      { type: "openSubagent", sessionID: "x".repeat(513) },
      { type: "stopSubagent", sessionID: 7 },
      { type: "closeSubagent", sessionID: "ses_a" },
      { type: "openSubagent", sessionID: "ses_a", extra: true },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
  });
});

describe("rewind message", () => {
  it("accepts a message id and the confirmed choice, and nothing else", () => {
    assert.deepEqual(parseWebviewMessage({ type: "rewind", messageID: "msg_1", files: true }), {
      type: "rewind",
      messageID: "msg_1",
      files: true,
    });
    for (const bad of [
      { type: "rewind" },
      { type: "rewind", messageID: "msg_1" },
      { type: "rewind", messageID: "", files: false },
      { type: "rewind", messageID: 1, files: false },
      { type: "rewind", messageID: "msg_1", files: "yes" },
      { type: "rewind", messageID: "msg_1", files: true, extra: 1 },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
  });
});

describe("rename message", () => {
  it("accepts a non-empty title up to 200 characters", () => {
    assert.ok(parseWebviewMessage({ type: "renameSession", title: "Token refresh" }));
    for (const bad of [
      { type: "renameSession", title: "   " },
      { type: "renameSession", title: "x".repeat(201) },
      { type: "renameSession" },
      { type: "renameSession", title: "a", id: "ses" },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
  });
});

describe("permission reply with an instruction", () => {
  it("allows a message only with a rejection", () => {
    assert.ok(
      parseWebviewMessage({ type: "respondPermission", requestId: "p", decision: "reject", message: "do X" }),
    );
    for (const bad of [
      { type: "respondPermission", requestId: "p", decision: "once", message: "do X" },
      { type: "respondPermission", requestId: "p", decision: "reject", message: "   " },
      { type: "respondPermission", requestId: "p", decision: "reject", message: "x".repeat(20_001) },
      { type: "respondPermission", requestId: "p", decision: "reject", message: 3 },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad).slice(0, 80));
  });
});

describe("commands, compact, shell and bookmarks", () => {
  it("accepts well-formed messages", () => {
    for (const ok of [
      { type: "runCommand", name: "review", text: "" },
      { type: "runCommand", name: "fix:lint", text: "src", delivery: "queue" },
      { type: "compact" },
      { type: "shellCommand", command: "git status" },
      { type: "toggleBookmark", itemId: "text:m:0" },
      { type: "openBookmark", id: "bm_1" },
      { type: "removeBookmark", id: "bm_1" },
    ])
      assert.ok(parseWebviewMessage(ok), JSON.stringify(ok));
  });

  it("rejects bad names, empty commands and extra fields", () => {
    for (const bad of [
      { type: "runCommand", name: "rm -rf", text: "" },
      { type: "runCommand", name: "review" },
      { type: "shellCommand", command: "  " },
      { type: "compact", id: "x" },
      { type: "toggleBookmark" },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
  });
});

describe("file search from the + menu", () => {
  it("accepts searchFiles without fields", () => {
    assert.ok(parseWebviewMessage({ type: "searchFiles" }));
    assert.equal(parseWebviewMessage({ type: "searchFiles", path: "x" }), undefined);
  });
});

describe("editor tabs and settings from the chat", () => {
  it("accepts opening a tool's text and the two settings the / menu flips", () => {
    for (const ok of [
      { type: "openToolText", itemId: "tool:x", part: "out" },
      { type: "openToolText", itemId: "tool:x", part: "prompt" },
      { type: "setPref", key: "stickyPrompt", value: false },
      { type: "setPref", key: "activity", value: "grouped" },
      { type: "openSettings" },
    ])
      assert.ok(parseWebviewMessage(ok), JSON.stringify(ok));
  });

  it("rejects other settings, wrong values and unknown parts", () => {
    for (const bad of [
      { type: "setPref", key: "serverUrl", value: "http://evil" },
      { type: "setPref", key: "stickyPrompt", value: "yes" },
      { type: "setPref", key: "activity", value: "compact" },
      { type: "openToolText", itemId: "tool:x", part: "file" },
    ])
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
  });
});
