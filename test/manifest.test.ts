import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
const keys = Object.keys(pkg.contributes.configuration.properties as Record<string, unknown>);
const commands = (pkg.contributes.commands as Array<{ command: string; title: string }>).map(
  (c) => c.command,
);

describe("extension manifest", () => {
  it("keeps the release identity", () => {
    assert.deepEqual(
      [pkg.name, pkg.publisher, pkg.displayName, pkg.version],
      ["opencode-sidecar", "cadogy", "Sidecar for OpenCode: Chat Sidebar & GUI", "0.1.7"],
    );
  });

  it("uses a single settings namespace (opencodeSidecar.*)", () => {
    assert.deepEqual(
      keys.filter((k) => !k.startsWith("opencodeSidecar.")),
      [],
    );
  });

  it("declares the four notification settings, all on by default", () => {
    for (const k of ["taskComplete", "needsInput", "taskFailed", "budgetStopped"]) {
      const p = pkg.contributes.configuration.properties[`opencodeSidecar.notifications.${k}`];
      assert.ok(p, k);
      assert.equal(p.type, "boolean");
      assert.equal(p.default, true);
    }
  });

  it("contributes one Activity Bar container with one chat view (no duplicates)", () => {
    const containers = pkg.contributes.viewsContainers.activitybar as Array<{ id: string; title: string }>;
    assert.deepEqual(
      containers.map((c) => [c.id, c.title]),
      [["opencodeSidecar", "Sidecar for OpenCode"]],
    );
    assert.equal(Object.keys(pkg.contributes.views).length, 1);
    assert.deepEqual(
      pkg.contributes.views.opencodeSidecar.map((v: { id: string }) => v.id),
      ["opencodeSidecar.chat"],
    );
  });

  it("contributes Focus Chat, Refresh Connection and Sign in commands", () => {
    for (const c of [
      "opencodeSidecar.focusChat",
      "opencodeSidecar.refreshConnection",
      "opencodeSidecar.signIn",
    ])
      assert.ok(commands.includes(c), c);
    assert.equal(new Set(commands).size, commands.length, "no duplicate commands");
  });

  it("binds Focus Chat on macOS only (Cmd+Alt+O is unbound in VS Code), and the review's next / previous", () => {
    // Alt+] / Alt+[ are VS Code's next / previous inline suggestion while one shows, so the
    // review takes them only while it is active and no inline suggestion is visible.
    const review = "opencodeSidecar.reviewActive && editorTextFocus && !inlineSuggestionVisible";
    assert.deepEqual(pkg.contributes.keybindings, [
      { command: "opencodeSidecar.focusChat", key: "cmd+alt+o", when: "isMac" },
      { command: "opencodeSidecar.nextAgentChange", key: "alt+]", when: review },
      { command: "opencodeSidecar.previousAgentChange", key: "alt+[", when: review },
    ]);
  });

  it("contributes the review commands, the per-hunk ones only while a review is active", () => {
    for (const c of [
      "opencodeSidecar.reviewChanges",
      "opencodeSidecar.nextAgentChange",
      "opencodeSidecar.previousAgentChange",
      "opencodeSidecar.keepAgentChange",
      "opencodeSidecar.undoAgentChange",
      "opencodeSidecar.keepAgentFile",
      "opencodeSidecar.undoAgentFile",
      "opencodeSidecar.keepAllAgentChanges",
      "opencodeSidecar.undoAllAgentChanges",
      "opencodeSidecar.stageKeptChanges",
    ])
      assert.ok(commands.includes(c), c);
    const palette = pkg.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
    const when = (c: string) => palette.find((m) => m.command === c)?.when;
    assert.equal(when("opencodeSidecar.undoAgentChange"), "opencodeSidecar.reviewActive");
    assert.equal(when("opencodeSidecar.openAgentChangeDiff"), "false");
  });

  it("every keybinding has a when clause and takes no core VS Code shortcut", () => {
    // Core bindings an extension must never take (the official OpenCode extension was
    // criticised for binding Ctrl+P-style keys). Sidecar's own keys live inside the webview.
    const core = new Set([
      "ctrl+p",
      "cmd+p",
      "ctrl+shift+p",
      "cmd+shift+p",
      "ctrl+e",
      "cmd+e",
      "ctrl+k",
      "cmd+k",
      "ctrl+b",
      "cmd+b",
      "ctrl+j",
      "cmd+j",
      "ctrl+l",
      "cmd+l",
      "ctrl+i",
      "cmd+i",
      "ctrl+escape",
      "cmd+escape",
      "ctrl+shift+e",
      "cmd+shift+e",
      "ctrl+shift+f",
      "cmd+shift+f",
      "ctrl+shift+g",
      "ctrl+shift+x",
      "cmd+shift+x",
      "ctrl+shift+i",
      "cmd+shift+i",
      "ctrl+shift+l",
      "cmd+shift+l",
      "ctrl+alt+i",
      "cmd+alt+i",
      "ctrl+`",
      "ctrl+n",
      "cmd+n",
      "ctrl+w",
      "cmd+w",
      "ctrl+s",
      "cmd+s",
      "ctrl+.",
      "cmd+.",
      "ctrl+space",
      "ctrl+/",
      "cmd+/",
      "f1",
      "f2",
      "f5",
      "f12",
      "alt+enter",
    ]);
    for (const kb of pkg.contributes.keybindings as Array<Record<string, string>>) {
      assert.ok(kb.when?.trim(), `${kb.command} needs a when clause`);
      for (const k of [kb.key, kb.mac, kb.win, kb.linux].filter(Boolean))
        assert.ok(!core.has(k.toLowerCase()), `${kb.command} takes ${k}`);
    }
  });

  it("contributes the problem fixes, the light bulb's command (hidden) and the commit message", () => {
    for (const c of [
      "opencodeSidecar.fixWithOpenCode",
      "opencodeSidecar.fixFileProblems",
      "opencodeSidecar.fixWorkspaceProblems",
      "opencodeSidecar.writeCommitMessage",
    ])
      assert.ok(commands.includes(c), c);
    const palette = pkg.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
    assert.equal(palette.find((m) => m.command === "opencodeSidecar.fixWithOpenCode")?.when, "false");
    assert.deepEqual(pkg.contributes.menus["scm/title"], [
      { command: "opencodeSidecar.writeCommitMessage", when: "scmProvider == git", group: "navigation@9" },
    ]);
    // VS Code has no Problems view menu for extensions ("problems/context" is not a
    // contribution point); the Problems view shows the light bulb's quick fix instead.
    assert.equal(pkg.contributes.menus["problems/context"], undefined);
  });

  it("the editor context setting is off by default", () => {
    const p = pkg.contributes.configuration.properties["opencodeSidecar.autoContext"];
    assert.equal(p.type, "boolean");
    assert.equal(p.default, false);
  });

  it("activates after startup (for the Status Bar item) without a startup-blocking event", () => {
    assert.deepEqual(pkg.activationEvents, ["onStartupFinished"]);
    const p = pkg.contributes.configuration.properties["opencodeSidecar.showStatusBarItem"];
    assert.equal(p.type, "boolean");
    assert.equal(p.default, true);
  });

  it("the panel header shows the extension's name once; IDs are unchanged", () => {
    const container = pkg.contributes.viewsContainers.activitybar[0];
    // Activity Bar tooltip and side bar header. A container with one view shows
    // "Container: View" unless both names match, so they do.
    assert.equal(container.title, "Sidecar for OpenCode");
    assert.equal(container.id, "opencodeSidecar");
    assert.equal(container.icon, "media/activity.svg");
    const view = pkg.contributes.views.opencodeSidecar[0];
    assert.deepEqual(
      [view.id, view.type, view.name],
      ["opencodeSidecar.chat", "webview", "Sidecar for OpenCode"],
    );
    // Settings and commands use the short name.
    assert.equal(pkg.displayName, "Sidecar for OpenCode: Chat Sidebar & GUI");
    assert.equal(pkg.contributes.configuration.title, "Sidecar");
    for (const c of pkg.contributes.commands as Array<{ category: string }>)
      assert.equal(c.category, "Sidecar");
  });
});
