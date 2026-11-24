// Click-through tests of the real webview bundle (dist/webview.js + media/main.css)
// in headless Chrome. The VS Code API is stubbed: messages the webview posts are
// recorded, and host messages are delivered with window.postMessage exactly as
// VS Code does. Run `npm run build` first.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Browser, Page } from "puppeteer-core" with { "resolution-mode": "import" };
import type { SubagentView, TranscriptItem } from "../../src/shared/model";
import type { HostMessage, ViewState } from "../../src/shared/protocol";

const ROOT = path.resolve(__dirname, "../../..");
/** Directory holding dist/webview.js and media/main.css; override to test an unpacked VSIX. */
const BUNDLE_ROOT = process.env.WEBVIEW_BUNDLE_ROOT ?? ROOT;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => !!p);
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

type Sent = Record<string, unknown> & { type: string };

export function baseState(over: Partial<ViewState> = {}): ViewState {
  return {
    connection: { kind: "connected", version: "2.0.24", url: "http://127.0.0.1:1" },
    workspace: {
      active: { name: "my-app", path: "/w/my-app" },
      folders: [{ name: "my-app", path: "/w/my-app" }],
      branch: "main",
      detachedAt: null,
      repoKind: "local",
      repoRoot: "/w/my-app",
      mainWorktree: null,
      uncommitted: 2,
    },
    models: [
      {
        key: "opencode-go/kimi-k2.7-code",
        providerID: "opencode-go",
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        providerName: "OpenCode Go",
        contextLimit: 262144,
        variants: [],
      },
      {
        key: "opencode-go/qwen3.7-plus",
        providerID: "opencode-go",
        id: "qwen3.7-plus",
        name: "Qwen3.7 Plus",
        providerName: "OpenCode Go",
        contextLimit: 131072,
        variants: ["none", "high", "max"],
      },
      {
        key: "opencode/gpt-6-luna",
        providerID: "opencode",
        id: "gpt-6-luna",
        name: "GPT 6 Luna",
        providerName: "Personal / OpenCode",
        contextLimit: 400000,
        variants: ["low", "high"],
      },
    ],
    agents: [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ],
    selectedModel: "opencode-go/kimi-k2.7-code",
    selectedAgent: "build",
    selectedVariant: null,
    sessions: [],
    currentSession: { id: "ses_1", title: "Test session" },
    busy: false,
    stopping: false,
    attachments: [],
    agentChanges: { status: "none" },
    workspaceChanges: { count: 2 },
    usage: { contextTokens: 42000, contextLimit: 262144, cost: 0.08 },
    steps: 14,
    budget: {
      level: "medium",
      limits: { maxCost: 0.3, maxSteps: 50 },
      taskCost: 0.03,
      taskSteps: 5,
      active: false,
      state: "ok",
      allowance: 1,
    },
    budgetPresets: {
      small: { maxCost: 0.1, maxSteps: 20 },
      medium: { maxCost: 0.3, maxSteps: 50 },
      large: { maxCost: 1, maxSteps: 120 },
      custom: { maxCost: 0.5, maxSteps: 80 },
    },
    pending: [],
    locale: "en",
    showPlacementHint: false,
    onboarding: {
      stage: "ready",
      checklist: { installed: "done", connected: "done", account: "done", models: "done" },
      hint: null,
      signIn: "idle",
    },
    subagents: [],
    viewingSubagent: null,
    prefs: { stickyPrompt: true, cacheWarmMinutes: 5, activity: "detailed" },
    commands: [
      { name: "init", description: "create AGENTS.md" },
      { name: "review", description: "review changes" },
    ],
    bookmarks: [],
    mentionAgents: [{ id: "explore", name: "Explore", description: "Reads and searches the code." }],
    skills: [{ id: "review", name: "Review" }],
    revert: null,
    archivedSessions: null,
    ...over,
  };
}

const REPORT =
  "# Report\n\n- one\n- two\n\n| A | B |\n|--|--|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nتم بنجاح.";

let browser: Browser | undefined;
let page: Page;
let htmlFile = "";

async function host(msg: HostMessage) {
  await page.evaluate((m) => window.postMessage(m, "*"), msg as unknown as Record<string, unknown>);
  // Host messages are async tasks and item renders are coalesced per animation frame: wait two frames.
  await page.evaluate(
    () =>
      new Promise((r) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 5))), 0),
      ),
  );
}
async function sent(): Promise<Sent[]> {
  return page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);
}
async function lastSent(type: string): Promise<Sent | undefined> {
  return (await sent()).filter((m) => m.type === type).at(-1);
}
async function clearSent() {
  await page.evaluate(() => ((window as unknown as { __sent: Sent[] }).__sent.length = 0));
}
async function text(sel: string) {
  return page.$eval(sel, (el) => (el as HTMLElement).innerText);
}

describe(
  "webview interactions (headless Chrome)",
  { skip: CHROME ? false : "Chrome not found (set CHROME_PATH)" },
  () => {
    before(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-webview-"));
      htmlFile = path.join(dir, "index.html");
      const css = "file://" + path.join(BUNDLE_ROOT, "media", "main.css");
      const js = "file://" + path.join(BUNDLE_ROOT, "dist", "webview.js");
      fs.writeFileSync(
        htmlFile,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div>
<script>window.__sent=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__sent.push(JSON.parse(JSON.stringify(m))),getState:()=>undefined,setState:()=>{}});</script>
<script src="${js}"></script></body></html>`,
      );
      const puppeteer = (await import("puppeteer-core")).default;
      browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu"],
      });
    });

    after(async () => {
      await browser?.close();
    });

    /** True where the browser has no hover-capable pointer, such as headless Chrome on Linux CI. */
    const noHover = () => page.evaluate(() => matchMedia("(hover: none)").matches);

    beforeEach(async () => {
      page = await browser!.newPage();
      await page.setViewport({ width: 360, height: 900 });
      await page.goto("file://" + htmlFile);
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "ready"),
      );
      await host({ type: "state", state: baseState() });
    });

    it("sends a message with Enter and keeps Shift+Enter as newline", async () => {
      await page.click("textarea");
      await page.keyboard.type("line one");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      await page.keyboard.type("line two");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "line one\nline two" });
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "");
    });

    it("Copy sits under a turn's final answer, sends the item id and shows ✓ Copied, then resets", async () => {
      const items: TranscriptItem[] = [{ kind: "assistant", id: "text:m:0", text: REPORT, streaming: false }];
      await host({ type: "transcript", items });
      const order = await page.$eval('[data-testid="assistant"]', (el) => {
        const body = el.querySelector(".msg-body")!;
        const actions = el.querySelector(".answer-actions")!;
        return body.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING ? "below" : "above";
      });
      assert.equal(order, "below");
      assert.equal(
        await page.$eval('[data-testid="copy-message"]', (b) => b.getAttribute("aria-label")),
        "Copy message",
      );
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      assert.equal(req?.itemId, "text:m:0");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-message"]'), "✓ Copied");
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(await text('[data-testid="copy-message"]'), "", "back to the icon");
    });

    it("shows a non-blocking error when the clipboard write fails", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "hi", streaming: false }],
      });
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: false });
      assert.equal(await text(".copy-error"), "Copy failed");
    });

    it("puts Copy and Bookmark only under the final answer, once the turn is done", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      const turn = (n: number): TranscriptItem[] => [
        { kind: "user", id: `user:u${n}`, text: "q", attachments: [] },
        { kind: "assistant", id: `text:a${n}`, text: "first", streaming: false },
        TOOL(`tool:t${n}`, "completed"),
        { kind: "assistant", id: `text:b${n}`, text: "final", streaming: n === 2 },
      ];
      await host({ type: "transcript", items: [...turn(1), ...turn(2)] });
      const withActions = () =>
        page.$$eval(".answer-actions", (a) => a.map((x) => x.closest<HTMLElement>("[data-id]")!.dataset.id));
      assert.deepEqual(await withActions(), ["text:b1"], "the running turn has none yet");
      await host({ type: "events", events: [{ type: "session.idle", outcome: "interrupted" }] });
      await host({ type: "state", state: baseState({ busy: false }) });
      assert.deepEqual(await withActions(), ["text:b1", "text:b2"]);
      // A newer answer in the same turn takes the actions over.
      await host({ type: "state", state: baseState({ busy: true }) });
      await host({
        type: "events",
        events: [
          { type: "user.message", id: "u3", text: "more", attachments: [] },
          { type: "assistant.completed", partId: "c3", text: "one" },
        ],
      });
      await host({ type: "state", state: baseState({ busy: false }) });
      await host({ type: "events", events: [{ type: "assistant.completed", partId: "d3", text: "two" }] });
      assert.deepEqual(await withActions(), ["text:b1", "text:b2", "text:d3"]);
    });

    it("bookmarks an answer and lists bookmarks in the header popover", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "Tokens rotate on every use.", streaming: false }],
      });
      await page.click('[data-testid="bookmark"]');
      assert.deepEqual(await lastSent("toggleBookmark"), { type: "toggleBookmark", itemId: "text:m:0" });
      const bookmarks = [
        {
          id: "b1",
          sessionID: "ses_1",
          sessionTitle: "Test session",
          itemId: "text:m:0",
          excerpt: "Tokens rotate on every use.",
          created: Date.now() - 60_000,
        },
      ];
      await host({ type: "state", state: baseState({ bookmarks }) });
      assert.equal(
        await page.$eval('[data-testid="bookmark"]', (b) => b.getAttribute("aria-pressed")),
        "true",
      );
      await page.click('[data-testid="bookmarks-button"]');
      assert.match(
        await text('[data-testid="bookmark-item"]'),
        /Tokens rotate on every use\.\s*Test session · 1m ago/,
      );
      await page.click('[data-testid="bookmark-item"]');
      assert.deepEqual(await lastSent("openBookmark"), { type: "openBookmark", id: "b1" });
      await host({ type: "revealItem", itemId: "text:m:0" });
      assert.equal(await page.$eval('[data-id="text:m:0"]', (e) => e.classList.contains("flash")), true);
      await page.click('[data-testid="bookmarks-button"]');
      await page.click('[data-testid="bookmark-remove"]');
      assert.deepEqual(await lastSent("removeBookmark"), { type: "removeBookmark", id: "b1" });
    });

    it("Copy code copies only that code block's exact text", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: REPORT, streaming: false }],
      });
      await page.click('[data-testid="copy-code"]');
      const req = await lastSent("copy");
      assert.equal(req?.text, "const x = 1;");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-code"]'), "✓ Copied");
      assert.equal(await text('[data-testid="copy-message"]'), "", "message copy unaffected");
    });

    it("is keyboard accessible: Tab to Copy and press Enter", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "plain", streaming: false }],
      });
      await page.focus('[data-testid="copy-message"]');
      await page.keyboard.press("Enter");
      assert.ok(await lastSent("copyMessage"));
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid),
        "copy-message",
        "focus kept after re-render",
      );
    });

    it("shows Arabic copy feedback for an Arabic UI", async () => {
      await host({ type: "state", state: baseState({ locale: "ar" }) });
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "مرحبا", streaming: false }],
      });
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-message"]'), "✓ تم النسخ");
    });

    const menuTexts = () =>
      page.$$eval('[data-testid="menu"] .menu-h, [data-testid="menu"] .menu-item', (els) =>
        els.map((e) =>
          e.classList.contains("menu-h") ? `# ${e.textContent}` : e.querySelector(".menu-label")!.textContent,
        ),
      );
    const pick = async (pill: string, option: string) => {
      await page.click(`[data-testid="${pill}"]`);
      await page.waitForSelector('[data-testid="menu"]');
      const items = await page.$$('[data-testid="menu"] .menu-item');
      for (const it of items)
        if ((await it.$eval(".menu-label", (l) => l.textContent)) === option) {
          await it.click();
          return;
        }
      throw new Error(`no menu item ${option}`);
    };

    it("switches model, variant and budget from the model pill, and the agent from the mode button", async () => {
      assert.equal(await text('[data-testid="model-pill"]'), "Kimi K2.7 Code");
      await pick("model-pill", "Qwen3.7 Plus");
      assert.deepEqual(await lastSent("selectModel"), {
        type: "selectModel",
        key: "opencode-go/qwen3.7-plus",
      });
      assert.equal(await page.$('[data-testid="menu"]'), null, "the menu closes after a pick");
      await host({
        type: "state",
        state: baseState({ selectedModel: "opencode-go/qwen3.7-plus", selectedVariant: "high" }),
      });
      assert.equal(
        await page.$eval('[data-testid="model-pill"]', (p) => p.textContent),
        "Qwen3.7 Plus high",
        "variant shown dimmed",
      );
      // Variant and Budget Guard are dot sliders in the menu's fixed footer; the menu stays open.
      await page.click('[data-testid="model-pill"]');
      await page.click('[data-testid="variant-slider"] [data-value="max"]');
      assert.deepEqual(await lastSent("selectVariant"), { type: "selectVariant", variant: "max" });
      assert.match(await text('[data-testid="variant-slider"]'), /Variant \(Max\)/);
      await page.focus('[data-testid="budget-slider"]');
      await page.keyboard.press("ArrowLeft");
      assert.deepEqual(await lastSent("selectBudget"), { type: "selectBudget", level: "small" });
      assert.ok(await page.$('[data-testid="menu"]'), "sliders keep the menu open");
      await page.keyboard.press("Escape");
      assert.match(await text('[data-testid="mode-button"]'), /Build/);
      await pick("mode-button", "Plan");
      assert.deepEqual(await lastSent("selectAgent"), { type: "selectAgent", id: "plan" });
    });

    it("groups models by provider in a scrolling list, with variant and budget fixed below it", async () => {
      await page.click('[data-testid="model-pill"]');
      assert.deepEqual((await menuTexts()).slice(0, 5), [
        "# OpenCode Go",
        "Kimi K2.7 Code",
        "Qwen3.7 Plus",
        "# Personal / OpenCode",
        "GPT 6 Luna",
      ]);
      const inFooter = (sel: string) =>
        page.$eval(sel, (e) => !!e.closest(".menu-foot") && !e.closest(".menu-list"));
      assert.equal(
        await page.$('[data-testid="variant-slider"]'),
        null,
        "no variants for a model without them",
      );
      assert.ok(await inFooter('[data-testid="budget-slider"]'));
      await page.keyboard.press("Escape");
      await host({ type: "state", state: baseState({ selectedModel: "opencode-go/qwen3.7-plus" }) });
      await page.click('[data-testid="model-pill"]');
      assert.ok(await inFooter('[data-testid="variant-slider"]'));
      assert.deepEqual(
        await page.$$eval('[data-testid="variant-slider"] .sd', (d) =>
          d.map((x) => x.getAttribute("aria-label")),
        ),
        ["Default", "None", "High", "Max"],
        "only OpenCode-listed variants",
      );
    });

    it("opens menus on a raised surface, moves with the arrow keys and closes with Escape", async () => {
      await page.click('[data-testid="model-pill"]');
      const menu = await page.$eval('[data-testid="menu"]', (el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, position: style.position };
      });
      assert.equal(menu.position, "fixed");
      assert.notEqual(menu.background, "rgba(0, 0, 0, 0)", "menu has its own raised surface");
      const focused = () =>
        page.evaluate(() => document.activeElement?.querySelector(".menu-label")?.textContent);
      assert.equal(await focused(), "Kimi K2.7 Code", "focus starts on the selected model");
      await page.keyboard.press("ArrowDown");
      assert.equal(await focused(), "Qwen3.7 Plus");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("selectModel"), {
        type: "selectModel",
        key: "opencode-go/qwen3.7-plus",
      });
      await page.click('[data-testid="model-pill"]');
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="menu"]'), null);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "model-pill",
        "focus returns to the pill",
      );
    });

    it("filters the / menu as you type; Enter picks the first match", async () => {
      await page.click('[data-testid="commands-button"]');
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "menu-filter",
      );
      await page.keyboard.type("rev");
      assert.deepEqual(
        await page.$$eval('[data-testid="menu"] .menu-item:not([hidden]) .menu-label', (e) =>
          e.map((x) => x.textContent),
        ),
        ["/review"],
      );
      const headings = await page.$$eval('[data-testid="menu"] .menu-h:not([hidden])', (h) =>
        h.map((x) => x.textContent),
      );
      assert.deepEqual(headings, ["OpenCode commands"], "only the matching section's heading stays");
      await page.keyboard.press("Enter");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "/review ");
    });

    it("sizes menus like the message box: / and model span it, the agent menu opens at its right", async () => {
      await page.setViewport({ width: 520, height: 900 });
      const box = await page.$eval(".box", (b) => b.getBoundingClientRect().toJSON());
      const menuRect = () => page.$eval('[data-testid="menu"]', (m) => m.getBoundingClientRect().toJSON());
      await page.click('[data-testid="model-pill"]');
      let m = await menuRect();
      assert.ok(
        Math.abs(m.width - box.width) < 1 && Math.abs(m.left - box.left) < 1,
        "model menu spans the box",
      );
      assert.ok(m.bottom <= box.top, "opens above the box");
      assert.match(await text('[data-testid="menu"] .menu-title'), /Select a model/);
      await page.keyboard.press("Escape");
      await host({
        type: "state",
        state: baseState({
          agents: [
            { id: "build", name: "Build", description: "The default agent." },
            { id: "plan", name: "Plan", description: "Read-only agent." },
          ],
        }),
      });
      await page.click('[data-testid="mode-button"]');
      m = await menuRect();
      const mode = await page.$eval('[data-testid="mode-button"]', (b) => b.getBoundingClientRect().toJSON());
      assert.ok(Math.abs(m.right - mode.right) < 1, "agent menu lines up with its button's right edge");
      assert.deepEqual(
        await page.$$eval('[data-testid="agent-option"] .menu-sub', (e) => e.map((x) => x.textContent)),
        ["The default agent.", "Read-only agent."],
      );
      assert.match(await text('[data-testid="menu"] .menu-keys'), /⇧\s*\+\s*Tab to switch/);
    });

    it("shows a small tooltip on hover instead of the system one", async () => {
      const usage = { ...baseState().usage!, cached: true, lastStepAt: Date.now() - 2 * 60_000 };
      await host({ type: "state", state: baseState({ usage }) });
      assert.equal(await page.$eval('[data-testid="cache-pill"]', (b) => b.getAttribute("title")), null);
      await page.hover('[data-testid="cache-pill"]');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await text('[data-testid="tooltip"]'), "Prompt cache warm, about 3 min left (estimate).");
      await page.mouse.move(1, 1);
      assert.equal(await page.$eval('[data-testid="tooltip"]', (t) => (t as HTMLElement).hidden), true);
    });

    it("floats the message box over the chat, which scrolls underneath it", async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n");
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:long", text: lines, streaming: false }],
      });
      const g = await page.evaluate(() => {
        const conv = document.querySelector(".conversation")!.getBoundingClientRect();
        const bottom = document.querySelector(".bottom")!.getBoundingClientRect();
        const last = document.querySelector('[data-id="text:long"] p:last-child')!.getBoundingClientRect();
        return {
          convBottom: conv.bottom,
          bottomTop: bottom.top,
          bottomBottom: bottom.bottom,
          last: last.bottom,
        };
      });
      assert.ok(
        Math.abs(g.convBottom - g.bottomBottom) < 1,
        "the chat runs to the bottom edge, under the box",
      );
      assert.ok(
        g.last <= g.bottomTop,
        `the last line scrolls clear of the box (${g.last} <= ${g.bottomTop})`,
      );
    });

    it("floats the box over the chat, which scrolls behind it to the bottom edge", async () => {
      await page.setViewport({ width: 900, height: 700 });
      const lines = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n");
      await host({
        type: "transcript",
        items: [
          prompt("u1", "a prompt"),
          { kind: "assistant", id: "text:long", text: lines, streaming: false },
        ],
      });
      const geometry = () =>
        page.evaluate(() => {
          const box = document.querySelector(".box")!;
          const b = box.getBoundingClientRect();
          const bubble = document.querySelector(".bubble")!.getBoundingClientRect();
          const bottom = document.querySelector(".bottom")!;
          const conv = document.querySelector(".conversation") as HTMLElement;
          const model = document.querySelector('[data-testid="model-pill"]')!.getBoundingClientRect();
          const send = document.querySelector('[data-testid="send"]')!.getBoundingClientRect();
          return {
            width: b.width,
            left: b.left - bubble.left,
            right: bubble.right - b.right,
            modelBelow: model.top >= send.bottom,
            sendBeside:
              Math.abs(
                send.top - document.querySelector('[data-testid="add-context"]')!.getBoundingClientRect().top,
              ) < 4,
            bg: getComputedStyle(bottom).backgroundImage,
            halo: getComputedStyle(box).boxShadow,
            scrollbarClear:
              bottom.getBoundingClientRect().right <=
              conv.getBoundingClientRect().left + conv.clientWidth + 0.5,
          };
        });
      const wide = await geometry();
      // Wide: the box stops growing at 640px, centred under the wider chat, which shows beside it.
      assert.ok(Math.abs(wide.width - 640) < 1, `640px wide (${wide.width})`);
      assert.ok(
        wide.left > 20 && Math.abs(wide.left - wide.right) < 1,
        `centred (${wide.left}, ${wide.right})`,
      );
      assert.equal(wide.modelBelow, false, "one row of controls");
      // No band hides the chat beside the box; it only fades out at the panel's bottom edge.
      assert.match(wide.bg, /linear-gradient\(rgba\(0, 0, 0, 0\)/, "transparent first, then the bottom fade");
      assert.match(wide.halo, /px/, "a soft halo fades text close to the box");
      assert.ok(wide.scrollbarClear, "the chat's scrollbar stays usable");
      // A narrow side bar keeps the whole width for the box.
      await page.setViewport({ width: 300, height: 700 });
      const narrow = await geometry();
      assert.ok(
        Math.abs(narrow.left) < 1 && Math.abs(narrow.right) < 1,
        `flush (${narrow.left}, ${narrow.right})`,
      );
      // ...and puts the model pill on a row of its own under the tools, send staying on the first row.
      assert.equal(narrow.modelBelow, true, "model pill on its own row");
      assert.equal(narrow.sendBeside, true, "send on the first row");
    });

    it("/ is an action palette: context, model, session, OpenCode's commands and Sidecar's settings", async () => {
      await page.click('[data-testid="commands-button"]');
      assert.deepEqual(
        (await menuTexts()).filter((t) => t?.startsWith("# ")),
        ["# Context", "# Model", "# Session", "# OpenCode commands", "# Customize"],
      );
      await (await page.$$('[data-testid="command-option"]'))[1].click();
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "/review ");
      await page.keyboard.type("only src");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("runCommand"), {
        type: "runCommand",
        name: "review",
        text: "only src",
      });
      // Settings flip in place; the menu stays open.
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="pref-grouped"]');
      assert.deepEqual(await lastSent("setPref"), { type: "setPref", key: "activity", value: "grouped" });
      assert.equal(
        await page.$eval('[data-testid="pref-grouped"]', (b) => b.getAttribute("aria-checked")),
        "true",
      );
      await page.click('[data-testid="pref-sticky"]');
      assert.deepEqual(await lastSent("setPref"), { type: "setPref", key: "stickyPrompt", value: false });
      await page.click('[data-testid="open-settings"]');
      assert.ok(await lastSent("openSettings"));
      // "Switch model…" opens the model menu.
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-switch-model"]');
      assert.ok(await page.$('[data-testid="menu"] [data-testid="model-option"]'));
    });

    it("sends !command to the shell, /compact to compaction, and unknown /text as a message", async () => {
      const typeAndSend = async (v: string) => {
        await page.focus("textarea");
        await page.keyboard.type(v);
        await page.keyboard.press("Enter");
      };
      await typeAndSend("!git status");
      assert.deepEqual(await lastSent("shellCommand"), { type: "shellCommand", command: "git status" });
      await typeAndSend("/compact");
      assert.ok(await lastSent("compact"));
      await typeAndSend("/usr/bin is a path");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "/usr/bin is a path" });
    });

    it("shows the context in use as a ring that opens the usage menu", async () => {
      const ring = () =>
        page.$eval('[data-testid="context-ring"]', (b) => ({
          hidden: (b as HTMLElement).hidden,
          tip: (b as HTMLElement).dataset.tip,
          cls: b.className,
          dash: b.querySelector(".arc")?.getAttribute("stroke-dasharray"),
        }));
      // 42k of 262k: 16%, in the icon colour.
      assert.deepEqual(await ring(), {
        hidden: false,
        tip: "Context 42k / 262k (16%)",
        cls: "ico ctx",
        dash: `${(42000 / 262144) * 100} 100`,
      });
      await page.click('[data-testid="context-ring"]');
      assert.match(await text('[data-testid="menu"]'), /Context\s*42k \/ 262k \(16%\)/);
      assert.ok(await page.$('[data-testid="compact"]'), "Compact is in the same menu");
      await page.keyboard.press("Escape");
      // Near the limit it takes the warning, then the error colour.
      const at = (contextTokens: number) =>
        host({ type: "state", state: baseState({ usage: { ...baseState().usage!, contextTokens } }) });
      await at(200_000);
      assert.equal((await ring()).cls, "ico ctx warn");
      await at(250_000);
      assert.equal((await ring()).cls, "ico ctx high");
      // Without the model's limit there is no share to show; usage stays in the model menu.
      await host({
        type: "state",
        state: baseState({ usage: { ...baseState().usage!, contextLimit: null } }),
      });
      assert.equal((await ring()).hidden, true);
    });

    it("estimates the prompt cache on the clock pill; its menu holds usage and Compact", async () => {
      const usage = {
        ...baseState().usage!,
        cacheHit: 0.82,
        cached: true,
        lastStepAt: Date.now() - 2 * 60_000,
      };
      await host({ type: "state", state: baseState({ usage }) });
      assert.equal(await text('[data-testid="cache-pill"]'), "3m");
      await page.click('[data-testid="cache-pill"]');
      const stats = await page.$$eval('[data-testid="menu"] .menu-stat', (els) =>
        els.map((e) =>
          Array.from(e.children)
            .map((c) => c.textContent)
            .join(": "),
        ),
      );
      // Context first, then the prompt cache for a model that caches.
      assert.equal(stats[0], "Context: 42k / 262k (16%)");
      assert.deepEqual(stats.slice(-2), ["Warm for: ~3 min", "Cache hit: 82% of input"]);
      await page.click('[data-testid="compact"]');
      assert.ok(await lastSent("compact"));
      // Usage moved out of the model menu while the clock shows.
      await page.click('[data-testid="model-pill"]');
      assert.equal(await page.$('[data-testid="menu"] .menu-stat'), null);
      await page.keyboard.press("Escape");
      // A cold cache, then the clock turned off in the settings.
      await host({
        type: "state",
        state: baseState({ usage: { ...usage, lastStepAt: Date.now() - 10 * 60_000 } }),
      });
      assert.equal(await text('[data-testid="cache-pill"]'), "cold");
      await host({
        type: "state",
        state: baseState({ usage, prefs: { ...baseState().prefs, cacheWarmMinutes: 0 } }),
      });
      assert.equal(await page.$eval('[data-testid="cache-pill"]', (b) => (b as HTMLElement).hidden), true);
      // A model that reported no prompt-cache tokens (no cache, such as a local one): no clock.
      await host({ type: "state", state: baseState({ usage: { ...usage, cached: false } }) });
      assert.equal(await page.$eval('[data-testid="cache-pill"]', (b) => (b as HTMLElement).hidden), true);
    });

    it("shows the session's context, cost, steps and task budget behind the ring, or in the model menu", async () => {
      const budget = { ...baseState().budget, active: true };
      await host({ type: "state", state: baseState({ busy: true, budget }) });
      const statsIn = async (button: string) => {
        await page.click(`[data-testid="${button}"]`);
        const stats = await page.$$eval('[data-testid="menu"] .menu-stat', (els) =>
          els.map((e) =>
            Array.from(e.children)
              .map((c) => c.textContent)
              .join(": "),
          ),
        );
        await page.keyboard.press("Escape");
        return stats;
      };
      const all = [
        "Context: 42k / 262k (16%)",
        "Cost: $0.08",
        "Steps: 14",
        "Task: $0.03 / $0.30 · 5 / 50 steps",
      ];
      assert.deepEqual(await statsIn("context-ring"), all);
      assert.deepEqual(await statsIn("model-pill"), [], "not twice");
      // With no ring (the model's limit unknown) and no clock, the model menu keeps them.
      await host({
        type: "state",
        state: baseState({ busy: true, budget, usage: { ...baseState().usage!, contextLimit: null } }),
      });
      assert.deepEqual(await statsIn("model-pill"), [
        "Context: 42k",
        "Cost: $0.08",
        "Steps: 14",
        "Task: $0.03 / $0.30 · 5 / 50 steps",
      ]);
    });

    it("keeps the header to the title, Bookmarks, History and New session; renames in place", async () => {
      assert.deepEqual(
        await page.$$eval(".header button", (b) => b.map((x) => x.getAttribute("data-testid"))),
        ["session-title", "bookmarks-button", "history-button", "new-session"],
      );
      await page.click('[data-testid="session-title"]');
      const field = '[data-testid="rename-input"]';
      assert.equal(await page.$eval(field, (i) => (i as HTMLInputElement).value), "Test session");
      await page.$eval(field, (i) => ((i as HTMLInputElement).value = ""));
      await page.type(field, "Token refresh");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("renameSession"), { type: "renameSession", title: "Token refresh" });
      // Escape cancels without sending.
      await clearSent();
      await page.click('[data-testid="session-title"]');
      await page.type(field, " more");
      await page.keyboard.press("Escape");
      assert.equal(await lastSent("renameSession"), undefined);
      assert.ok(await page.$('[data-testid="session-title"]'));
    });

    it("lists and searches sessions in the History popover", async () => {
      const sessions = [
        { id: "ses_1", title: "Test session", created: 1, updated: Date.now() - 60_000 },
        { id: "ses_2", title: "Fix checkout totals", created: 1, updated: Date.now() - 3_600_000 },
      ].map((x) => ({ ...x, agent: null, modelKey: null, variant: null, outcome: null, cost: null }));
      await host({ type: "state", state: baseState({ sessions }) });
      await page.click('[data-testid="history-button"]');
      assert.ok(await lastSent("refreshSessions"));
      const titles = () => page.$$eval(".session-item-title", (e) => e.map((x) => x.textContent));
      assert.deepEqual(await titles(), ["Test session", "Fix checkout totals"]);
      await page.type('[data-testid="history-search"]', "checkout");
      assert.deepEqual(await titles(), ["Fix checkout totals"]);
      await page.click(".session-item");
      assert.deepEqual(await lastSent("selectSession"), { type: "selectSession", id: "ses_2" });
      assert.equal(await page.$eval('[data-testid="history"]', (e) => (e as HTMLElement).hidden), true);
    });

    const PERM = (
      over: Partial<Extract<TranscriptItem, { kind: "permission" }>["request"]> = {},
    ): TranscriptItem => ({
      kind: "permission",
      id: `perm:${over.id ?? "p1"}`,
      status: "pending",
      sensitive: [],
      request: {
        id: "p1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["npm test -- session"],
        canAlways: true,
        patterns: ["npm test *"],
        message: "Run the session tests",
        toolId: null,
        ...over,
      },
    });
    const visible = (sel: string) =>
      page.$eval(sel, (e) => !(e as HTMLElement).hidden && (e as HTMLElement).offsetParent !== null);

    it("a permission request replaces the message box: Yes / always / No, numbered, Yes by default", async () => {
      await host({ type: "transcript", items: [PERM()] });
      assert.equal(await visible(".box"), false, "the message box gives way");
      assert.equal(await text('[data-testid="permission-dock"] .dock-title'), "Allow this shell command?");
      assert.equal(await text('[data-testid="permission-dock"] .cmd'), "npm test -- session");
      assert.equal(await text('[data-testid="permission-dock"] .dock-desc'), "Run the session tests");
      assert.deepEqual(
        await page.$$eval(".opt-row", (r) => r.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " "))),
        ["1 Yes", "2 Yes, always allow npm test *", "3 No"],
      );
      assert.equal(await page.$eval(".opt-row", (r) => r.classList.contains("sel")), true, "Yes is filled");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "perm-once",
        "focus moves to the default answer",
      );
      assert.equal(
        await text('[data-testid="permission-row"] [data-testid="permission-status"]'),
        "Waiting for your answer below",
      );
      await page.keyboard.press("2");
      assert.deepEqual(await lastSent("respondPermission"), {
        type: "respondPermission",
        requestId: "p1",
        decision: "always",
      });
      await host({
        type: "events",
        events: [{ type: "permission.resolved", requestId: "p1", decision: "always" }],
      });
      assert.equal(await visible(".box"), true, "the message box comes back");
      assert.equal(await text('[data-testid="permission-status"]'), "Always allowed");
    });

    it("rejects with an instruction from 'Tell the agent what to do instead', or with Esc", async () => {
      await host({ type: "transcript", items: [PERM({ canAlways: false, patterns: [] })] });
      assert.deepEqual(
        await page.$$eval(".opt-row", (r) => r.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " "))),
        ["1 Yes", "2 No"],
        "no 'always' when OpenCode offers none",
      );
      await page.click('[data-testid="perm-tell"]');
      await page.keyboard.type("Run only the race test");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("respondPermission"), {
        type: "respondPermission",
        requestId: "p1",
        decision: "reject",
        message: "Run only the race test",
      });
      await clearSent();
      await page.focus('[data-testid="perm-once"]');
      await page.keyboard.press("Escape");
      assert.deepEqual(await lastSent("respondPermission"), {
        type: "respondPermission",
        requestId: "p1",
        decision: "reject",
      });
      await host({
        type: "events",
        events: [
          {
            type: "permission.resolved",
            requestId: "p1",
            decision: "reject",
            feedback: "Run only the race test",
          },
        ],
      });
      assert.equal(
        await text('[data-testid="permission-status"]'),
        "Denied · told the agent: “Run only the race test”",
      );
    });

    it("names writes by their path and collapses with ˅", async () => {
      await host({
        type: "transcript",
        items: [PERM({ action: "edit", resources: ["/w/my-app/src/a.ts"] })],
      });
      assert.equal(await text('[data-testid="permission-dock"] .dock-title'), "Allow write to src/a.ts?");
      await page.click('[data-testid="dock-collapse"]');
      assert.equal(await page.$(".opt-row"), null, "collapsed to its title");
      await page.click('[data-testid="dock-collapse"]');
      assert.ok(await page.$(".opt-row"));
    });

    const QUESTION: TranscriptItem = {
      kind: "form",
      id: "form:frm_1",
      status: "pending",
      answer: null,
      form: {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Questions",
        toolId: null,
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Retry limit",
            description: "How many retries before sign-out?",
            options: [
              { value: "once", label: "Once", description: "Matches session.ts today" },
              { value: "three", label: "Three times" },
            ],
            custom: true,
          },
          {
            key: "q1",
            type: "boolean",
            title: "Backoff",
            description: "Wait between retries?",
          },
        ],
      },
    };

    it("a question replaces the message box: a tab per question, radio rows, Submit when answered", async () => {
      await host({ type: "transcript", items: [QUESTION] });
      assert.equal(await visible(".box"), false);
      assert.deepEqual(
        await page.$$eval('[data-testid="question-tab"]', (t) => t.map((x) => x.textContent)),
        ["Retry limit", "Backoff"],
      );
      assert.equal(await text('[data-testid="question-dock"] .q'), "How many retries before sign-out?");
      const submitReady = () =>
        page.$eval('[data-testid="form-submit"]', (b) => b.classList.contains("ready"));
      assert.equal(await submitReady(), false, "dimmed until every question is answered");
      await page.keyboard.press("2"); // "Three times", then the next tab opens
      assert.equal(await text('[data-testid="question-dock"] .q'), "Wait between retries?");
      await page.click('[data-testid="form-option"]'); // Yes
      assert.equal(await submitReady(), true);
      await page.click('[data-testid="form-submit"]');
      assert.deepEqual(await lastSent("answerForm"), {
        type: "answerForm",
        formId: "frm_1",
        answer: { q0: "three", q1: true },
      });
      await host({ type: "formError", formId: "frm_1", error: "“Retry limit” is required." });
      assert.match(await text('[data-testid="question-dock"]'), /is required/);
    });

    it("takes a free-text answer through Other, cancels with ✕, and shows answers as a card", async () => {
      await host({ type: "transcript", items: [QUESTION] });
      await page.click('[data-testid="form-option-other"]');
      await page.type('[data-testid="form-other"]', "Twice");
      await page.click('[data-testid="question-tab"]:nth-child(2)');
      await page.click('[data-testid="form-option"]:nth-child(2)'); // No
      await page.click('[data-testid="form-submit"]');
      assert.deepEqual(await lastSent("answerForm"), {
        type: "answerForm",
        formId: "frm_1",
        answer: { q0: "Twice", q1: false },
      });
      await clearSent();
      await page.click('[data-testid="form-cancel"]');
      assert.deepEqual(await lastSent("cancelForm"), { type: "cancelForm", formId: "frm_1" });
      await host({
        type: "events",
        events: [
          { type: "form.resolved", formId: "frm_1", status: "answered", answer: { q0: "once", q1: true } },
        ],
      });
      assert.equal(await visible(".box"), true);
      assert.equal(await text('[data-testid="form-status"]'), "Answered · 2 questions");
      await page.click('[data-testid="form-card"] summary');
      assert.deepEqual(
        await page.$$eval(".qcard .radio:not(.off) .l", (e) => e.map((x) => x.childNodes[0].textContent)),
        ["Once", "Yes"],
        "the chosen options are filled",
      );
    });

    it("the send square stops a running task when the box is empty; Esc stops too", async () => {
      assert.equal(
        await page.$eval('[data-testid="send"]', (b) => b.classList.contains("idle")),
        true,
        "dim when empty",
      );
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(
        await page.$eval(".box", (b) => b.classList.contains("active")),
        true,
        "accent border while working",
      );
      // A playful word per run with the turning mark, the elapsed time and how to stop.
      assert.match(await text('[data-testid="working"]'), /^[A-Z][a-z ]+…\s*0:0\d · Esc to stop$/);
      assert.ok(await page.$('[data-testid="working"] .mark-spin .i-mark'), "the mark turns");
      // The ring stays still; the disc and the ring's gap (a mask, so any background shows
      // through) orbit together.
      const mark = await page.$eval('[data-testid="working"] .i-mark', (svg) => {
        const ring = svg.querySelector(".ring")!;
        const id = /^url\(#(.+)\)$/.exec(ring.getAttribute("mask") ?? "")?.[1];
        const mask = id ? document.getElementById(id) : null;
        return {
          masked: mask?.tagName === "mask" && !!mask.querySelector(".orbit .gap"),
          ringStill: getComputedStyle(ring).animationName,
          orbits: Array.from(svg.querySelectorAll(".orbit")).map((g) => getComputedStyle(g).animationName),
        };
      });
      assert.equal(mark.masked, true, "the gap is cut by a mask");
      assert.equal(mark.ringStill, "none", "the ring stays still");
      assert.deepEqual(mark.orbits, ["spin", "spin"], "the gap and the disc orbit together");
      await host({
        type: "state",
        state: baseState({ busy: true, prefs: { ...baseState().prefs, statusWords: false } }),
      });
      assert.equal(await text('[data-testid="status-word"]'), "Working…", "plain with the setting off");
      // A state change during the run redraws the text, not the mark, so its orbit never restarts.
      await page.evaluate(() => {
        (window as unknown as { __mark: Element }).__mark = document.querySelector(
          '[data-testid="working"] .i-mark',
        )!;
      });
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(
        await page.evaluate(
          () =>
            (window as unknown as { __mark: Element }).__mark ===
            document.querySelector('[data-testid="working"] .i-mark'),
        ),
        true,
        "the same mark keeps turning",
      );
      await host({ type: "state", state: baseState({ busy: true }) });
      await page.click('[data-testid="stop"]');
      assert.ok(await lastSent("stop"));
      await clearSent();
      await page.focus("textarea");
      await page.keyboard.press("Escape");
      assert.ok(await lastSent("stop"));
    });

    it("steers or queues follow-ups while running and shows pending messages with Edit/Remove", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      const placeholder = () => page.$eval("textarea", (t) => (t as HTMLTextAreaElement).placeholder);
      assert.equal(await placeholder(), "Steer the agent…");
      await page.click('[data-testid="mode-button"]');
      await page.click('[data-testid="mode-queue"]');
      assert.equal(await placeholder(), "Queue another message…");
      await page.type("textarea", "Run only the targeted test after this.");
      assert.equal(
        await page.$eval('[data-testid="send"]', (b) => b.getAttribute("aria-label")),
        "Queue message until the task finishes",
        "with text typed, the square sends instead of stopping",
      );
      await page.click('[data-testid="send"]');
      assert.deepEqual(await lastSent("send"), {
        type: "send",
        text: "Run only the targeted test after this.",
        delivery: "queue",
      });
      await host({
        type: "state",
        state: baseState({
          busy: true,
          pending: [
            {
              id: "msg_q",
              text: "Run only the targeted test after this.",
              attachments: [],
              delivery: "queue",
            },
          ],
        }),
      });
      assert.match(await text('[data-testid="pending-item"]'), /Queued/);
      const buttons = await page.$$('[data-testid="pending-item"] button');
      await buttons[0].click();
      assert.deepEqual(await lastSent("editPending"), { type: "editPending", id: "msg_q" });
      await buttons[1].click();
      assert.deepEqual(await lastSent("removePending"), { type: "removePending", id: "msg_q" });
      await host({ type: "restoreInput", text: "edited text" });
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "edited text");
    });

    it("Shift+Tab in the message box switches the agent", async () => {
      await page.focus("textarea");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
      assert.deepEqual(await lastSent("selectAgent"), { type: "selectAgent", id: "plan" });
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus stays");
    });

    it("View Agent Changes and per-file Diff use the agent diff; workspace changes are separate", async () => {
      await host({
        type: "state",
        state: baseState({
          agentChanges: {
            status: "ok",
            files: [{ path: "a.txt", additions: 3, deletions: 1, status: "modified" }],
          },
        }),
      });
      assert.match(await text(".changes"), /Agent changes · 1 file/);
      assert.match(await text(".changes"), /Workspace changes: 2 files/);
      await page.click('[data-testid="view-agent-changes"]');
      assert.ok(await lastSent("openAgentDiffAll"));
      await page.click('[data-testid="agent-changes-toggle"]');
      await page.click('[data-testid="file-diff"]');
      assert.deepEqual(await lastSent("openAgentDiff"), { type: "openAgentDiff", path: "a.txt" });
      await page.click('[data-testid="view-workspace-changes"]');
      assert.ok(await lastSent("openWorkspaceDiffAll"));
    });

    it("shows no strip when the agent-only diff is unavailable, and says why on workspace changes", async () => {
      const agentChanges = {
        status: "unavailable" as const,
        reason: "OpenCode did not record snapshots for the agent's edits.",
      };
      await host({ type: "state", state: baseState({ agentChanges, workspaceChanges: { count: 0 } }) });
      assert.equal(
        await page.$eval(".changes", (e) => (e as HTMLElement).hidden),
        true,
        "nothing to open, no strip",
      );
      await host({ type: "state", state: baseState({ agentChanges, workspaceChanges: { count: 2 } }) });
      assert.equal(
        await page.$eval('[data-testid="workspace-changes"]', (e) => e.getAttribute("title")),
        "Workspace changes: 2 files (HEAD ↔ working tree)\nAgent-only diff unavailable: OpenCode did not record snapshots for the agent's edits.",
      );
      // The strip sits on the box as one unit: the same width, the box's top corners square.
      const joint = await page.evaluate(() => {
        const strip = document.querySelector(".strips")!.getBoundingClientRect();
        const box = document.querySelector(".box")!;
        const b = box.getBoundingClientRect();
        return {
          sameEdges: Math.abs(strip.left - b.left) < 0.5 && Math.abs(strip.right - b.right) < 0.5,
          corner: getComputedStyle(box).borderTopLeftRadius,
          oneRow:
            document.querySelector('[data-testid="view-workspace-changes"]')!.getBoundingClientRect().top -
              document.querySelector('[data-testid="workspace-changes"]')!.getBoundingClientRect().top <
            8,
        };
      });
      assert.deepEqual(joint, { sameEdges: true, corner: "0px", oneRow: true });
    });

    it("attaches the current file, the selection or a searched file from +", async () => {
      for (const [testid, type] of [
        ["menu-current-file", "addCurrentFile"],
        ["menu-selection", "addSelection"],
        ["menu-pick-file", "searchFiles"],
      ]) {
        await page.click('[data-testid="add-context"]');
        await page.click(`[data-testid="${testid}"]`);
        assert.ok(await lastSent(type), type);
      }
      await host({
        type: "state",
        state: baseState({
          attachments: [{ id: "a1", label: "app.ts:3-9", detail: "src/app.ts lines 3-9" }],
        }),
      });
      await page.click(".chip-x");
      assert.deepEqual(await lastSent("removeAttachment"), { type: "removeAttachment", id: "a1" });
    });

    it("budget stopped card offers Continue once / Increase budget / Start new session", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "budget",
            id: "budget:1",
            state: "stopped",
            text: "Task budget reached. The agent was stopped.",
            resolved: null,
          },
        ],
      });
      await page.click('[data-testid="budget-continue"]');
      assert.deepEqual(await lastSent("budgetAction"), {
        type: "budgetAction",
        itemId: "budget:1",
        action: "continue",
      });
      await page.click('[data-testid="budget-increase"]');
      assert.equal((await lastSent("budgetAction"))?.action, "increase");
      await page.click('[data-testid="budget-new"]');
      assert.equal((await lastSent("budgetAction"))?.action, "newSession");
    });

    it("error card offers Change model (opens the model menu) and Retry", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "error",
            id: "error:1",
            title: "MiniMax M3 (OpenCode Go) reported insufficient funds.",
            detail: "Upstream request failed: Insufficient account funds",
            actions: ["changeModel", "retry"],
          },
        ],
      });
      const buttons = await page.$$('[data-testid="error-card"] button');
      await buttons[0].click();
      assert.ok(await lastSent("focusModelPicker"));
      await host({ type: "focusModel" });
      assert.ok(await page.$('[data-testid="menu"] [data-testid="model-option"]'), "the model menu is open");
      await page.keyboard.press("Escape");
      await buttons[1].click();
      assert.ok(await lastSent("retryLast"));
    });

    it("stays responsive with a large history and a long streaming report", async () => {
      const md = "## Section\n\n- a\n- b\n\n| x | y |\n|--|--|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n";
      const many: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({
        kind: "assistant",
        id: `text:m${i}:0`,
        text: md + i,
        streaming: false,
      }));
      const t0 = Date.now();
      await host({ type: "transcript", items: many });
      const historyMs = Date.now() - t0;
      assert.equal(await page.$$eval('[data-testid="assistant"]', (n) => n.length), 400);
      assert.ok(historyMs < 4000, `400-message history rendered in ${historyMs}ms`);
      await host({ type: "state", state: baseState({ busy: true }) });
      const t1 = Date.now();
      for (let batch = 0; batch < 40; batch++) {
        const events = Array.from({ length: 50 }, (_, i) => ({
          type: "assistant.delta" as const,
          partId: "live:0",
          delta: `word${batch * 50 + i} ` + (i % 10 === 0 ? "\n" : ""),
        }));
        await page.evaluate((m) => window.postMessage(m, "*"), {
          type: "events",
          events,
        } as unknown as Record<string, unknown>);
      }
      await host({
        type: "events",
        events: [{ type: "assistant.completed", partId: "live:0", text: "done" }],
      });
      const streamMs = Date.now() - t1;
      assert.ok(streamMs < 4000, `2000 streamed deltas handled in ${streamMs}ms`);
      assert.equal(
        await page.$eval('[data-id="text:live:0"] .msg-body', (n) => (n as HTMLElement).innerText.trim()),
        "done",
      );
    });

    // ---------------------------------------------------------------- timeline

    const at = (day: number, h: number, m: number, s = 0) => new Date(2026, 10, day, h, m, s).getTime();
    const TOOL = (id: string, status: "running" | "completed" | "failed"): TranscriptItem => ({
      kind: "tool",
      id,
      name: "read",
      title: "Read a.ts",
      category: "read",
      status,
      detail: {
        facts: [],
        command: null,
        cwd: null,
        output: null,
        outputTruncated: false,
        exitCode: null,
        files: [],
        error: null,
        subagent: null,
      },
    });
    const TIMELINE: TranscriptItem[] = [
      { kind: "user", id: "user:u1", text: "Why?", attachments: [], time: at(23, 11, 52) },
      {
        kind: "reasoning",
        id: "think:r1",
        text: "hmm",
        streaming: false,
        started: at(23, 11, 52, 2),
        ended: at(23, 11, 52, 11),
      },
      TOOL("tool:t1", "completed"),
      { kind: "assistant", id: "text:a1", text: "First block.", streaming: false, time: at(23, 11, 53) },
      { kind: "assistant", id: "text:a2", text: "Same block.", streaming: false, time: at(23, 11, 54) },
      { kind: "reasoning", id: "think:r2", text: "old", streaming: false },
      TOOL("tool:t2", "failed"),
      { kind: "user", id: "user:u2", text: "Next day", attachments: [], time: at(24, 9, 5) },
      { kind: "reasoning", id: "think:r3", text: "", streaming: true, started: at(24, 9, 5, 1) },
      TOOL("tool:t3", "running"),
    ];
    const entry = (id: string) => `[data-id="${id}"]`;

    it("lays the conversation out as turns: date dividers, prompt times, a rail with a dot per item", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await host({ type: "transcript", items: TIMELINE });
      const layout = await page.$eval(".items", (list) =>
        Array.from(list.children).map((c) =>
          c.classList.contains("day")
            ? `day:${c.getAttribute("aria-label")}`
            : `turn:${Array.from(c.querySelectorAll("[data-id]"))
                .map((e) => (e as HTMLElement).dataset.id)
                .join(",")}`,
        ),
      );
      assert.deepEqual(layout, [
        "day:Mon, Nov 23",
        "turn:user:u1,think:r1,tool:t1,text:a1,text:a2,think:r2,tool:t2",
        "day:Tue, Nov 24",
        "turn:user:u2,think:r3,tool:t3",
      ]);
      assert.equal(await text(`${entry("user:u1")} > .ts`), "11:52 AM");
      // Text shows its time where a block of text starts, not on every paragraph.
      assert.equal(await text(`${entry("text:a1")} > .ts`), "11:53 AM");
      assert.equal(await page.$(`${entry("text:a2")} > .ts`), null);
      assert.equal(await page.$(`${entry("think:r1")} > .ts`), null, "thought rows have no time");
      const dots = await page.$$eval(".tl-item", (els) =>
        els.map((e) => `${(e as HTMLElement).dataset.id}=${e.className.match(/dot-(\w+)/)?.[1]}`),
      );
      assert.deepEqual(dots, [
        "think:r1=idle",
        "tool:t1=ok",
        "text:a1=idle",
        "text:a2=idle",
        "think:r2=idle",
        "tool:t2=err",
        "think:r3=idle",
        "tool:t3=run",
      ]);
      assert.deepEqual(await page.$$eval('[data-testid="thought"]', (els) => els.map((e) => e.textContent)), [
        "Thought for 9s",
        "Thought",
        "Thinking…",
      ]);
      // The thought row expands to the reasoning.
      await page.click(`${entry("think:r1")} summary`);
      assert.equal(await text(`${entry("think:r1")} .reasoning`), "hmm");
    });

    it("draws the rail from the first dot to the last, with the dots on it", async () => {
      await host({ type: "transcript", items: TIMELINE.slice(0, 7) });
      const g = await page.$$eval(`.turn:first-of-type .tl-item`, (els) =>
        els.map((e) => {
          const dot = e.querySelector(".dot")!.getBoundingClientRect();
          const before = getComputedStyle(e, "::before").display;
          const after = getComputedStyle(e, "::after").display;
          return { dotX: dot.left + dot.width / 2, dotY: dot.top, before, after };
        }),
      );
      assert.equal(g[0].before, "none", "no rail above the first dot");
      assert.equal(g.at(-1)!.after, "none", "no rail below the last dot");
      assert.ok(g.slice(1).every((d) => d.before !== "none"));
      assert.ok(new Set(g.map((d) => d.dotX)).size === 1, "dots share one rail");
      const railX = await page.$eval(".tl-item:nth-child(2)", (e) => {
        const r = e.getBoundingClientRect();
        return r.left + parseFloat(getComputedStyle(e, "::before").left) + 0.5;
      });
      assert.ok(Math.abs(railX - g[0].dotX) < 1, `rail ${railX} through dots ${g[0].dotX}`);
    });

    it("adds live items to the open turn and starts a new turn on the next prompt", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await host({ type: "transcript", items: TIMELINE.slice(0, 2) });
      const now = at(25, 8, 0);
      await host({
        type: "events",
        events: [
          { type: "assistant.delta", partId: "live:0", delta: "Look", time: now },
          { type: "tool.started", toolId: "x", name: "read" },
        ],
      });
      await host({
        type: "events",
        events: [{ type: "user.message", id: "u9", text: "and then?", attachments: [], time: now }],
      });
      const turns = await page.$$eval(".turn", (els) =>
        els.map((t) => Array.from(t.querySelectorAll("[data-id]")).map((e) => (e as HTMLElement).dataset.id)),
      );
      assert.deepEqual(turns, [["user:u1", "think:r1", "text:live:0", "tool:x"], ["user:u9"]]);
      // A live text block shows when it started; a prompt on a new day gets its own divider.
      assert.ok(await page.$(`${entry("text:live:0")} > .ts`));
      assert.equal(await page.$$eval(".day", (d) => d.length), 2);
    });

    for (const width of [300, 400, 520]) {
      it(`fits the timeline at ${width}px with the gutter the spec gives`, async () => {
        await page.setViewport({ width, height: 900 });
        await host({ type: "transcript", items: TIMELINE });
        const m = await page.evaluate(() => {
          const item = document.querySelector('[data-id="text:a1"]')!;
          const dot = item.querySelector(".dot")!.getBoundingClientRect();
          const prompt = document.querySelector('[data-id="user:u1"] .bubble')!.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            gutter: prompt.left,
            dotCenter: dot.left + dot.width / 2,
            textLeft: item.querySelector(".msg")!.getBoundingClientRect().left,
          };
        });
        assert.ok(m.overflow <= 0, `horizontal overflow ${m.overflow}px`);
        const gutter = width < 360 ? 12 : width > 480 ? 20 : 16;
        assert.equal(Math.round(m.gutter), gutter);
        assert.ok(Math.abs(m.dotCenter - (gutter + 16.5)) <= 1, `rail at ${m.dotCenter}`);
        assert.equal(Math.round(m.textLeft), gutter + 31);
      });
    }

    it("stops the pulse with reduced motion and uses the focus colour for live dots in high contrast", async () => {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await host({ type: "transcript", items: TIMELINE });
      assert.equal(
        await page.$eval(`${entry("tool:t3")} .dot`, (d) => getComputedStyle(d).animationName),
        "none",
      );
      await page.evaluate(() => {
        document.body.classList.add("vscode-high-contrast");
        document.documentElement.style.setProperty("--vscode-focusBorder", "rgb(243, 133, 24)");
        document.documentElement.style.setProperty("--vscode-button-background", "rgb(0, 0, 0)");
      });
      assert.equal(
        await page.$eval(`${entry("tool:t3")} .dot`, (d) => getComputedStyle(d).backgroundColor),
        "rgb(243, 133, 24)",
      );
    });

    // ----------------------------------------------------------------- prompts

    const LONG_PROMPT = "Refactor token refresh into the auth service. ".repeat(12);
    const prompt = (id: string, text: string): TranscriptItem => ({
      kind: "user",
      id: `user:${id}`,
      text,
      attachments: [],
      time: at(23, 12, 21),
    });

    it("clamps a long prompt to two fading lines and opens it on click or Enter", async () => {
      await host({ type: "transcript", items: [prompt("u1", "short"), prompt("u2", LONG_PROMPT)] });
      const cls = (id: string) => page.$eval(`[data-id="user:${id}"] .bubble`, (b) => b.className);
      assert.equal(await cls("u1"), "bubble", "a short prompt is not clamped");
      assert.equal(await cls("u2"), "bubble long");
      const height = () =>
        page.$eval('[data-id="user:u2"] .btxt', (t) => (t as HTMLElement).getBoundingClientRect().height);
      const clamped = await height();
      await page.click('[data-id="user:u2"] .btxt');
      assert.equal(await cls("u2"), "bubble long open");
      assert.ok((await height()) > clamped * 2);
      await page.focus('[data-id="user:u2"] .bubble');
      await page.keyboard.press("Enter");
      assert.equal(await cls("u2"), "bubble long");
    });

    it("rewinds to before a prompt from ↺ after a centered confirmation, only when idle", async () => {
      await host({ type: "transcript", items: [prompt("msg_9", "hello")] });
      await clearSent();
      const actions = () => page.$eval(".pacts", (a) => getComputedStyle(a).opacity);
      // Fork and Rewind show on hover; without a mouse (hover: none) they stay visible.
      assert.equal(await actions(), (await noHover()) ? "1" : "0", "Fork and Rewind show on hover");
      await page.hover(".bubble");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await actions(), "1");
      await page.click('[data-testid="rewind"]');
      assert.deepEqual(await sent(), [], "nothing happens before the dialog is answered");
      const g = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="dialog"]')!.getBoundingClientRect();
        return {
          dx: Math.abs(d.left + d.width / 2 - window.innerWidth / 2),
          dy: Math.abs(d.top + d.height / 2 - window.innerHeight / 2),
          focus: (document.activeElement as HTMLElement).dataset.testid,
          role: document.querySelector('[data-testid="dialog"]')!.getAttribute("role"),
        };
      });
      assert.ok(g.dx < 2 && g.dy < 2, "centered in the panel");
      assert.equal(g.focus, "rewind-chat", "the safer choice has focus");
      assert.equal(g.role, "alertdialog");
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="dialog"]'), null);
      assert.deepEqual(await sent(), [], "Escape cancels");
      await page.click('[data-testid="rewind"]');
      await page.click('[data-testid="rewind-code"]');
      assert.deepEqual(await sent(), [{ type: "rewind", messageID: "msg_9", files: true }]);
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(
        await page.$eval('[data-testid="rewind"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      assert.equal(await page.$eval(".bubble", (b) => b.className), "bubble", "clicking ↺ does not open it");
    });

    it("forks from a prompt, and the whole session from the / palette", async () => {
      await host({ type: "transcript", items: [prompt("msg_9", "hello")] });
      await host({ type: "state", state: baseState({ currentSession: { id: "ses_1", title: "T" } }) });
      await clearSent();
      await page.hover(".bubble");
      await page.click('[data-testid="fork"]');
      assert.deepEqual(await sent(), [{ type: "forkSession", messageID: "msg_9" }]);
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-fork"]');
      assert.deepEqual(await lastSent("forkSession"), { type: "forkSession" });
    });

    it("@ lists files, agents and skills above the box and inserts the pick as a mention", async () => {
      await page.click("textarea");
      await page.keyboard.type("compare @sr");
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some(
          (m) => m.type === "findMentions" && m.query === "sr",
        ),
      );
      const req = (await sent()).filter((m) => m.type === "findMentions").at(-1)!;
      await host({
        type: "mentionResults",
        requestId: String(req.requestId),
        items: [
          { kind: "folder", value: "src", label: "src/" },
          { kind: "file", value: "src/auth.ts", label: "auth.ts", detail: "src/" },
        ],
      });
      const g = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="mention-menu"]') as HTMLElement;
        const box = document.querySelector(".box")!.getBoundingClientRect();
        const r = list.getBoundingClientRect();
        return {
          hidden: list.hidden,
          rows: [...list.querySelectorAll('[data-testid="mention-option"]')].map(
            (o) => (o as HTMLElement).innerText,
          ),
          above: r.bottom <= box.top,
          width: Math.abs(r.width - box.width) < 1,
          focus: document.activeElement?.tagName,
        };
      });
      assert.equal(g.hidden, false);
      assert.deepEqual(g.rows, ["src/", "auth.ts\nsrc/"]);
      assert.ok(g.above && g.width, "a list as wide as the box, just above it");
      assert.equal(g.focus, "TEXTAREA", "the caret stays in the box");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(
        await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value),
        "compare @src/auth.ts ",
      );
      assert.equal(await page.$eval('[data-testid="mention-menu"]', (l) => (l as HTMLElement).hidden), true);
      await page.keyboard.type("please");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), {
        type: "send",
        text: "compare @src/auth.ts please",
        mentions: [{ kind: "file", value: "src/auth.ts", text: "@src/auth.ts" }],
      });
    });

    it("Escape closes the @ list without stopping the agent, and a deleted token is not sent", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await page.click("textarea");
      await page.keyboard.type("@");
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "findMentions"),
      );
      const req = (await sent()).filter((m) => m.type === "findMentions").at(-1)!;
      await host({
        type: "mentionResults",
        requestId: String(req.requestId),
        items: [{ kind: "agent", value: "explore", label: "explore", detail: "Reads code." }],
      });
      await clearSent();
      await page.keyboard.press("Escape");
      assert.equal(await lastSent("stop"), undefined);
      assert.equal(await page.$eval('[data-testid="mention-menu"]', (l) => (l as HTMLElement).hidden), true);
    });

    it("attaches a pasted image with a preview and its size", async () => {
      await page.click("textarea");
      await page.evaluate(async () => {
        const c = document.createElement("canvas");
        c.width = 40;
        c.height = 30;
        const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
        document
          .querySelector("textarea")!
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "attachImage"),
      );
      const m = (await lastSent("attachImage"))!;
      assert.equal(m.name, "shot.png");
      assert.equal(m.width, 40);
      assert.equal(m.height, 30);
      assert.match(String(m.dataUrl), /^data:image\/png;base64,/);
      assert.match(String(m.thumb), /^data:image\/png;base64,/);
      await host({
        type: "state",
        state: baseState({
          attachments: [
            { id: "i1", label: "shot.png", detail: "40×30 · 1 KB", kind: "image", thumb: String(m.thumb) },
          ],
        }),
      });
      assert.equal(await page.$eval(".chip.img .chip-thumb", (i) => (i as HTMLImageElement).complete), true);
      assert.deepEqual((await text(".chip.img")).split("\n"), ["shot.png", "40×30", "×"]);
    });

    it("archives from the history, and restores from its Archived view", async () => {
      const sess = (id: string, title: string) => ({
        id,
        title,
        created: 1,
        updated: Date.now(),
        agent: "build",
        modelKey: null,
        variant: null,
        outcome: null,
        cost: null,
      });
      await host({
        type: "state",
        state: baseState({
          sessions: [sess("ses_1", "Token refresh"), { ...sess("ses_2", "Fork"), forked: true }],
        }),
      });
      await page.click('[data-testid="history-button"]');
      assert.equal(await page.$$eval(".fork-mark", (m) => m.length), 1, "forks are marked");
      await clearSent();
      await page.hover(".session-row");
      await page.click('[data-testid="session-archive"]');
      assert.deepEqual(await sent(), [{ type: "archiveSession", id: "ses_1", archived: true }]);
      await page.click('[data-testid="history-archived"]');
      assert.deepEqual(await lastSent("loadArchived"), { type: "loadArchived" });
      assert.equal(await text(".session-list"), "Loading archived sessions…");
      await host({
        type: "state",
        state: baseState({ archivedSessions: [sess("ses_9", "Old work")] }),
      });
      await page.hover(".session-row");
      await page.click('[data-testid="session-restore"]');
      assert.deepEqual(await lastSent("archiveSession"), {
        type: "archiveSession",
        id: "ses_9",
        archived: false,
      });
      assert.equal(await text('[data-testid="history-archived"]'), "Back to sessions");
    });

    it("hides the turns a rewind staged in another client removed, with Restore and Apply", async () => {
      await host({
        type: "transcript",
        items: [
          prompt("u1", "first"),
          { kind: "assistant", id: "text:a1:0", text: "one", streaming: false },
          prompt("u2", "second"),
          { kind: "assistant", id: "text:a2:0", text: "two", streaming: false },
        ],
      });
      await host({ type: "state", state: baseState({ revert: { messageID: "u2", files: 1 } }) });
      const visible = (id: string) =>
        page.$eval(`[data-id="${id}"]`, (el) => (el as HTMLElement).getClientRects().length > 0);
      assert.equal(await visible("user:u1"), true);
      assert.equal(await visible("user:u2"), false);
      assert.equal(await visible("text:a2:0"), false);
      assert.match(
        await text('[data-testid="revert-bar"]'),
        /Rewound in another OpenCode client · 1 file restored/,
      );
      await clearSent();
      await page.click('[data-testid="revert-restore"]');
      await page.click('[data-testid="revert-apply"]');
      await page.click('[data-testid="revert-confirm"]');
      assert.deepEqual(await sent(), [
        { type: "resolveRevert", action: "restore" },
        { type: "resolveRevert", action: "apply" },
      ]);
      await host({ type: "state", state: baseState({ revert: null }) });
      assert.equal(await visible("user:u2"), true);
      assert.equal(await page.$eval('[data-testid="revert-bar"]', (b) => (b as HTMLElement).hidden), true);
    });

    it("pins the prompt of the turn being read and hands over to the next one", async () => {
      await page.setViewport({ width: 400, height: 700 });
      const filler = (id: string): TranscriptItem => ({
        kind: "assistant",
        id,
        text: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n"),
        streaming: false,
      });
      await host({
        type: "transcript",
        items: [
          prompt("a", "First prompt"),
          filler("text:1"),
          prompt("b", "Second prompt"),
          filler("text:2"),
        ],
      });
      const pinned = () =>
        page.evaluate(() => {
          const top = document.querySelector(".conversation")!.getBoundingClientRect().top;
          return Array.from(document.querySelectorAll<HTMLElement>(".prompt"))
            .filter((p) => Math.abs(p.getBoundingClientRect().top - top) < 1)
            .map((p) => p.dataset.id);
        });
      const scrollTo = (sel: string) =>
        page.$eval(sel, (el) => {
          const c = document.querySelector(".conversation")!;
          c.scrollTop += el.getBoundingClientRect().top - c.getBoundingClientRect().top;
        });
      await scrollTo('[data-id="text:1"] p:nth-child(20)');
      assert.deepEqual(await pinned(), ["user:a"]);
      await scrollTo('[data-id="text:2"] p:nth-child(20)');
      assert.deepEqual(await pinned(), ["user:b"]);
      // Off in the settings: prompts scroll away with their turn.
      await host({
        type: "state",
        state: baseState({ prefs: { ...baseState().prefs, stickyPrompt: false } }),
      });
      assert.deepEqual(await pinned(), []);
    });

    // --------------------------------------------------------------- tool rows

    const tool = (
      id: string,
      name: string,
      category: Extract<TranscriptItem, { kind: "tool" }>["category"],
      status: "running" | "completed" | "failed",
      detail: Partial<Extract<TranscriptItem, { kind: "tool" }>["detail"]>,
    ): TranscriptItem => ({
      kind: "tool",
      id,
      name,
      title: name,
      category,
      status,
      detail: {
        facts: [],
        command: null,
        cwd: null,
        output: null,
        outputTruncated: false,
        exitCode: null,
        files: [],
        error: null,
        subagent: null,
        ...detail,
      },
    });
    const TOOLS: TranscriptItem[] = [
      tool("tool:read", "read", "read", "completed", { path: "/w/my-app/src/auth/session.ts" }),
      tool("tool:edit", "edit", "edit", "completed", {
        path: "/w/my-app/src/auth/service.ts",
        files: [{ path: "src/auth/service.ts", additions: 2, deletions: 1, status: "modified" }],
        diffs: [
          {
            path: "src/auth/service.ts",
            more: 0,
            lines: [
              { t: "ctx", text: "keep" },
              { t: "del", text: "old" },
              { t: "add", text: "new one" },
              { t: "add", text: "new two" },
            ],
          },
        ],
      }),
      tool("tool:write", "write", "edit", "completed", {
        path: "/w/my-app/test/race.test.ts",
        written: { lines: ["a", "b", "c"], total: 3 },
      }),
      tool("tool:sh", "shell", "shell", "failed", {
        command: "npm test -- race",
        exitCode: 2,
        output: "one\ntwo\nthree\nfour\nfive\n",
      }),
      tool("tool:grep", "grep", "search", "completed", {
        pattern: "refresh(",
        path: "/w/my-app/src",
        output: "src/api.ts:118",
      }),
    ];

    it("shows each tool call as its own row: name in bold, then what it worked on", async () => {
      await host({ type: "transcript", items: TOOLS });
      assert.deepEqual(
        await page.$$eval('[data-testid="tool-name"]', (els) => els.map((e) => e.textContent)),
        ["Read", "Edit", "Write", "Shell", "Search"],
      );
      assert.equal(
        await page.$eval('[data-id="tool:sh"] [data-testid="tool"]', (e) => e.getAttribute("data-status")),
        "failed",
      );
      // Paths inside the open folder read relative; the link opens the full path.
      assert.equal(await text('[data-id="tool:read"] [data-testid="tool-path"]'), "src/auth/session.ts");
      await page.click('[data-id="tool:read"] [data-testid="tool-path"]');
      assert.deepEqual(await lastSent("openFile"), {
        type: "openFile",
        path: "/w/my-app/src/auth/session.ts",
      });
      assert.equal(await text('[data-id="tool:grep"] .th'), "Searchrefresh(in src");
    });

    it("shows an edit's changed lines inline and opens the diff editor on click or Enter", async () => {
      await host({ type: "transcript", items: TOOLS });
      // The net change, as one phrase; the exact counts are in its tooltip.
      assert.equal(await text('[data-id="tool:edit"] .tool-sub'), "Added 1 line");
      assert.equal(
        await page.$eval('[data-id="tool:edit"] .tool-sub', (e) => e.getAttribute("data-tip")),
        "+2 −1",
      );
      assert.deepEqual(
        await page.$$eval('[data-id="tool:edit"] .dl', (els) =>
          els.map((e) => `${e.className.replace("dl dl-", "")}:${e.textContent}`),
        ),
        ["ctx: keep", "del:−old", "add:+new one", "add:+new two"],
      );
      await page.click('[data-testid="tool-diff"]');
      assert.deepEqual(await lastSent("openAgentDiff"), {
        type: "openAgentDiff",
        path: "src/auth/service.ts",
      });
      await clearSent();
      await page.focus('[data-testid="tool-diff"]');
      await page.keyboard.press("Enter");
      assert.ok(await lastSent("openAgentDiff"), "Enter opens the diff too");
      assert.equal(await text('[data-id="tool:write"] .tool-sub'), "Wrote 3 lines");
      await page.click('[data-testid="tool-written"]');
      assert.deepEqual(await lastSent("openFile"), { type: "openFile", path: "/w/my-app/test/race.test.ts" });
    });

    it("shows a shell call as IN/OUT; a click opens the command or the output in an editor tab", async () => {
      await host({ type: "transcript", items: TOOLS });
      assert.deepEqual(
        await page.$$eval('[data-id="tool:sh"] .io-k', (els) => els.map((e) => e.textContent)),
        ["IN", "OUT"],
      );
      assert.equal(await text('[data-id="tool:sh"] .io-in pre'), "npm test -- race");
      const out = '[data-id="tool:sh"] [data-testid="tool-output"]';
      const height = await page.$eval(`${out} pre`, (p) => p.getBoundingClientRect().height);
      const lineHeight = await page.$eval(`${out} pre`, (p) => parseFloat(getComputedStyle(p).lineHeight));
      assert.ok(height < lineHeight * 4, "long output shows about three lines");
      await clearSent();
      await page.click(out);
      assert.deepEqual(await sent(), [{ type: "openToolText", itemId: "tool:sh", part: "out" }]);
      await page.focus('[data-id="tool:sh"] [data-testid="tool-command"]');
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("openToolText"), {
        type: "openToolText",
        itemId: "tool:sh",
        part: "in",
      });
      assert.equal(await text('[data-id="tool:sh"] .tool-error'), "Exit code 2");
    });

    it("colors code by language in diffs and finished code blocks, from DOM text only", async () => {
      await host({ type: "transcript", items: TOOLS });
      const diffTokens = await page.$$eval('[data-id="tool:edit"] .tk', (els) =>
        els.map((e) => `${e.className}:${e.textContent}`),
      );
      assert.ok(diffTokens.length > 0, "the .ts diff is colored");
      await host({
        type: "transcript",
        items: [
          {
            kind: "assistant",
            id: "text:code",
            text: ["```ts", "const x: number = 1; // one", "```", "", "```", "plain text", "```"].join("\n"),
            streaming: false,
          },
        ],
      });
      const kinds = await page.$$eval('[data-id="text:code"] pre code', (els) =>
        els.map((e) => [...e.querySelectorAll(".tk")].map((t) => t.className.split(" ")[1])),
      );
      assert.ok(kinds[0].includes("tk-keyword") && kinds[0].includes("tk-comment"), kinds[0].join());
      assert.deepEqual(kinds[1], [], "no language, no colors");
      assert.equal(
        await page.$eval('[data-id="text:code"] pre code', (e) => e.textContent),
        "const x: number = 1; // one",
        "the text is unchanged",
      );
      // Prism's automatic page highlighting stays off.
      assert.equal(
        await page.evaluate(() => (window as unknown as { Prism: { manual: boolean } }).Prism.manual),
        true,
      );
    });

    it("shows a search's output as a line count that opens in an editor tab", async () => {
      await host({ type: "transcript", items: TOOLS });
      const link = '[data-id="tool:grep"] [data-testid="tool-output"]';
      assert.equal(await text(link), "1 line of output");
      await clearSent();
      await page.click(link);
      assert.deepEqual(await sent(), [{ type: "openToolText", itemId: "tool:grep", part: "out" }]);
    });

    it("copies a shell command or its output from the button at the end of the line", async () => {
      await host({ type: "transcript", items: TOOLS });
      const btn = '[data-id="tool:sh"] .io-in [data-testid="io-copy"]';
      const opacity = () => page.$eval(btn, (b) => getComputedStyle(b).opacity);
      // Hidden until the line is hovered; without a mouse (hover: none) it stays visible.
      assert.equal(await opacity(), (await noHover()) ? "1" : "0", "hidden until the line is hovered");
      await page.hover('[data-id="tool:sh"] .io-in');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await opacity(), "1");
      await clearSent();
      await page.click(btn);
      const req = await lastSent("copy");
      assert.equal(req?.text, "npm test -- race");
      assert.equal((await sent()).filter((m) => m.type === "openToolText").length, 0, "copy does not open");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text(btn), "✓");
    });

    it("keeps long commands, diffs and paths inside a 300px panel; boxes scroll inside", async () => {
      await page.setViewport({ width: 300, height: 900 });
      const long = "x".repeat(300);
      await host({
        type: "transcript",
        items: [
          tool("tool:r", "read", "read", "completed", { path: `/elsewhere/${"deep/".repeat(30)}file.ts` }),
          tool("tool:s", "shell", "shell", "completed", { command: `echo ${long}`, output: long }),
          tool("tool:e", "edit", "edit", "completed", {
            diffs: [{ path: "a.ts", more: 0, lines: [{ t: "add", text: long }] }],
          }),
        ],
      });
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        diffScrolls: (() => {
          const d = document.querySelector(".diff")!;
          return d.scrollWidth > d.clientWidth;
        })(),
        inScrolls: (() => {
          const p = document.querySelector(".io-in pre")!;
          return p.scrollWidth > p.clientWidth;
        })(),
      }));
      assert.ok(m.overflow <= 0, `horizontal overflow ${m.overflow}px`);
      assert.ok(m.diffScrolls && m.inScrolls, "long lines scroll inside their box");
    });

    it("renders an Arabic prompt right-to-left within the sidebar width", async () => {
      await host({ type: "state", state: baseState({ locale: "ar" }) });
      await host({
        type: "transcript",
        items: [{ kind: "user", id: "user:ar", text: "أغلق المرحلة ب/ج فقط ".repeat(6), attachments: [] }],
      });
      assert.equal(await page.$eval(".btxt", (e) => getComputedStyle(e).direction), "rtl");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `overflow ${overflow}`);
    });

    it("is usable in a high-contrast theme without horizontal overflow", async () => {
      await page.evaluate(() => {
        document.body.classList.add("vscode-high-contrast");
        const s = document.documentElement.style;
        for (const [k, v] of Object.entries({
          "--vscode-foreground": "#ffffff",
          "--vscode-sideBar-background": "#000000",
          "--vscode-contrastBorder": "#6fc3df",
          "--vscode-contrastActiveBorder": "#f38518",
          "--vscode-focusBorder": "#f38518",
          "--vscode-button-background": "#000000",
          "--vscode-button-foreground": "#ffffff",
          "--vscode-input-background": "#000000",
          "--vscode-input-foreground": "#ffffff",
        }))
          s.setProperty(k, v);
        document.body.style.background = "#000";
      });
      await host({
        type: "transcript",
        items: [
          { kind: "assistant", id: "text:m:0", text: REPORT, streaming: false },
          {
            kind: "budget",
            id: "budget:1",
            state: "warning",
            text: "Task budget is nearly exhausted.",
            resolved: null,
          },
        ],
      });
      await host({
        type: "state",
        state: baseState({
          budget: { ...baseState().budget, active: true, state: "warning" },
        }),
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      const border = await page.$eval('[data-testid="copy-code"]', (b) => getComputedStyle(b).borderTopWidth);
      assert.equal(border, "1px", "buttons have visible borders in high contrast");
      await page.focus('[data-testid="copy-message"]');
      const outline = await page.$eval(
        '[data-testid="copy-message"]',
        (b) => getComputedStyle(b).outlineWidth,
      );
      assert.equal(outline, "2px", "strong focus indicator");
      fs.mkdirSync(path.join(ROOT, "out-test", "screens"), { recursive: true });
      await page.screenshot({
        path: path.join(ROOT, "out-test", "screens", "high-contrast.png"),
        fullPage: true,
      });
    });
    // ------------------------------------------------------------ onboarding

    const onb = (
      stage: ViewState["onboarding"]["stage"],
      over: Partial<ViewState["onboarding"]> = {},
    ): ViewState["onboarding"] => ({
      stage,
      checklist: { installed: "done", connected: "done", account: "unknown", models: "unknown" },
      hint: null,
      signIn: "idle",
      ...over,
    });
    const status = () => text('[data-testid="connection-status"]');
    const checks = () =>
      page.$$eval("[data-check]", (els) => els.map((e) => (e as HTMLElement).getAttribute("aria-label")));

    it("onboarding A: OpenCode not installed → Install (official page) / Check again, chat disabled", async () => {
      await host({
        type: "state",
        state: baseState({
          connection: { kind: "cli-not-found", searched: ["/usr/local/bin/opencode"] },
          models: null,
          agents: null,
          currentSession: null,
          onboarding: onb("not-installed", {
            checklist: { installed: "todo", connected: "todo", account: "unknown", models: "unknown" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /OpenCode is required/);
      assert.match(card, /Sidecar is a UI for OpenCode and requires OpenCode to be installed\./);
      assert.equal(await status(), "OpenCode not installed");
      assert.deepEqual(await checks(), [
        "Extension installed: done",
        "OpenCode installed: not yet",
        "OpenCode connected: not yet",
        "Account signed in: not checked yet",
        "Models available: not checked yet",
      ]);
      await clearSent();
      await page.click('[data-testid="onb-install"]');
      await page.click('[data-testid="onb-check"]');
      assert.deepEqual(
        (await sent()).map((m) => m),
        [{ type: "openOfficial", link: "install" }, { type: "retry" }],
      );
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), true);
    });

    it("onboarding B: service stopped → Start OpenCode", async () => {
      await host({
        type: "state",
        state: baseState({
          connection: { kind: "not-running", canStart: true, detail: "not running" },
          onboarding: onb("stopped", {
            checklist: { installed: "done", connected: "todo", account: "unknown", models: "unknown" },
          }),
        }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /OpenCode is installed/);
      assert.equal(await status(), "OpenCode stopped");
      await clearSent();
      await page.click('[data-testid="onb-start"]');
      assert.deepEqual(await lastSent("startOpenCode"), { type: "startOpenCode" });
    });

    it("onboarding C: sign-in uses OpenCode's flow, states the privacy promise, asks for no credentials", async () => {
      await host({
        type: "state",
        state: baseState({
          models: [],
          selectedModel: null,
          onboarding: onb("sign-in", {
            checklist: { installed: "done", connected: "done", account: "todo", models: "todo" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /Sign in using OpenCode\. This extension never sees or stores your password\./);
      assert.equal(await status(), "Sign-in required");
      assert.equal(await page.$$eval('[data-testid="onboarding"] input', (els) => els.length), 0);
      assert.equal(await page.$$eval('input[type="password"]', (els) => els.length), 0);
      await clearSent();
      await page.click('[data-testid="onb-sign-in"]');
      await page.click('[data-link="account"]');
      await page.click('[data-testid="onb-provider"]');
      assert.deepEqual(await sent(), [
        { type: "signIn" },
        { type: "openOfficial", link: "account" },
        { type: "connectProvider" },
      ]);
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), true);
    });

    it("onboarding: waiting / cancelled / failed sign-in feedback", async () => {
      const st = (signIn: ViewState["onboarding"]["signIn"]) =>
        baseState({ models: [], onboarding: onb("sign-in", { signIn }) });
      await host({ type: "state", state: st("waiting") });
      assert.match(await text('[data-testid="sign-in-waiting"]'), /finish it in the OpenCode terminal/);
      assert.equal(await page.$('[data-testid="onb-sign-in"]'), null, "no second sign-in while waiting");
      await host({ type: "state", state: st("cancelled") });
      assert.match(await text('[data-testid="onboarding"]'), /Sign-in was not completed/);
      await host({ type: "state", state: st("failed") });
      assert.match(await text('[data-testid="onboarding"]'), /could not complete the sign-in/);
    });

    it("onboarding D: no models → exact guidance, Configure models / Refresh, docs links", async () => {
      await host({
        type: "state",
        state: baseState({
          models: [],
          selectedModel: null,
          onboarding: onb("no-models", {
            checklist: { installed: "done", connected: "done", account: "done", models: "todo" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /No models are available yet\./);
      assert.match(card, /Configure a provider in OpenCode or use an OpenCode Go model\./);
      assert.equal(await status(), "No models");
      assert.equal(await text('[data-testid="model-pill"]'), "No models — connect a provider");
      await clearSent();
      await page.click('[data-testid="onb-provider"]');
      await page.click('[data-testid="onb-refresh"]');
      await page.click('[data-link="providers"]');
      await page.click('[data-link="go"]');
      assert.deepEqual(await sent(), [
        { type: "connectProvider" },
        { type: "refreshConnection" },
        { type: "openOfficial", link: "providers" },
        { type: "openOfficial", link: "go" },
      ]);
    });

    it("onboarding F: no folder → Open Folder; the model pill explains why it is empty", async () => {
      await host({
        type: "state",
        state: baseState({
          workspace: { ...baseState().workspace, active: null, folders: [] },
          models: null,
          agents: null,
          onboarding: onb("no-folder"),
        }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /Open a project to start coding/);
      assert.equal(await status(), "No folder open");
      assert.equal(await text('[data-testid="model-pill"]'), "Open a folder first");
      await clearSent();
      await page.click('[data-testid="onb-open-folder"]');
      assert.deepEqual(await sent(), [{ type: "openFolder" }]);
    });

    it("onboarding E: ready hides onboarding; the status says Connected only then", async () => {
      assert.equal(await page.$('[data-testid="onboarding"]'), null);
      assert.equal(await page.$('[data-testid="sign-in-hint"]'), null);
      assert.equal(await status(), "Connected");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), false);
      await host({ type: "state", state: baseState({ models: null, onboarding: onb("loading") }) });
      assert.equal(await status(), "Checking…");
      assert.equal(await text('[data-testid="model-pill"]'), "Loading models…");
      await host({
        type: "state",
        state: baseState({ models: null, agents: null, onboarding: onb("catalog-error") }),
      });
      assert.equal(await status(), "Models unavailable");
      assert.equal(await text('[data-testid="model-pill"]'), "Models could not be loaded");
      await host({ type: "state", state: baseState({ agents: [] }) });
      await page.click('[data-testid="mode-button"]');
      assert.match(await text('[data-testid="menu"]'), /No agents available/);
    });

    it("onboarding: optional sign-in note while using free models, dismissible; renewal note", async () => {
      await host({
        type: "state",
        state: baseState({ onboarding: onb("ready", { hint: "sign-in-optional" }) }),
      });
      assert.match(await text('[data-testid="sign-in-hint"]'), /No OpenCode account is connected/);
      assert.equal(await page.$('[data-testid="onboarding"]'), null, "never blocks a usable chat");
      await clearSent();
      await page.click('[data-testid="sign-in-hint"] .btn.subtle');
      await page.click('[data-testid="sign-in-hint"] .btn:not(.subtle)');
      assert.deepEqual(await sent(), [{ type: "dismissSignInHint" }, { type: "signIn" }]);
      await host({
        type: "state",
        state: baseState({ onboarding: onb("ready", { hint: "sign-in-expired" }) }),
      });
      assert.match(await text('[data-testid="sign-in-hint"]'), /needs to be renewed/);
      assert.equal(await page.$('[data-testid="sign-in-hint"] .btn.subtle'), null);
    });

    it("onboarding: setup guide link and a compact card without horizontal overflow at 260px", async () => {
      await page.setViewport({ width: 260, height: 700 });
      await host({
        type: "state",
        state: baseState({ models: [], onboarding: onb("sign-in") }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /Need help\? View setup guide/);
      await clearSent();
      await page.click('[data-link="setupGuide"]');
      assert.deepEqual(await sent(), [{ type: "openOfficial", link: "setupGuide" }]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    });

    // ------------------------------------------------------------ subagents

    const SUB = (over: Partial<SubagentView> = {}): SubagentView => ({
      sessionID: "ses_sub",
      parentID: "ses_1",
      depth: 1,
      agent: "explore",
      title: "Find token callers",
      status: "running",
      activity: { kind: "tool", title: "Searched refreshToken(", category: "search" },
      tools: 12,
      files: 3,
      started: Date.now() - 41_000,
      ended: null,
      cost: 0.02,
      error: null,
      ...over,
    });
    const SUBAGENT_TOOL: TranscriptItem = {
      kind: "tool",
      id: "tool:call_1",
      name: "subagent",
      title: "Subagent: Find token callers",
      category: "agent",
      status: "completed",
      detail: {
        facts: [
          ["agent", "explore"],
          ["description", "Find token callers"],
        ],
        command: null,
        cwd: null,
        output: "Started subagent",
        outputTruncated: false,
        exitCode: null,
        files: [],
        error: null,
        subagent: "ses_sub",
      },
    };

    it("shows a subagent as a row: Agent: and its task, a status line with stats, Stop and Open", async () => {
      await host({ type: "transcript", items: [SUBAGENT_TOOL] });
      await host({ type: "state", state: baseState({ busy: true, subagents: [SUB()] }) });
      const card = '[data-testid="subagent-card"]';
      assert.equal(await text('[data-testid="subagent-title"]'), "Find token callers");
      assert.equal(await text('[data-testid="subagent-agent"]'), "explore");
      assert.equal(await text('[data-testid="subagent-activity"]'), "Running · Searched refreshToken(");
      assert.match(await text('[data-testid="subagent-meta"]'), /12 tools · 3 files · 0:4\d$/);
      assert.equal(
        await page.$eval('[data-testid="subagent-meta"]', (e) => e.getAttribute("title")),
        "Cost $0.02",
        "cost moves to the tooltip",
      );
      assert.equal(await page.$eval(card, (el) => el.classList.contains("subagent-running")), true);
      await clearSent();
      await page.click('[data-testid="subagent-open"]');
      await page.click('[data-testid="subagent-stop"]');
      assert.deepEqual(await sent(), [
        { type: "openSubagent", sessionID: "ses_sub" },
        { type: "stopSubagent", sessionID: "ses_sub" },
      ]);
    });

    it("updates the card from state alone and shows when a subagent waits for you or is done", async () => {
      await host({ type: "transcript", items: [SUBAGENT_TOOL] });
      await host({ type: "state", state: baseState({ subagents: [SUB({ status: "waiting" })] }) });
      assert.equal(await text('[data-testid="subagent-activity"]'), "Waiting for you");
      await host({
        type: "state",
        state: baseState({ subagents: [SUB({ status: "completed", activity: null, ended: Date.now() })] }),
      });
      assert.equal(await text('[data-testid="subagent-activity"]'), "Finished");
      assert.equal(await page.$('[data-testid="subagent-stop"]'), null, "no Stop once finished");
    });

    it("says what a waiting subagent waits for: a permission or an answer", async () => {
      const ask = (kind: "permission" | "form"): TranscriptItem =>
        kind === "permission"
          ? {
              kind: "permission",
              id: "perm:p1",
              request: {
                id: "p1",
                sessionID: "ses_sub",
                action: "bash",
                resources: ["npm test"],
                canAlways: false,
                message: null,
                toolId: null,
              },
              sensitive: [],
              status: "pending",
            }
          : {
              kind: "form",
              id: "form:f1",
              status: "pending",
              answer: null,
              form: { id: "f1", sessionID: "ses_sub", title: "Q", toolId: null, fields: [] },
            };
      await host({ type: "state", state: baseState({ subagents: [SUB({ status: "waiting" })] }) });
      await host({ type: "transcript", items: [SUBAGENT_TOOL, ask("permission")] });
      assert.equal(
        await text('[data-testid="subagent-activity"]'),
        "Waiting for your permission: see the request below",
      );
      await host({ type: "transcript", items: [SUBAGENT_TOOL, ask("form")] });
      assert.equal(
        await text('[data-testid="subagent-activity"]'),
        "Waiting for your answer: see the question below",
      );
    });

    it("shows the subagent's exact prompt on one line and opens the whole prompt in an editor tab", async () => {
      const prompt =
        "Find every caller of refreshToken() in src/.\nNote how each one handles a failed refresh.";
      await host({
        type: "transcript",
        items: [{ ...SUBAGENT_TOOL, detail: { ...SUBAGENT_TOOL.detail, prompt } } as TranscriptItem],
      });
      const box = '[data-testid="subagent-prompt"]';
      assert.equal(await page.$eval(box, (e) => getComputedStyle(e).whiteSpace), "nowrap");
      assert.equal(
        await page.$eval(box, (e) => e.textContent),
        prompt,
        "exact prompt, nothing cut from the text",
      );
      await page.click(box);
      assert.deepEqual(await lastSent("openToolText"), {
        type: "openToolText",
        itemId: "tool:call_1",
        part: "prompt",
      });
    });

    it("shows a subagent's report as one line that expands, with a way into its conversation", async () => {
      await host({
        type: "transcript",
        items: [
          SUBAGENT_TOOL,
          {
            kind: "handback",
            id: "handback:h1",
            childID: "ses_sub",
            agent: "Explore",
            state: "completed",
            description: "Find token callers",
            report: "Found **4 callers**.\n\n- session.ts\n- ws.ts",
          },
        ],
      });
      assert.equal(
        await text('[data-testid="handback"]'),
        "Report from explore · Find token callers: Found 4 callers.",
      );
      await page.click('[data-id="handback:h1"] summary');
      assert.equal(await text('[data-id="handback:h1"] .hb-report strong'), "4 callers");
      await clearSent();
      await page.click('[data-testid="handback-open"]');
      assert.deepEqual(await sent(), [{ type: "openSubagent", sessionID: "ses_sub" }]);
    });

    it("shows a launched subagent as starting until OpenCode reports its session", async () => {
      const launching: TranscriptItem = {
        ...SUBAGENT_TOOL,
        status: "running",
        detail: { ...SUBAGENT_TOOL.detail, subagent: null },
      } as TranscriptItem;
      await host({ type: "transcript", items: [launching] });
      assert.equal(await text('[data-testid="subagent-activity"]'), "Starting…");
      assert.equal(await page.$('[data-testid="subagent-open"]'), null);
    });

    it("counts working subagents on the agents pill and lists them all in its menu", async () => {
      await host({
        type: "state",
        state: baseState({
          busy: true,
          subagents: [
            SUB(),
            SUB({ sessionID: "ses_b", agent: "general", title: "Run the tests", status: "waiting" }),
            SUB({
              sessionID: "ses_c",
              parentID: "ses_sub",
              depth: 2,
              title: "Check types",
              status: "completed",
              ended: Date.now(),
            }),
          ],
        }),
      });
      // "● 2" in a narrow panel, "● 2 agents" from 441px.
      assert.equal(await text('[data-testid="agents-pill"]'), "2");
      await page.setViewport({ width: 520, height: 900 });
      assert.equal(
        await page.$eval('[data-testid="agents-pill"]', (p) =>
          (p as HTMLElement).innerText.replace(/\s+/g, " "),
        ),
        "2 agents",
      );
      assert.equal(
        await page.$eval('[data-testid="agents-pill"] .pd', (d) => d.classList.contains("live")),
        true,
      );
      await page.click('[data-testid="agents-pill"]');
      const rows = await page.$$eval('[data-testid="agents-menu-item"] .menu-label', (e) =>
        e.map((x) => x.textContent),
      );
      assert.deepEqual(
        rows,
        ["Run the tests", "Find token callers", "Check types"],
        "waiting first, finished last",
      );
      await clearSent();
      const items = await page.$$('[data-testid="agents-menu-item"]');
      await items[2].click();
      assert.deepEqual(await lastSent("openSubagent"), { type: "openSubagent", sessionID: "ses_c" });
    });

    // ------------------------------------------------------------- step 8 pass

    it("folds runs of tool calls into one line with activity: grouped, and keeps it current", async () => {
      const grouped = baseState({ prefs: { ...baseState().prefs, activity: "grouped" } });
      await host({ type: "state", state: grouped });
      const search = (id: string, status: "running" | "completed" | "failed"): TranscriptItem =>
        ({
          ...TOOL(id, status),
          name: "grep",
          category: "search",
        }) as TranscriptItem;
      await host({
        type: "transcript",
        items: [
          { kind: "user", id: "user:u", text: "q", attachments: [] },
          search("tool:s1", "completed"),
          TOOL("tool:r1", "completed"),
          TOOL("tool:r2", "completed"),
          { kind: "assistant", id: "text:a", text: "found it", streaming: false },
          TOOL("tool:r3", "completed"),
        ],
      });
      const groups = () =>
        page.$$eval('[data-testid="activity-group"]', (g) =>
          g.map((x) => ({
            line: x.querySelector("summary")!.textContent,
            calls: Array.from(x.querySelectorAll(".grp-body > [data-id]")).map(
              (e) => (e as HTMLElement).dataset.id,
            ),
            dot: x.className.match(/dot-(\w+)/)?.[1],
          })),
        );
      assert.deepEqual(await groups(), [
        { line: "Explored1 search, 2 reads", calls: ["tool:s1", "tool:r1", "tool:r2"], dot: "ok" },
      ]);
      assert.ok(await page.$('.timeline > [data-id="tool:r3"]'), "a single call stays on its own");
      // A live call joins the run after r3; a running call makes the dot pulse.
      await host({ type: "state", state: { ...grouped, busy: true } });
      await host({ type: "events", events: [{ type: "tool.started", toolId: "r4", name: "read" }] });
      assert.deepEqual((await groups())[1], {
        line: "Explored2 reads",
        calls: ["tool:r3", "tool:r4"],
        dot: "run",
      });
      await page.click('[data-testid="activity-group"] summary');
      assert.equal(
        await page.$eval('[data-testid="activity-group"] details', (d) => (d as HTMLDetailsElement).open),
        true,
      );
      // Back to every call on its own row.
      await host({ type: "state", state: baseState() });
      assert.equal(await page.$('[data-testid="activity-group"]'), null);
    });

    it("gives every control a visible border in high contrast and keeps a 300px panel free of overflow", async () => {
      await page.setViewport({ width: 300, height: 900 });
      await page.evaluate(() => {
        document.body.classList.add("vscode-high-contrast");
        const s = document.documentElement.style;
        for (const [k, v] of Object.entries({
          "--vscode-contrastBorder": "rgb(111, 195, 223)",
          "--vscode-contrastActiveBorder": "rgb(243, 133, 24)",
          "--vscode-button-background": "#000000",
        }))
          s.setProperty(k, v);
      });
      const usage = { ...baseState().usage!, cacheHit: 0.5, cached: true, lastStepAt: Date.now() };
      await host({
        type: "state",
        state: baseState({
          busy: true,
          usage,
          subagents: [SUB()],
          selectedModel: "opencode-go/qwen3.7-plus",
          selectedVariant: "high",
        }),
      });
      for (const sel of [
        '[data-testid="agents-pill"]',
        '[data-testid="model-pill"]',
        '[data-testid="cache-pill"]',
        ".sq",
      ])
        assert.equal(
          await page.$eval(sel, (e) => getComputedStyle(e).borderTopColor),
          "rgb(111, 195, 223)",
          `${sel} has a contrast border`,
        );
      assert.equal(
        await page.$eval(".box", (e) => getComputedStyle(e).borderTopWidth),
        "2px",
        "working box stands out",
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      // The permission dock: the default option is marked by the active border, not a fill.
      await host({
        type: "transcript",
        items: [
          {
            kind: "permission",
            id: "perm:p1",
            status: "pending",
            sensitive: [],
            request: {
              id: "p1",
              sessionID: "ses_sub",
              action: "bash",
              resources: ["npm test -- session --reporter=spec --runInBand"],
              canAlways: true,
              patterns: ["npm test *"],
              message: null,
              toolId: null,
            },
          },
        ],
      });
      assert.equal(
        await page.$eval(".opt-row.sel", (e) => getComputedStyle(e).borderTopColor),
        "rgb(243, 133, 24)",
      );
      const after = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(after <= 0, `dock overflow ${after}px`);
    });

    it("names the subagent on its permission request", async () => {
      await host({ type: "state", state: baseState({ subagents: [SUB()] }) });
      await host({
        type: "transcript",
        items: [
          {
            kind: "permission",
            id: "perm:p",
            request: {
              id: "p",
              sessionID: "ses_sub",
              action: "bash",
              resources: ["npm test"],
              canAlways: false,
              message: null,
              toolId: null,
            },
            sensitive: [],
            status: "pending",
          },
        ],
      });
      assert.match(
        await text('[data-testid="from-subagent"]'),
        /From subagent\s*EXPLORE\s*Find token callers/,
      );
    });

    it("opens a subagent's conversation with a way back, read-only composer, and live updates", async () => {
      await host({ type: "transcript", items: [SUBAGENT_TOOL] });
      await host({
        type: "state",
        state: baseState({
          busy: true,
          subagents: [SUB()],
          viewingSubagent: { id: "ses_sub", loading: true },
        }),
      });
      await host({ type: "subagentTranscript", sessionID: "ses_sub", items: [] });
      assert.match(await text(".empty"), /Loading the subagent's conversation/);
      await host({
        type: "subagentTranscript",
        sessionID: "ses_sub",
        items: [{ kind: "user", id: "user:u", text: "Find every caller of refreshToken", attachments: [] }],
      });
      await host({
        type: "state",
        state: baseState({
          busy: true,
          subagents: [SUB()],
          viewingSubagent: { id: "ses_sub", loading: false },
        }),
      });
      assert.equal(await text('[data-testid="subagent-view-title"]'), "Find token callers");
      assert.match(await text(".conversation"), /Find every caller of refreshToken/);
      assert.equal(await page.$('[data-testid="subagent-card"]'), null, "the main chat is replaced");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), true);
      await host({
        type: "subagentEvents",
        sessionID: "ses_sub",
        events: [{ type: "assistant.delta", partId: "m:0", delta: "Found 4 callers." }],
      });
      assert.match(await text(".conversation"), /Found 4 callers\./);
      // Events of the main chat do not leak into the subagent view.
      await host({ type: "events", events: [{ type: "assistant.delta", partId: "main:0", delta: "MAIN" }] });
      assert.doesNotMatch(await text(".conversation"), /MAIN/);
      await clearSent();
      await page.click('[data-testid="subagent-back"]');
      assert.deepEqual(await sent(), [{ type: "closeSubagent" }]);
      await host({ type: "state", state: baseState({ busy: true, subagents: [SUB()] }) });
      assert.ok(await page.$('[data-testid="subagent-card"]'));
      assert.match(await text(".conversation"), /MAIN/, "main chat kept its updates");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), false);
    });

    it("fits a nested subagent view in a narrow sidebar without horizontal overflow", async () => {
      await page.setViewport({ width: 260, height: 700 });
      const nested = SUB({
        sessionID: "ses_c",
        parentID: "ses_sub",
        depth: 2,
        agent: "general",
        title: "A long description of the nested subagent's job that must be truncated",
      });
      await host({
        type: "state",
        state: baseState({
          busy: true,
          subagents: [SUB(), nested],
          viewingSubagent: { id: "ses_c", loading: false },
        }),
      });
      await host({ type: "subagentTranscript", sessionID: "ses_c", items: [SUBAGENT_TOOL] });
      assert.match(await text(".crumbs"), /Back to chat\s*\/\s*EXPLORE/);
      await clearSent();
      await page.click('.crumbs [data-key="crumb:ses_sub"]');
      assert.deepEqual(await sent(), [{ type: "openSubagent", sessionID: "ses_sub" }]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    });
  },
);
