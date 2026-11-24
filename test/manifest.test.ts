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
      ["opencode-sidecar", "cadogy", "Sidecar for OpenCode", "0.1.2"],
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

  it("binds only Focus Chat by default, on macOS only (Cmd+Alt+O is unbound in VS Code)", () => {
    assert.deepEqual(pkg.contributes.keybindings, [
      { command: "opencodeSidecar.focusChat", key: "cmd+alt+o", when: "isMac" },
    ]);
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
    assert.equal(pkg.displayName, "Sidecar for OpenCode");
    assert.equal(pkg.contributes.configuration.title, "Sidecar");
    for (const c of pkg.contributes.commands as Array<{ category: string }>)
      assert.equal(c.category, "Sidecar");
  });
});
