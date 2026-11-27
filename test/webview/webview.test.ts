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
import type {
  AgentsView,
  AsideTurn,
  AsideView,
  ImportPreview,
  McpServerInfo,
  ProvidersView,
  StripTab,
  SubagentView,
  TranscriptItem,
} from "../../src/shared/model";
import type { HostMessage, ViewState } from "../../src/shared/protocol";

const ROOT = path.resolve(__dirname, "../../..");
/** Directory holding dist/webview.js and media/main.css; override to test an unpacked VSIX. */
const BUNDLE_ROOT = process.env.WEBVIEW_BUNDLE_ROOT ?? ROOT;
/** The directories these environment variables name (Windows install roots); unset ones are skipped. */
function envDirs(...vars: string[]): string[] {
  return vars.map((v) => process.env[v]).filter((d): d is string => !!d);
}
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  // Windows: Chrome installed for all users or per user, then Edge, which every Windows has.
  ...envDirs("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA").map((d) =>
    path.join(d, "Google", "Chrome", "Application", "chrome.exe"),
  ),
  ...envDirs("ProgramFiles(x86)", "ProgramFiles").map((d) =>
    path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"),
  ),
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
    costs: null,
    quota: null,
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
    strip: [],
    approval: {
      mode: "default",
      folderMode: null,
      modeRules: [],
      rules: [],
      actions: ["edit", "read", "shell", "webfetch"],
      session: true,
      busy: false,
      confirmAuto: true,
    },
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
<script>window.__sent=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__sent.push(JSON.parse(JSON.stringify(m))),getState:()=>(window.name?JSON.parse(window.name):undefined),setState:(s)=>{window.name=JSON.stringify(s)}});</script>
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
      // Drag along the track: it follows the pointer and sends one change, on release.
      const centres = await page.$$eval('[data-testid="variant-slider"] .sd', (d) =>
        d.map((x) => {
          const r = x.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }),
      );
      await clearSent();
      await page.mouse.move(centres[2].x, centres[2].y);
      await page.mouse.down();
      await page.mouse.move(centres[1].x, centres[1].y, { steps: 4 });
      await page.mouse.move(centres[0].x + 1, centres[0].y + 3, { steps: 4 });
      assert.match(await text('[data-testid="variant-slider"]'), /Variant \(Default\)/, "follows the drag");
      assert.equal(await lastSent("selectVariant"), undefined, "nothing sent mid-drag");
      await page.mouse.up();
      assert.deepEqual(
        (await sent()).filter((m) => m.type === "selectVariant"),
        [{ type: "selectVariant", variant: "" }],
        "one change, on release (Default is no variant)",
      );
      // A click off the dots, just beside one (Default, None, High, Max), picks the nearest.
      await page.mouse.click(centres[1].x - 3, centres[1].y + 3);
      assert.deepEqual(await lastSent("selectVariant"), { type: "selectVariant", variant: "none" });
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
      // Wide: the box stops growing at 670px, centred under the wider chat, which shows beside it.
      assert.ok(Math.abs(wide.width - 670) < 1, `670px wide (${wide.width})`);
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
        ["# Context", "# Model", "# Session", "# OpenCode commands", "# Display", "# Settings"],
      );
      // Every action row has an icon and a line saying what it does; switches and sliders
      // carry their own control instead.
      const bare = await page.$$eval(".menu .menu-item:not(.toggle):not(.slider)", (rows) =>
        rows
          .filter((r) => !r.querySelector("svg") || !r.querySelector(".menu-sub")?.textContent)
          .map((r) => r.querySelector(".menu-label")?.textContent),
      );
      assert.deepEqual(bare, []);
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
      assert.deepEqual(
        await page.$eval('[data-testid="compact"]', (b) => [
          !!b.querySelector("svg"),
          b.querySelector(".menu-sub")?.textContent,
        ]),
        [true, "Summarize the conversation to free context"],
        "with the icon and line it has in the / palette",
      );
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

    const COSTS: ViewState["costs"] = {
      byModel: [
        { key: "opencode-go/kimi-k2.7-code", label: "", steps: 12, tokens: 4200, cost: 0.05 },
        { key: "opencode/big-pickle", label: "", steps: 3, tokens: 800, cost: 0 },
        { key: "local/llama", label: "", steps: 2, tokens: 90, cost: null },
      ],
      byAgent: [
        { key: "build", label: "build", steps: 15, tokens: 5000, cost: 0.05 },
        { key: "ses_sub", label: "explore", steps: 2, tokens: 90, cost: 0.01, depth: 1, total: 0.03 },
        { key: "ses_sub2", label: "general", steps: null, tokens: 0, cost: 0.02, depth: 2 },
      ],
      session: 0.06,
      total: 0.09,
      other: 0.01,
    };
    const tableRows = (testid: string) =>
      page.$$eval(`[data-testid="${testid}"] tbody tr`, (rows) =>
        rows.map((r) => Array.from(r.children).map((c) => (c as HTMLElement).innerText)),
      );

    it("breaks the session's cost down by model and by agent, subagents nested with their totals", async () => {
      await host({ type: "state", state: baseState({ costs: COSTS }) });
      await clearSent();
      await page.click('[data-testid="context-ring"]');
      assert.ok(await lastSent("loadUsageDetails"), "the menu asks for what fills the context");
      assert.deepEqual(await tableRows("cost-by-model"), [
        ["Kimi K2.7 Code", "12", "4.2k", "$0.05"],
        ["big-pickle", "3", "800", "$0.00"],
        ["llama", "2", "90", "—"],
      ]);
      assert.deepEqual(await tableRows("cost-by-agent"), [
        ["Build", "15", "$0.05"],
        ["↳ explore", "2", "$0.01 ($0.03)"],
        ["↳ general", "—", "$0.02"],
      ]);
      const menu = await text('[data-testid="menu"]');
      assert.match(menu, /Session \$0\.06: \$0\.01 for titles and compaction, with subagents \$0\.09\./);
      assert.match(menu, /— : OpenCode reported no cost for these steps\./);
      assert.match(menu, /Loading…/);
      // Nothing known yet: no tables, no empty headings.
      await page.keyboard.press("Escape");
      await host({ type: "state", state: baseState({ costs: null }) });
      await page.click('[data-testid="context-ring"]');
      assert.equal(await page.$('[data-testid="cost-by-model"]'), null);
      assert.doesNotMatch(await text('[data-testid="menu"]'), /Cost by/);
    });

    it("shows what fills the context once the host sends it, with the rest named honestly", async () => {
      await page.click('[data-testid="context-ring"]');
      await host({
        type: "usageDetails",
        context: {
          total: 42000,
          limit: 262144,
          parts: [
            { key: "prompts", tokens: 1200 },
            { key: "tools", tokens: 9800 },
            { key: "rest", tokens: 31000 },
          ],
          images: 1,
          messages: 12,
        },
        today: { sessions: 4, steps: 30, cost: 0.4, tokens: 9000, models: [] },
      });
      assert.ok(await page.$('[data-testid="menu"]'), "the menu stays open with the new figures");
      const parts = await page.$$eval('[data-testid^="context-part-"]', (els) =>
        els.map((e) => [
          (e as HTMLElement).dataset.testid,
          e.querySelector(".menu-stat")?.textContent,
          e.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"),
        ]),
      );
      assert.deepEqual(parts, [
        ["context-part-prompts", "Your messages~1.2k", "3"],
        ["context-part-tools", "Tool calls and results~9.8k", "23"],
        ["context-part-rest", "System prompt, tools and instructions31k", "74"],
      ]);
      const menu = await text('[data-testid="menu"]');
      assert.match(menu, /what is left of OpenCode's total/);
      assert.match(menu, /1 image not counted/);
      assert.doesNotMatch(menu, /Loading…/);
      // Today's usage shows with the cost tables.
      await page.keyboard.press("Escape");
      await host({ type: "state", state: baseState({ costs: COSTS }) });
      await page.click('[data-testid="context-ring"]');
      await host({
        type: "usageDetails",
        context: null,
        today: { sessions: 4, steps: 30, cost: 0.4, tokens: 1, models: [] },
      });
      assert.match(await text('[data-testid="menu"]'), /Today in this project\s*\$0\.40 · 4 sessions/);
      assert.equal(await page.$('[data-testid^="context-part-"]'), null, "no context figures: no section");
    });

    it("shows provider limits as meters with their reset, and a warning chip from 80%", async () => {
      const chip = '[data-testid="quota-chip"]';
      const hidden = () => page.$eval(chip, (b) => (b as HTMLElement).hidden);
      assert.equal(await hidden(), true, "no limits reported: no chip");
      await page.click('[data-testid="context-ring"]');
      assert.doesNotMatch(await text('[data-testid="menu"]'), /Limits/, "and no empty section");
      await page.keyboard.press("Escape");
      const quota: ViewState["quota"] = {
        workspace: "Acme",
        meters: [
          {
            id: "go:rolling",
            label: "Go · rolling",
            percent: 86,
            used: null,
            limited: false,
            resetsAt: Date.now() + 3 * 3600_000 - 1000,
          },
          {
            id: "go:weekly",
            label: "Go · weekly",
            percent: 20,
            used: null,
            limited: false,
            resetsAt: Date.now() + 25 * 60_000,
          },
          {
            id: "budget:b",
            label: "Budget · all models",
            percent: 32,
            used: "$3.20 / $10.00",
            limited: false,
            resetsAt: null,
          },
        ],
      };
      await host({ type: "state", state: baseState({ quota }) });
      assert.equal(await hidden(), false);
      assert.equal(await text(chip), "86%");
      assert.equal(
        await page.$eval(chip, (b) => (b as HTMLElement).dataset.tip),
        "Go · rolling: 86% used, resets in 3 h",
      );
      await page.click(chip);
      const meters = await page.$$eval('[data-testid="quota-meter"]', (els) =>
        els.map((e) => [
          (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          e.classList.contains("warn"),
        ]),
      );
      assert.deepEqual(meters, [
        ["Go · rolling 86% resets in 3 h", true],
        ["Go · weekly 20% resets in 25 min", false],
        ["Budget · all models $3.20 / $10.00 · 32%", false],
      ]);
      assert.match(await text('[data-testid="menu"]'), /Limits · Acme/);
      await page.keyboard.press("Escape");
      // Under 80% everywhere: the chip goes; a reached limit brings it back.
      await host({ type: "state", state: baseState({ quota: { ...quota, meters: quota.meters.slice(1) } }) });
      assert.equal(await hidden(), true);
      await host({
        type: "state",
        state: baseState({
          quota: { workspace: null, meters: [{ ...quota.meters[2], percent: 40, limited: true }] },
        }),
      });
      assert.equal(await hidden(), false);
      assert.match((await page.$eval(chip, (b) => (b as HTMLElement).dataset.tip)) ?? "", /limit reached/);
    });

    it("fits the cost tables and meters in a 300px panel", async () => {
      await page.setViewport({ width: 300, height: 800 });
      const quota: ViewState["quota"] = {
        workspace: "A workspace with a long name",
        meters: [
          {
            id: "b",
            label: "Budget · Kimi K2.7 Code, GLM 5, Qwen 3 (you)",
            percent: 91,
            used: "$9.10 / $10.00",
            limited: false,
            resetsAt: Date.now() + 5 * 86400_000,
          },
        ],
      };
      await host({ type: "state", state: baseState({ costs: COSTS, quota }) });
      await page.click('[data-testid="quota-chip"]');
      const fit = await page.$eval('[data-testid="menu"]', (m) => {
        const r = m.getBoundingClientRect();
        const tables = Array.from(m.querySelectorAll("table")).map((t) => t.getBoundingClientRect().right);
        return {
          right: r.right,
          left: r.left,
          tables,
          vw: window.innerWidth,
          scroll: document.documentElement.scrollWidth,
        };
      });
      assert.ok(fit.left >= 0 && fit.right <= fit.vw, JSON.stringify(fit));
      assert.ok(
        fit.tables.every((x) => x <= fit.right + 0.5),
        "tables stay inside the menu",
      );
      assert.ok(fit.scroll <= fit.vw, "no sideways scroll");
      assert.match(await text('[data-testid="menu"]'), /resets on/);
    });

    it("puts the turn's model, steps, tokens, speed and cost under it", async () => {
      await host({
        type: "transcript",
        items: [
          { kind: "user", id: "user:u1", text: "go", attachments: [] },
          { kind: "assistant", id: "text:a", text: "Done.", streaming: false },
          {
            kind: "turn-meta",
            id: "meta:1",
            models: ["opencode-go/kimi-k2.7-code", "opencode/big-pickle"],
            steps: 3,
            tokens: 1234,
            rate: 41.6,
            cost: 0.012,
          },
          { kind: "user", id: "user:u2", text: "free", attachments: [] },
          {
            kind: "turn-meta",
            id: "meta:2",
            models: ["opencode/big-pickle"],
            steps: 1,
            tokens: 9,
            rate: null,
            cost: 0,
          },
        ],
      });
      const metas = await page.$$eval('[data-testid="turn-meta"]', (els) =>
        els.map((e) => (e as HTMLElement).innerText),
      );
      assert.deepEqual(metas, [
        "Kimi K2.7 Code, big-pickle · 3 steps · 1.2k tokens · 42 tok/s · $0.01",
        "big-pickle · 1 step · 9 tokens",
      ]);
    });

    it("shows a live tokens-a-second estimate while a reply streams, and hides it between replies", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      const rate = () => text('[data-testid="tok-rate"]');
      assert.equal(await rate(), "");
      await host({ type: "events", events: [{ type: "step.started", modelKey: null, agent: "build" }] });
      await host({ type: "events", events: [{ type: "assistant.delta", partId: "p:0", delta: "Hello " }] });
      await new Promise((r) => setTimeout(r, 700));
      await host({
        type: "events",
        events: [{ type: "assistant.delta", partId: "p:0", delta: "x".repeat(400) }],
      });
      assert.match(await rate(), /^ · ~\d+ tok\/s$/);
      assert.match(
        (await page.$eval('[data-testid="tok-rate"]', (e) => e.getAttribute("title"))) ?? "",
        /Estimated from the streamed text/,
      );
      // The step ends (a tool runs next): the readout goes until text streams again.
      await host({
        type: "events",
        events: [
          {
            type: "usage.step",
            tokens: { input: 1, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            modelKey: null,
          },
        ],
      });
      assert.equal(await rate(), "");
      await host({ type: "state", state: baseState({ busy: false }) });
      assert.equal(await page.$eval('[data-testid="working"]', (e) => (e as HTMLElement).hidden), true);
    });

    it("keeps a subagent's own cost on its row and adds its subagents' to the tooltip", async () => {
      await host({ type: "transcript", items: [SUBAGENT_TOOL] });
      await host({ type: "state", state: baseState({ subagents: [SUB({ cost: 0.02, totalCost: 0.05 })] }) });
      assert.equal(
        await page.$eval('[data-testid="subagent-meta"]', (e) => e.getAttribute("title")),
        "Its own cost $0.02; with its subagents $0.05",
      );
      // Its conversation's header shows both.
      await host({ type: "subagentTranscript", sessionID: "ses_sub", items: [] });
      await host({
        type: "state",
        state: baseState({
          subagents: [SUB({ cost: 0.02, totalCost: 0.05 })],
          viewingSubagent: { id: "ses_sub", loading: false },
        }),
      });
      assert.match(await text('[data-testid="subagent-cost"]'), /^\$0\.02 · \$0\.05 with subagents$/);
    });

    it("keeps the header to the title, approval, Bookmarks, History and New session; renames in place", async () => {
      assert.deepEqual(
        await page.$$eval(".header button", (b) => b.map((x) => x.getAttribute("data-testid"))),
        ["session-title", "approval-badge", "bookmarks-button", "history-button", "new-session"],
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

    it("a new permission request closes any open menu or popover so nothing covers it", async () => {
      await page.click('[data-testid="context-ring"]');
      assert.ok(await page.$('[data-testid="menu"]'), "the usage menu is open");
      await host({ type: "transcript", items: [PERM()] });
      assert.equal(await page.$('[data-testid="menu"]'), null, "the menu closed");
      assert.equal(await text('[data-testid="permission-dock"] .dock-title'), "Allow this shell command?");
      // A later state update with the same request does not close a menu opened since.
      await page.click('[data-testid="bookmarks-button"]');
      await host({ type: "state", state: baseState() });
      assert.equal(
        await page.$eval(".bookmarks", (b) => (b as HTMLElement).hidden),
        false,
        "Bookmarks stay open",
      );
      // The next request closes it.
      await host({ type: "transcript", items: [PERM(), PERM({ id: "p2" })] });
      await host({ type: "transcript", items: [PERM({ id: "p2" })] });
      assert.equal(
        await page.$eval(".bookmarks", (b) => (b as HTMLElement).hidden),
        true,
        "Bookmarks closed",
      );
    });

    it("recalls this session's earlier prompts with ↑ and ↓ from an empty box", async () => {
      await host({
        type: "transcript",
        items: [prompt("u1", "first"), prompt("u2", "second"), prompt("u3", "first")],
      });
      const value = () => page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value);
      await page.focus("textarea");
      await page.keyboard.press("ArrowUp");
      assert.equal(await value(), "first", "newest first");
      await page.keyboard.press("ArrowUp");
      assert.equal(await value(), "second", "repeats appear once");
      await page.keyboard.press("ArrowUp");
      assert.equal(await value(), "second", "stays on the oldest");
      await page.keyboard.press("ArrowDown");
      assert.equal(await value(), "first");
      await page.keyboard.press("ArrowDown");
      assert.equal(await value(), "", "back to the empty box");
      // Editing a recalled prompt makes it the draft: the arrows move the caret again.
      await page.keyboard.press("ArrowUp");
      await page.keyboard.type("!");
      await page.keyboard.press("ArrowUp");
      assert.equal(await value(), "first!");
      // A draft in the box is never replaced.
      await page.$eval("textarea", (t) => ((t as HTMLTextAreaElement).value = ""));
      await page.keyboard.type("my draft");
      await page.keyboard.press("ArrowUp");
      assert.equal(await value(), "my draft");
    });

    it("offers Jump to latest while scrolled up, counting what arrived since", async () => {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      const long = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n");
      const items: TranscriptItem[] = [
        prompt("u1", "a prompt"),
        { kind: "assistant", id: "text:long", text: long, streaming: false },
      ];
      await host({ type: "transcript", items });
      const jump = () =>
        page.$eval('[data-testid="jump-latest"]', (b) => ((b as HTMLElement).hidden ? null : b.textContent));
      assert.equal(await jump(), null, "hidden at the end of the chat");
      await page.$eval(".conversation", (c) => c.scrollTo({ top: 0 }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await jump(), "Jump to latest");
      // A new step streams in while the reader is up the page.
      await host({ type: "events", events: [{ type: "assistant.completed", partId: "more", text: "More" }] });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await jump(), "1 new");
      assert.ok(
        await page.$eval(".conversation", (c) => c.scrollTop < 50),
        "the reader stays where they are",
      );
      await page.click('[data-testid="jump-latest"]');
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        await page.$eval(".conversation", (c) => c.scrollHeight - c.scrollTop - c.clientHeight < 2),
        "at the end",
      );
      assert.equal(await jump(), null);
    });

    const APPROVAL = baseState().approval;
    const BALANCED_RULES = [
      { action: "shell", resource: "*", effect: "ask" as const },
      { action: "webfetch", resource: "*", effect: "ask" as const },
    ];
    const OWN_RULE = { action: "shell", resource: "npm test *", effect: "allow" as const };

    it("shows the approval mode in the header, Auto in its own color, at every width", async () => {
      const badge = '[data-testid="approval-badge"]';
      assert.equal(await text(badge), "Default");
      await host({ type: "state", state: baseState({ approval: { ...APPROVAL, mode: "balanced" } }) });
      assert.equal(await text(badge), "Balanced");
      assert.match(
        String(await page.$eval(badge, (b) => b.getAttribute("data-tip"))),
        /commands, web requests/,
      );
      const look = () =>
        page.$eval(badge, (b) =>
          [getComputedStyle(b).fontWeight, getComputedStyle(b).borderTopWidth].join(" "),
        );
      const balanced = await look();
      await host({ type: "state", state: baseState({ approval: { ...APPROVAL, mode: "auto" } }) });
      assert.equal(await text(badge), "Auto");
      assert.equal(await page.$eval(badge, (b) => b.getAttribute("data-mode")), "auto");
      assert.notEqual(await look(), balanced, "Auto stands out");
      // Without a session it names the mode the next one starts in.
      await host({
        type: "state",
        state: baseState({ currentSession: null, approval: { ...APPROVAL, mode: "ask", session: false } }),
      });
      assert.match(String(await page.$eval(badge, (b) => b.getAttribute("aria-label"))), /next session/);
      // A request in the dock does not hide it, and it fits a narrow panel.
      await host({ type: "transcript", items: [PERM()] });
      for (const width of [300, 400, 520]) {
        await page.setViewport({ width, height: 800 });
        await new Promise((r) => setTimeout(r, 30));
        const box = await page.$eval(badge, (b) => {
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, shown: r.width > 0 };
        });
        assert.ok(box.shown && box.left >= 0 && box.right <= width, `width ${width}`);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `no sideways scroll at ${width}`,
        );
      }
    });

    it("switches the mode from the badge's menu, for the session or the folder", async () => {
      await host({
        type: "state",
        state: baseState({ approval: { ...APPROVAL, mode: "ask", folderMode: "ask" } }),
      });
      await page.click('[data-testid="approval-badge"]');
      const rows = await page.$$eval(
        '[data-testid="menu"] .menu-list .menu-item[data-testid^="approval-"]',
        (els) =>
          els.map((e) => [
            e.getAttribute("data-testid"),
            e.getAttribute("aria-checked"),
            e.querySelector(".menu-sub")?.textContent ?? "",
          ]),
      );
      assert.deepEqual(
        rows.map((r) => r.slice(0, 2)),
        [
          ["approval-ask", "true"],
          ["approval-balanced", "false"],
          ["approval-auto", "false"],
          ["approval-default", "false"],
          ["approval-rules", null],
        ],
      );
      assert.match(String(rows[0][2]), /Asks before every edit/);
      assert.match(String(rows[2][2]), /destructive commands are blocked/);
      assert.match(await text('[data-testid="menu"]'), /Plan still never edits/);
      await page.click('[data-testid="approval-balanced"]');
      assert.deepEqual(await lastSent("setApprovalMode"), {
        type: "setApprovalMode",
        mode: "balanced",
        scope: "session",
      });
      assert.equal(await page.$('[data-testid="menu"]'), null, "the menu closes");
      // "This folder" from the slider, then by keyboard.
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-scope"] .sd[data-value="folder"]');
      await page.focus('[data-testid="approval-default"]');
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("setApprovalMode"), {
        type: "setApprovalMode",
        mode: "default",
        scope: "folder",
      });
      // Rules that match no mode say so.
      await host({
        type: "state",
        state: baseState({ approval: { ...APPROVAL, mode: "custom", rules: [OWN_RULE] } }),
      });
      await page.click('[data-testid="approval-badge"]');
      assert.match(await text('[data-testid="menu"]'), /match no mode/);
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "approval-badge",
      );
    });

    it("asks once before Auto, with Don't ask again", async () => {
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-auto"]');
      assert.match(
        await text('[data-testid="dialog"]'),
        /Switch to Auto\?[\s\S]*destructive commands stay blocked/,
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "auto-confirm",
      );
      await page.click('[data-testid="dialog-cancel"]');
      assert.equal(await lastSent("setApprovalMode"), undefined, "cancelled: nothing sent");
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-auto"]');
      await page.click('[data-testid="auto-confirm"]');
      assert.deepEqual(await lastSent("setApprovalMode"), {
        type: "setApprovalMode",
        mode: "auto",
        scope: "session",
      });
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-auto"]');
      await page.click('[data-testid="auto-dont-ask"]');
      assert.deepEqual(await lastSent("setApprovalMode"), {
        type: "setApprovalMode",
        mode: "auto",
        scope: "session",
        dontAskAgain: true,
      });
      // Once confirmed for good, Auto switches straight away.
      await clearSent();
      await host({ type: "state", state: baseState({ approval: { ...APPROVAL, confirmAuto: false } }) });
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-auto"]');
      assert.equal(await page.$('[data-testid="dialog"]'), null);
      assert.deepEqual(await lastSent("setApprovalMode"), {
        type: "setApprovalMode",
        mode: "auto",
        scope: "session",
      });
    });

    it("edits the session's rules: add, edit and delete, with the mode's rules read-only", async () => {
      const withRules = (rules: (typeof OWN_RULE)[]) =>
        baseState({ approval: { ...APPROVAL, mode: "balanced", modeRules: BALANCED_RULES, rules } });
      await host({ type: "state", state: withRules([]) });
      await page.click('[data-testid="approval-badge"]');
      await page.click('[data-testid="approval-rules"]');
      assert.ok(await lastSent("loadSavedPermissions"));
      const rows = (testid: string) =>
        page.$$eval(`[data-testid="rules-editor"] [data-testid="${testid}"]`, (els) =>
          els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
        );
      assert.deepEqual(await rows("mode-rule"), [
        "Ask shell * from Balanced",
        "Ask webfetch * from Balanced",
      ]);
      assert.match(await text('[data-testid="rules-editor"]'), /No rules of your own yet/);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "rule-pattern",
        "ready to type a pattern",
      );
      // An empty pattern is refused in place.
      await page.click('[data-testid="rule-save"]');
      assert.match(await text('[data-testid="rule-error"]'), /Type a pattern/);
      assert.equal(await lastSent("setSessionRules"), undefined);
      await page.type('[data-testid="rule-pattern"]', "npm test *");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("setSessionRules"), { type: "setSessionRules", rules: [OWN_RULE] });
      assert.equal(
        await page.$eval('[data-testid="rule-pattern"]', (i) => (i as HTMLInputElement).value),
        "",
      );
      // OpenCode's answer comes back as state.
      await host({ type: "state", state: withRules([OWN_RULE]) });
      assert.deepEqual(await rows("session-rule"), ["Allow shell npm test * Edit Delete"]);
      await page.click('[data-testid="rule-edit"]');
      assert.equal(await text('[data-testid="rule-save"]'), "Save rule");
      await page.$eval('[data-testid="rule-pattern"]', (i) => ((i as HTMLInputElement).value = ""));
      await page.type('[data-testid="rule-pattern"]', "rm *");
      await page.select('[data-testid="rule-effect"]', "deny");
      await page.click('[data-testid="rule-save"]');
      assert.deepEqual(await lastSent("setSessionRules"), {
        type: "setSessionRules",
        rules: [{ action: "shell", resource: "rm *", effect: "deny" }],
      });
      await page.click('[data-testid="rule-delete"]');
      assert.deepEqual(await lastSent("setSessionRules"), { type: "setSessionRules", rules: [] });
      // A custom action from the picker's list, typed.
      await page.$eval('[data-testid="rule-action"]', (i) => ((i as HTMLInputElement).value = ""));
      await page.type('[data-testid="rule-action"]', "webfetch");
      await page.type('[data-testid="rule-pattern"]', "https://docs.example.com/*");
      await page.click('[data-testid="rule-save"]');
      assert.deepEqual(await lastSent("setSessionRules"), {
        type: "setSessionRules",
        rules: [OWN_RULE, { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" }],
      });
      assert.deepEqual(
        await page.$$eval("#rule-actions option", (o) => o.map((x) => (x as HTMLOptionElement).value)),
        APPROVAL.actions,
      );
      // Busy while OpenCode answers: no second change.
      await host({
        type: "state",
        state: baseState({ approval: { ...APPROVAL, rules: [OWN_RULE], busy: true } }),
      });
      assert.equal(
        await page.$eval('[data-testid="rule-delete"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="rules-editor"]'), null, "Escape closes it");
    });

    it("lists the folder's always-allowed rules to edit or remove", async () => {
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="permission-rules"]');
      assert.match(await text('[data-testid="rules-editor"]'), /Loading…/);
      await host({
        type: "savedPermissions",
        items: [{ id: "ps_1", action: "bash", resource: "npm test *", created: Date.now() - 2 * 3600_000 }],
      });
      assert.deepEqual(
        await page.$$eval('[data-testid="saved-permission"]', (e) =>
          e.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
        ),
        ["Allow bash npm test * 2h ago Edit Remove"],
      );
      await page.click('[data-testid="saved-edit"]');
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "saved-pattern",
      );
      await page.$eval('[data-testid="saved-pattern"]', (i) => ((i as HTMLInputElement).value = ""));
      await page.type('[data-testid="saved-pattern"]', "npm *");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("updateSavedPermission"), {
        type: "updateSavedPermission",
        id: "ps_1",
        action: "bash",
        resource: "npm *",
      });
      assert.match(await text('[data-testid="rules-editor"]'), /Loading…/, "until OpenCode lists them again");
      await host({
        type: "savedPermissions",
        items: [{ id: "ps_1", action: "bash", resource: "npm *", created: 0 }],
      });
      await page.click('[data-testid="saved-remove"]');
      assert.deepEqual(await lastSent("removeSavedPermission"), {
        type: "removeSavedPermission",
        id: "ps_1",
      });
      await host({ type: "savedPermissions", items: [] });
      assert.match(await text('[data-testid="rules-editor"]'), /Nothing is always allowed here/);
      await host({ type: "savedPermissions", items: null, error: "OpenCode could not list them." });
      assert.match(
        await text('[data-testid="rules-editor"]'),
        /Couldn't load them: OpenCode could not list them\./,
      );
      // Without a session there are no session rules to add yet.
      await host({
        type: "state",
        state: baseState({ currentSession: null, approval: { ...APPROVAL, session: false } }),
      });
      assert.equal(await visible('[data-testid="rule-form"]'), false);
      assert.match(await text('[data-testid="rules-editor"]'), /Start or open a session/);
      await page.click('[data-testid="rules-close"]');
      assert.equal(await page.$('[data-testid="rules-editor"]'), null);
    });

    it("always allows commands like this: a pattern to edit, for the session or the folder", async () => {
      await host({ type: "transcript", items: [PERM({ resources: ["npm test -- --grep foo"] })] });
      assert.deepEqual(
        await page.$$eval(".opt-row", (r) => r.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " "))),
        ["1 Yes", "2 Yes, always allow npm test *", "3 No"],
        "the numbered answers stay as they were",
      );
      assert.equal(await text('[data-testid="perm-like"]'), "Always allow commands like this…");
      await page.click('[data-testid="perm-like"]');
      const pattern = '[data-testid="perm-like-pattern"]';
      assert.equal(await page.$eval(pattern, (i) => (i as HTMLInputElement).value), "npm test *");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "perm-like-pattern",
      );
      assert.match(await text('[data-testid="perm-like-match"]'), /Covers this request/);
      await page.$eval(pattern, (i) => ((i as HTMLInputElement).value = ""));
      await page.type(pattern, "npm run *");
      assert.match(await text('[data-testid="perm-like-match"]'), /Doesn't cover this request/);
      await page.$eval(pattern, (i) => ((i as HTMLInputElement).value = ""));
      await page.type(pattern, "npm test *");
      // Digits typed into the pattern are not answers.
      assert.equal(await lastSent("respondPermission"), undefined);
      await page.click('[data-testid="perm-like-folder"]');
      assert.equal(
        await page.$eval('[data-testid="perm-like-folder"]', (b) => b.getAttribute("aria-pressed")),
        "true",
      );
      assert.equal(
        await page.$eval(pattern, (i) => (i as HTMLInputElement).value),
        "npm test *",
        "kept as typed",
      );
      await page.click('[data-testid="perm-like-save"]');
      assert.deepEqual(await lastSent("allowLike"), {
        type: "allowLike",
        requestId: "p1",
        patterns: ["npm test *"],
        scope: "folder",
      });
    });

    it("offers only this session when OpenCode has no folder rule, and keeps the sensitive-path warning", async () => {
      await host({
        type: "transcript",
        items: [
          {
            ...PERM({ action: "read", resources: ["/w/my-app/config/.env"], canAlways: false, patterns: [] }),
            sensitive: [".env — environment file (may contain secrets)"],
          } as TranscriptItem,
        ],
      });
      assert.match(await text('[data-testid="permission-dock"] .sensitive'), /Sensitive path[\s\S]*\.env/);
      assert.equal(await text('[data-testid="perm-like"]'), "Always allow requests like this…");
      await page.click('[data-testid="perm-like"]');
      assert.equal(
        await page.$eval('[data-testid="perm-like-pattern"]', (i) => (i as HTMLInputElement).value),
        "/w/my-app/config/*",
      );
      assert.equal(
        await page.$eval('[data-testid="perm-like-folder"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      assert.ok(
        await page.$('[data-testid="permission-dock"] .sensitive'),
        "the warning stays while editing",
      );
      // Escape closes the editor, not the request.
      await page.focus('[data-testid="perm-like-session"]');
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="perm-like-editor"]'), null);
      assert.equal(await lastSent("respondPermission"), undefined);
      await page.click('[data-testid="perm-like"]');
      await page.focus('[data-testid="perm-like-pattern"]');
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("allowLike"), {
        type: "allowLike",
        requestId: "p1",
        patterns: ["/w/my-app/config/*"],
        scope: "session",
      });
    });

    it("shows the Git branch beside the title, a detached HEAD's commit, and nothing without Git", async () => {
      assert.equal(await text('[data-testid="branch"]'), "main");
      const ws = baseState().workspace;
      await host({
        type: "state",
        state: baseState({ workspace: { ...ws, branch: null, detachedAt: "abc1234" } }),
      });
      assert.equal(await text('[data-testid="branch"]'), "detached at abc1234");
      await host({
        type: "state",
        state: baseState({ workspace: { ...ws, branch: null, detachedAt: null } }),
      });
      assert.equal(await page.$('[data-testid="branch"]'), null);
    });

    it("finds in the conversation with Ctrl+F: counts, steps with Enter and closes with Esc", async () => {
      await host({
        type: "transcript",
        items: [
          prompt("u1", "Where is the token refreshed?"),
          {
            kind: "assistant",
            id: "text:a",
            text: "The token is refreshed in auth. A second token check runs later.",
            streaming: false,
          },
        ],
      });
      await page.focus("textarea");
      await page.keyboard.down("Control");
      await page.keyboard.press("f");
      await page.keyboard.up("Control");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "find-input",
      );
      await page.keyboard.type("TOKEN");
      assert.equal(
        await text('[data-testid="find-count"]'),
        "1 of 3",
        "case-insensitive, prompts and answers",
      );
      await page.keyboard.press("Enter");
      assert.equal(await text('[data-testid="find-count"]'), "2 of 3");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      assert.equal(await text('[data-testid="find-count"]'), "1 of 3");
      const marked = await page.evaluate(() => {
        const reg = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
        return reg ? [reg.get("sidecar-find")?.size, reg.get("sidecar-find-current")?.size] : null;
      });
      if (marked) assert.deepEqual(marked, [3, 1], "all matches marked, one current");
      await page.keyboard.type("zzz");
      assert.equal(await text('[data-testid="find-count"]'), "No results");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval('[data-testid="findbar"]', (b) => (b as HTMLElement).hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "back to the box");
    });

    it("puts a finished code block into the editor: at the cursor or as a new file", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:c", text: "```py\nprint(1)\n```", streaming: false }],
      });
      await page.click('[data-testid="insert-code"]');
      assert.deepEqual(await lastSent("insertCode"), { type: "insertCode", text: "print(1)" });
      await page.click('[data-testid="open-code"]');
      assert.deepEqual(await lastSent("openCode"), { type: "openCode", text: "print(1)", lang: "py" });
      // A block still streaming has only Copy.
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:s", text: "```py\nprint(1)", streaming: true }],
      });
      assert.equal(await page.$('[data-testid="insert-code"]'), null);
    });

    it("deletes an archived session or the open one, only after a confirmation", async () => {
      // From the / palette: the open session.
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-delete"]');
      assert.match(await text('[data-testid="dialog"]'), /Delete this session permanently\?/);
      await page.click('[data-testid="delete-keep"]');
      assert.equal(await lastSent("deleteSession"), undefined, "keeping it sends nothing");
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-delete"]');
      await page.click('[data-testid="delete-confirm"]');
      assert.deepEqual(await lastSent("deleteSession"), { type: "deleteSession", id: "ses_1" });
    });

    it("exports the session, lists MCP servers, and opens History on request", async () => {
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-export"]');
      assert.ok(await lastSent("exportSession"));
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="mcp-servers"]');
      assert.ok(await lastSent("loadMcpServers"));
      assert.ok(await page.$('[data-testid="mcp-panel"]'), "the MCP panel opens");
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="mcp-panel"]'), null);
      await host({ type: "showHistory" });
      assert.equal(await page.$eval(".sessions", (s) => (s as HTMLElement).hidden), false, "History is open");
    });

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
      assert.equal(
        await page.$eval(
          '[data-testid="working"] .i-mark .orbit',
          (g) => getComputedStyle(g).animationDuration,
        ),
        "1.1s",
      );
      // The word is plain text between changes: no cursor.
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await page.$('[data-testid="status-word"] .cur'), null, "no cursor while the word stays");
      // Every 8 seconds it moves to another word, never the same one: a block cursor sweeps
      // across, turning the old letters into the new ones, then goes away.
      const first = await text('[data-testid="status-word"]');
      await page.evaluate(() => {
        const real = Date.now.bind(Date);
        Date.now = () => real() + 9000;
      });
      await page.waitForFunction(() => !!document.querySelector('[data-testid="status-word"] .cur'), {
        timeout: 3000,
      });
      await page.waitForFunction(
        (w) => {
          const b = document.querySelector('[data-testid="status-word"]');
          return !!b && !b.querySelector(".cur") && b.textContent !== w;
        },
        { timeout: 3000 },
        first,
      );
      assert.match(await text('[data-testid="status-word"]'), /^[A-Z][a-z ]+…$/);
      await host({
        type: "state",
        state: baseState({ busy: true, prefs: { ...baseState().prefs, statusWords: false } }),
      });
      assert.equal(await text('[data-testid="status-word"]'), "Working…", "plain with the setting off");
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(await text('[data-testid="status-word"]'), "Working…", "and it stays put");
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

    it("steers or queues follow-ups from the footer switch while running, with Alt+Enter for one the other way", async () => {
      const switchShown = () =>
        page.$eval(".delivery", (d) => !(d as HTMLElement).hidden && getComputedStyle(d).display !== "none");
      assert.equal(await switchShown(), false, "nothing to choose while idle");
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(await switchShown(), true);
      const placeholder = () => page.$eval("textarea", (t) => (t as HTMLTextAreaElement).placeholder);
      const checked = () =>
        page.$$eval(".delivery .seg", (b) => b.map((x) => x.getAttribute("aria-checked")));
      assert.equal(await placeholder(), "Steer the agent…");
      assert.deepEqual(await checked(), ["true", "false"]);
      // The agent menu is only about agents now.
      await page.click('[data-testid="mode-button"]');
      assert.equal(await page.$('[data-testid="mode-queue"]'), null);
      await page.keyboard.press("Escape");
      await page.click('[data-testid="delivery-queue"]');
      assert.deepEqual(await checked(), ["false", "true"]);
      assert.equal(await placeholder(), "Queue a message for after this task…");
      assert.equal(
        await page.$eval(".box", (b) => b.classList.contains("queueing")),
        true,
        "the box takes the queue colour",
      );
      // Alt+Enter sends this one the other way; the switch stays on Queue.
      await page.type("textarea", "Also check the logout path.");
      await page.keyboard.down("Alt");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Alt");
      assert.deepEqual(await lastSent("send"), {
        type: "send",
        text: "Also check the logout path.",
        delivery: "steer",
      });
      assert.deepEqual(await checked(), ["false", "true"]);
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
      // The badge stays readable when the theme's badge colour is the accent (Dark Modern).
      for (const delivery of ["steer", "queue"] as const) {
        await host({
          type: "state",
          state: baseState({
            busy: true,
            pending: [{ id: "msg_b", text: "Check the other callers.", attachments: [], delivery }],
          }),
        });
        const colors = await page.$eval('[data-testid="pending-item"] .badge', (b) => {
          const root = document.documentElement;
          root.style.setProperty("--vscode-badge-background", getComputedStyle(b).color);
          const s = getComputedStyle(b);
          return { fg: s.color, bg: s.backgroundColor };
        });
        assert.notEqual(colors.fg, colors.bg, `${delivery} badge text matches its background`);
        assert.match(
          await text('[data-testid="pending-item"] .badge'),
          delivery === "steer" ? /Steering/ : /Queued/,
        );
      }
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
      // A waiting message can switch to steering before it is delivered.
      await page.click('[data-testid="pending-switch"]');
      assert.deepEqual(await lastSent("setDelivery"), {
        type: "setDelivery",
        id: "msg_q",
        delivery: "steer",
      });
      const buttons = await page.$$(
        '[data-testid="pending-item"] button:not([data-testid="pending-switch"])',
      );
      await buttons[0].click();
      assert.deepEqual(await lastSent("editPending"), { type: "editPending", id: "msg_q" });
      await buttons[1].click();
      assert.deepEqual(await lastSent("removePending"), { type: "removePending", id: "msg_q" });
      await host({ type: "restoreInput", text: "edited text" });
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "edited text");
    });

    it("shows only the chosen delivery mode at 300px, flips it on a tap, and keeps the footer on one row", async () => {
      await page.setViewport({ width: 300, height: 900 });
      await host({ type: "state", state: baseState({ busy: true }) });
      const shown = () =>
        page.$$eval(".delivery .seg", (b) =>
          b.filter((x) => getComputedStyle(x).display !== "none").map((x) => x.getAttribute("data-testid")),
        );
      assert.deepEqual(await shown(), ["delivery-steer"]);
      // One toggle button, not a lone radio: its label and tooltip say what a click does.
      const a11y = await page.$eval('[data-testid="delivery-steer"]', (b) => ({
        role: b.getAttribute("role"),
        checked: b.getAttribute("aria-checked"),
        label: b.getAttribute("aria-label"),
        tip: (b as HTMLElement).dataset.tip,
        group: b.parentElement!.getAttribute("role"),
      }));
      assert.equal(a11y.role, null);
      assert.equal(a11y.checked, null);
      assert.equal(a11y.group, "group");
      assert.match(a11y.label ?? "", /Click to switch to Queue$/);
      assert.match(a11y.tip ?? "", /Click to switch to Queue/);
      await page.click('[data-testid="delivery-steer"]');
      assert.deepEqual(await shown(), ["delivery-queue"]);
      assert.match(
        (await page.$eval('[data-testid="delivery-queue"]', (b) => b.getAttribute("aria-label"))) ?? "",
        /Click to switch to Steer$/,
      );
      assert.equal(
        await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).placeholder),
        "Queue a message for after this task…",
      );
      await page.click('[data-testid="delivery-queue"]');
      assert.deepEqual(await shown(), ["delivery-steer"]);
      // Stop stays on the tools row, level with the switch.
      const tops = await page.evaluate(() =>
        [".delivery", '[data-testid="stop"]'].map((s) =>
          Math.round(document.querySelector(s)!.getBoundingClientRect().top),
        ),
      );
      assert.ok(Math.abs(tops[0] - tops[1]) <= 3, `switch at ${tops[0]}, stop at ${tops[1]}`);
    });

    it("gives every model and agent row a second line, even when OpenCode sends no figure or description", async () => {
      const st = baseState();
      await host({
        type: "state",
        state: {
          ...st,
          models: [
            ...st.models!,
            { ...st.models![0], key: "x/local", id: "local", name: "Local", contextLimit: null },
          ],
          agents: [...st.agents!, { id: "reviewer", name: "Reviewer" }],
        },
      });
      const subs = async (button: string, row: string) => {
        await page.click(`[data-testid="${button}"]`);
        const out = await page.$$eval(`[data-testid="${row}"]`, (rows) =>
          rows.map((r) => [
            r.querySelector(".menu-label")?.textContent,
            r.querySelector(".menu-sub")?.textContent,
          ]),
        );
        await page.keyboard.press("Escape");
        return out;
      };
      const models = await subs("model-pill", "model-option");
      assert.ok(
        models.every(([, sub]) => !!sub),
        JSON.stringify(models),
      );
      assert.deepEqual(models.at(-1), ["Local", "Context size not reported"]);
      const agents = await subs("mode-button", "agent-option");
      assert.ok(
        agents.every(([, sub]) => !!sub),
        JSON.stringify(agents),
      );
      assert.deepEqual(agents.at(-1), ["Reviewer", "Defined in your OpenCode config"]);
    });

    it("Shift+Tab in the message box switches the agent", async () => {
      await page.focus("textarea");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
      assert.deepEqual(await lastSent("selectAgent"), { type: "selectAgent", id: "plan" });
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus stays");
    });

    it("Review all opens the review; per-file Diff uses the agent diff; workspace changes are separate", async () => {
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
      assert.ok(await lastSent("reviewChanges"));
      await page.click('[data-testid="agent-changes-toggle"]');
      await page.click('[data-testid="file-diff"]');
      assert.deepEqual(await lastSent("openAgentDiff"), { type: "openAgentDiff", path: "a.txt" });
      await page.click('[data-testid="view-workspace-changes"]');
      assert.ok(await lastSent("openWorkspaceDiffAll"));
    });

    it("lists agent changes as rows that open their diff: name first, folder muted, no zero counts", async () => {
      await host({
        type: "state",
        state: baseState({
          agentChanges: {
            status: "ok",
            files: [
              { path: "src/math.js", additions: 5, deletions: 1, status: "modified" },
              { path: "test-add.mjs", additions: 15, deletions: 0, status: "added" },
            ],
          },
        }),
      });
      assert.equal(await text('[data-testid="view-agent-changes"]'), "Review all");
      assert.doesNotMatch(await text(".changes"), /HEAD/, "git jargon only in the tooltip");
      await page.click('[data-testid="agent-changes-toggle"]');
      assert.deepEqual(
        await page.$$eval('.changes [data-testid="file-diff"]', (rows) =>
          rows.map((r) =>
            [".fname", ".fdir", ".adds", ".dels", ".ftag"].map(
              (s) => r.querySelector(s)?.textContent ?? null,
            ),
          ),
        ),
        [
          ["math.js", "src", "+5", "−1", null],
          ["test-add.mjs", null, "+15", null, "new"],
        ],
      );
      await page.click('.changes li:nth-child(2) [data-testid="file-diff"]');
      assert.deepEqual(await lastSent("openAgentDiff"), { type: "openAgentDiff", path: "test-add.mjs" });
      await page.click('.changes li:nth-child(1) [data-testid="file-open"]');
      assert.deepEqual(await lastSent("openFile"), { type: "openFile", path: "src/math.js" });
    });

    it("shows what is left to review on Review all and on each file row", async () => {
      const files = [
        { path: "src/math.js", additions: 5, deletions: 1, status: "modified" as const },
        { path: "img/logo.png", additions: 0, deletions: 0, status: "modified" as const },
        { path: "test-add.mjs", additions: 15, deletions: 0, status: "added" as const },
      ];
      const counts = (undecided: number, kept: number, undone: number, more = {}) => ({
        undecided,
        kept,
        undone,
        changed: 0,
        fileOnly: false,
        ...more,
      });
      await host({
        type: "state",
        state: baseState({
          agentChanges: { status: "ok", files },
          review: {
            files: {
              "src/math.js": counts(2, 1, 1, { changed: 1 }),
              "img/logo.png": counts(1, 0, 0, { fileOnly: true }),
              "test-add.mjs": counts(0, 1, 0),
            },
            undecided: 3,
            kept: 2,
            undone: 1,
          },
        }),
      });
      assert.equal(await text('[data-testid="view-agent-changes"]'), "Review all · 3");
      await page.click('[data-testid="agent-changes-toggle"]');
      const tags = await page.$$eval('[data-testid="file-review"]', (t) =>
        t.map((e) => [(e as HTMLElement).innerText, (e as HTMLElement).dataset.tip, e.className]),
      );
      assert.deepEqual(tags, [
        ["2", "2 to review · 1 kept · 1 undone · 1 edited since", "freview"],
        ["1", "1 to review · reviewed as a whole file", "freview"],
        ["✓", "Reviewed · 1 kept", "freview done"],
      ]);
      // Keyboard: the button opens the review.
      await clearSent();
      await page.focus('[data-testid="view-agent-changes"]');
      await page.keyboard.press("Enter");
      assert.deepEqual(await sent(), [{ type: "reviewChanges" }]);
      // All decided.
      await host({
        type: "state",
        state: baseState({
          agentChanges: { status: "ok", files },
          review: {
            files: {
              "src/math.js": counts(0, 3, 1),
              "img/logo.png": counts(0, 1, 0, { fileOnly: true }),
              "test-add.mjs": counts(0, 1, 0),
            },
            undecided: 0,
            kept: 5,
            undone: 1,
          },
        }),
      });
      assert.equal(await text('[data-testid="view-agent-changes"]'), "Reviewed");
      // Narrow and wide panels: nothing scrolls sideways.
      for (const width of [300, 520]) {
        await page.setViewport({ width, height: 800 });
        await host({ type: "state", state: baseState({ agentChanges: { status: "ok", files } }) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `no sideways scroll at ${width} px`,
        );
      }
      assert.equal(await page.$('[data-testid="file-review"]'), null, "no tags without a review");
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

    it("fixes the file's or the workspace's problems from + and /, and shows them as one chip", async () => {
      for (const [menu, testid, scope] of [
        ["add-context", "menu-fix-file", "file"],
        ["add-context", "menu-fix-workspace", "workspace"],
        ["commands-button", "command-fix-file", "file"],
        ["commands-button", "command-fix-workspace", "workspace"],
      ]) {
        await clearSent();
        await page.click(`[data-testid="${menu}"]`);
        await page.click(`[data-testid="${testid}"]`);
        assert.deepEqual(await lastSent("fixProblems"), { type: "fixProblems", scope }, testid);
      }
      await host({
        type: "state",
        state: baseState({
          attachments: [
            {
              id: "p1",
              label: "50 of 73 problems · 12 files",
              detail: "33 errors, 17 warnings in 12 files (first 50 of 73)\nsrc/a.ts\nsrc/b.ts",
              kind: "problems",
            },
          ],
        }),
      });
      const chip = '[data-testid="problems-chip"]';
      assert.equal(await text(`${chip} .chip-label`), "50 of 73 problems · 12 files");
      assert.ok(await page.$(`${chip} .i-warn`), "a warning icon");
      assert.match((await page.$eval(chip, (c) => (c as HTMLElement).dataset.tip)) ?? "", /first 50 of 73/);
      // The host suggests the words; an empty box takes them, typed text is kept.
      await host({ type: "suggestInput", text: "Fix these problems." });
      assert.equal(
        await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value),
        "Fix these problems.",
      );
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await page.$eval("textarea", (t) => ((t as HTMLTextAreaElement).value = ""));
      await page.keyboard.type("Only the type errors");
      await host({ type: "suggestInput", text: "Fix these problems." });
      assert.equal(
        await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value),
        "Only the type errors",
      );
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "Only the type errors" });
      await page.click(`${chip} .chip-x`);
      assert.deepEqual(await lastSent("removeAttachment"), { type: "removeAttachment", id: "p1" });
    });

    it("the editor context chip follows the editor, is marked as such and can be removed", async () => {
      const auto = (label: string, detail: string) =>
        baseState({
          attachments: [
            { id: "a1", label: "notes.md", detail: "docs/notes.md" },
            { id: `auto:/w/my-app/${detail}`, label, detail, auto: true },
          ],
          prefs: { stickyPrompt: true, cacheWarmMinutes: 5, activity: "detailed", autoContext: true },
        });
      await host({ type: "state", state: auto("app.ts", "src/app.ts") });
      const chip = '[data-testid="auto-chip"]';
      assert.equal(await text(`${chip} .chip-label`), "app.ts");
      assert.equal(await text(`${chip} .chip-detail`), "editor");
      assert.ok(await page.$(`${chip} .i-file`));
      assert.match(
        (await page.$eval(chip, (c) => (c as HTMLElement).dataset.tip)) ?? "",
        /Follows the editor/,
      );
      assert.equal(
        await page.$eval(chip, (c) => getComputedStyle(c).borderTopStyle),
        "dashed",
        "told apart from chips you added",
      );
      // A selection in the editor: the same chip now stands for the lines.
      await host({ type: "state", state: auto("app.ts:3-9", "src/app.ts lines 3-9") });
      assert.equal(await text(`${chip} .chip-label`), "app.ts:3-9");
      assert.ok(await page.$(`${chip} .i-selection`));
      assert.equal(
        await page.$$eval(".chips .chip", (c) => c.length),
        2,
        "one editor chip, never other tabs",
      );
      await page.click(`${chip} .chip-x`);
      assert.deepEqual(await lastSent("removeAttachment"), {
        type: "removeAttachment",
        id: "auto:/w/my-app/src/app.ts lines 3-9",
      });
      await host({ type: "state", state: baseState() });
      assert.equal(await page.$(chip), null);
      // Narrow panel: the chips wrap and nothing scrolls sideways.
      await page.setViewport({ width: 300, height: 700 });
      await host({ type: "state", state: auto("a-very-long-component-file-name.tsx:120-180", "src/x.tsx") });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      // The / menu switches it.
      await page.click('[data-testid="commands-button"]');
      assert.equal(
        await page.$eval('[data-testid="pref-auto-context"]', (b) => b.getAttribute("aria-checked")),
        "true",
      );
      await page.click('[data-testid="pref-auto-context"]');
      assert.deepEqual(await lastSent("setPref"), { type: "setPref", key: "autoContext", value: false });
    });

    it("the agent changes strip writes a commit message (in a Git repository only)", async () => {
      const changes = {
        agentChanges: {
          status: "ok" as const,
          files: [{ path: "a.txt", additions: 1, deletions: 0, status: "modified" as const }],
        },
      };
      await host({ type: "state", state: baseState(changes) });
      const btn = '[data-testid="write-commit-message"]';
      assert.equal(await text(btn), "Commit message");
      assert.match(
        (await page.$eval(btn, (b) => (b as HTMLElement).dataset.tip)) ?? "",
        /Nothing is committed/,
      );
      await page.click(btn);
      assert.deepEqual(await lastSent("writeCommitMessage"), { type: "writeCommitMessage" });
      const noRepo = baseState(changes);
      noRepo.workspace = { ...noRepo.workspace, repoRoot: null, repoKind: "not-git" };
      await host({ type: "state", state: noRepo });
      assert.equal(await page.$(btn), null);
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

    it("an auth error card offers Re-authenticate <Provider> and Choose another model", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "error",
            id: "error:1",
            title: "GPT-5 (OpenAI) rejected the credentials. Sign in again, or choose another model.",
            detail: "Incorrect API key provided",
            actions: ["reauth", "changeModel", "retry"],
            provider: { id: "openai", name: "OpenAI" },
          },
          {
            kind: "error",
            id: "error:2",
            title: "The request failed.",
            detail: "",
            actions: ["reauth", "changeModel"],
          },
        ],
      });
      const labels = await page.$$eval('[data-testid="error-card"]', (cards) =>
        cards.map((c) => Array.from(c.querySelectorAll("button")).map((b) => b.textContent)),
      );
      assert.deepEqual(labels, [
        ["Re-authenticate OpenAI", "Choose another model", "Retry"],
        ["Choose another model"],
      ]);
      await clearSent();
      await page.click('[data-testid="error-reauth"]');
      assert.deepEqual(await sent(), [{ type: "providerReauth", id: "openai" }]);
      await page.click('[data-testid="error-change-model"]');
      assert.ok(await lastSent("focusModelPicker"));
      // Keyboard: the buttons are reachable with Tab and work with Enter.
      await page.focus('[data-testid="error-reauth"]');
      await clearSent();
      await page.keyboard.press("Enter");
      assert.deepEqual(await sent(), [{ type: "providerReauth", id: "openai" }]);
    });

    const PROVIDERS: ProvidersView = {
      connected: [
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          state: "needs-auth",
          via: "OAuth",
          error: "Your GitHub sign-in expired.",
          models: 0,
          canReauth: true,
          canDisconnect: true,
        },
        {
          id: "anthropic",
          name: "Anthropic",
          state: "error",
          via: "Environment variable ANTHROPIC_API_KEY",
          error:
            "Claude Sonnet (Anthropic) rejected the credentials. Sign in again, or choose another model.",
          models: 12,
          canReauth: true,
          canDisconnect: false,
        },
        {
          id: "ollama",
          name: "Ollama",
          state: "connected",
          via: "OpenCode config",
          error: null,
          models: 1,
          canReauth: false,
          canDisconnect: false,
          local: true,
        },
        {
          id: "openai",
          name: "OpenAI",
          state: "connected",
          via: "API key",
          error: null,
          models: 30,
          canReauth: true,
          canDisconnect: true,
        },
      ],
      available: [
        { id: "google", name: "Google", methods: "API key", popular: true },
        { id: "openrouter", name: "OpenRouter", methods: "API key", popular: true },
        ...Array.from({ length: 60 }, (_, i) => ({ id: `acme-${i}`, name: `Acme ${i}`, methods: "API key" })),
        { id: "zhipuai", name: "Zhipu AI", methods: "API key" },
      ],
      busy: null,
    };
    const rowsOf = (testid: string) =>
      page.$$eval(`[data-testid="providers-panel"] [data-testid="${testid}"]`, (els) =>
        els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      );

    it("the Providers panel opens from the / menu and lists connected providers with their state", async () => {
      await page.click('[data-testid="commands-button"]');
      await clearSent();
      await page.click('[data-testid="providers"]');
      assert.deepEqual(await sent(), [{ type: "loadProviders" }]);
      assert.match(await text('[data-testid="providers-panel"]'), /Loading…/);
      await host({ type: "providers", view: PROVIDERS });
      assert.deepEqual(await rowsOf("provider-row"), [
        "GitHub Copilot Needs sign-in OAuth · 0 models Your GitHub sign-in expired. Sign in again Disconnect",
        "Anthropic Error Environment variable ANTHROPIC_API_KEY · 12 models Claude Sonnet (Anthropic) rejected the credentials. Sign in again, or choose another model. Re-authenticate",
        "Ollama Connected OpenCode config · 1 model · on this machine",
        "OpenAI Connected API key · 30 models Re-authenticate Disconnect",
      ]);
      assert.match(await text('[data-testid="providers-panel"]'), /Sidecar never sees or keeps them/);
      assert.equal(
        await page.$$eval('[data-testid="providers-panel"] input[type="password"]', (e) => e.length),
        0,
      );
      // Without a query, the popular ones; the note says how many there are.
      assert.deepEqual(await rowsOf("provider-choice"), [
        "Google API key Connect",
        "OpenRouter API key Connect",
      ]);
      assert.match(await text('[data-testid="providers-more"]'), /Search all 63/);
      await page.click('[data-testid="providers-close"]');
      assert.equal(await page.$('[data-testid="providers-panel"]'), null);
    });

    it("the Providers panel searches every provider and connects one", async () => {
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="providers"]');
      await host({ type: "providers", view: PROVIDERS });
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid),
        "providers-search",
        "the search has the focus",
      );
      await page.keyboard.type("zhip");
      assert.deepEqual(await rowsOf("provider-choice"), ["Zhipu AI API key Connect"]);
      await clearSent();
      await page.keyboard.press("Enter");
      assert.deepEqual(await sent(), [{ type: "providerConnect", id: "zhipuai" }]);
      // A broad query shows at most 40 and says how many more match.
      await page.click('[data-testid="providers-search"]', { count: 3 });
      await page.keyboard.type("acme");
      assert.equal((await rowsOf("provider-choice")).length, 40);
      assert.match(await text('[data-testid="providers-more"]'), /20 more match/);
      await page.click('[data-testid="providers-search"]', { count: 3 });
      await page.keyboard.type("nothing like it");
      assert.match(await text('[data-testid="providers-more"]'), /No provider matches “nothing like it”/);
      // The list redrawn from the host keeps what was typed.
      await host({ type: "providers", view: PROVIDERS });
      assert.equal(
        await page.$eval('[data-testid="providers-search"]', (i) => (i as HTMLInputElement).value),
        "nothing like it",
      );
      // Escape clears the search first, then closes the panel.
      await page.keyboard.press("Escape");
      assert.equal(
        await page.$eval('[data-testid="providers-search"]', (i) => (i as HTMLInputElement).value),
        "",
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="providers-panel"]'), null);
    });

    it("the Providers panel re-authenticates, disconnects after confirming, reloads and checks setup", async () => {
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="providers"]');
      await host({ type: "providers", view: PROVIDERS });
      await clearSent();
      await page.click('[data-id="openai"] [data-testid="provider-reauth"]');
      assert.deepEqual(await sent(), [{ type: "providerReauth", id: "openai" }]);
      await clearSent();
      await page.click('[data-id="openai"] [data-testid="provider-disconnect"]');
      assert.match(await text('[data-testid="dialog"]'), /Disconnect OpenAI\?/);
      await page.keyboard.press("Escape");
      assert.deepEqual(await sent(), [], "cancelled: nothing sent");
      assert.ok(await page.$('[data-testid="providers-panel"]'), "Escape in the dialog keeps the panel");
      await page.click('[data-id="openai"] [data-testid="provider-disconnect"]');
      await page.click('[data-testid="provider-disconnect-confirm"]');
      assert.deepEqual(await sent(), [{ type: "providerDisconnect", id: "openai" }]);
      await clearSent();
      await page.click('[data-testid="providers-reload"]');
      await page.click('[data-testid="providers-check"]');
      assert.deepEqual(await sent(), [{ type: "reloadProviders" }, { type: "checkSetup" }]);
      // While a sign-in runs, the panel says what it waits for and the actions wait.
      await host({
        type: "providers",
        view: { ...PROVIDERS, busy: { id: "openai", text: "Enter code ABCD-1234" } },
      });
      assert.equal(await text('[data-testid="providers-busy"]'), "Enter code ABCD-1234");
      assert.equal(
        await page.$eval(
          '[data-id="openai"] [data-testid="provider-reauth"]',
          (b) => (b as HTMLButtonElement).disabled,
        ),
        true,
      );
      assert.equal(
        await page.$eval('[data-testid="provider-connect"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      await host({ type: "providers", view: PROVIDERS });
      assert.equal(
        await page.$eval('[data-testid="providers-busy"]', (b) => (b as HTMLElement).hidden),
        true,
      );
      // Focus stays inside the panel with Tab.
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        assert.ok(
          await page.evaluate(() => !!document.activeElement?.closest('[data-testid="providers-panel"]')),
        );
      }
    });

    it("the Providers panel shows why it could not load, and opens from the model menu and the host", async () => {
      await page.click('[data-testid="model-pill"]');
      await clearSent();
      await page.click('[data-testid="manage-providers"]');
      assert.deepEqual(await sent(), [{ type: "loadProviders" }]);
      await host({ type: "providers", view: null, error: "OpenCode could not list them." });
      assert.match(
        await text('[data-testid="providers-panel"]'),
        /Couldn't load them: OpenCode could not list them\./,
      );
      await page.click('[data-testid="providers-close"]');
      await host({ type: "showProviders" });
      assert.ok(await page.$('[data-testid="providers-panel"]'));
      await host({ type: "providers", view: { connected: [], available: [], busy: null } });
      assert.match(await text('[data-testid="providers-panel"]'), /No provider is connected yet/);
    });

    for (const width of [300, 520])
      it(`the Providers panel fits ${width} px without sideways scrolling`, async () => {
        await page.setViewport({ width, height: 700 });
        await host({ type: "showProviders" });
        await host({ type: "providers", view: PROVIDERS });
        const fit = await page.$eval('[data-testid="providers-panel"]', (el) => {
          const r = el.getBoundingClientRect();
          const rows = Array.from(
            el.querySelectorAll<HTMLElement>('[data-testid="provider-row"], [data-testid="provider-choice"]'),
          );
          return {
            inside: r.left >= 0 && r.right <= window.innerWidth,
            scroll: el.scrollWidth <= el.clientWidth + 1,
            rows: rows.every((x) => x.scrollWidth <= x.clientWidth + 1),
            doc: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        assert.deepEqual(fit, { inside: true, scroll: true, rows: true, doc: true });
      });

    // ------------------------------------------------------------- MCP panel

    const MCP: McpServerInfo[] = [
      { name: "github", title: "GitHub", status: "connected" },
      { name: "db", status: "failed", error: "Connection closed: MCP server process exited with code 3" },
      { name: "remo", status: "needs_auth", error: "Unauthorized", integrationID: "mcp_3643" },
      { name: "plain", status: "needs_auth", error: "Unauthorized" },
      { name: "off", status: "disabled" },
      { name: "slow", status: "pending" },
      { name: "tiny", status: "connected", runtime: true },
    ];
    const mcpRows = () =>
      page.$$eval('[data-testid="mcp-panel"] [data-testid="mcp-row"]', (els) =>
        els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      );
    const openMcp = async () => {
      await page.click('[data-testid="commands-button"]');
      await clearSent();
      await page.click('[data-testid="mcp-servers"]');
    };

    it("the MCP panel lists each server's state with the action it allows", async () => {
      await openMcp();
      assert.deepEqual(await sent(), [{ type: "loadMcpServers" }]);
      assert.match(await text('[data-testid="mcp-panel"]'), /Loading…/);
      await host({ type: "mcpServers", items: MCP });
      assert.deepEqual(await mcpRows(), [
        "GitHub Connected github Disconnect",
        "db Failed Connection closed: MCP server process exited with code 3 Retry",
        "remo Needs sign-in Unauthorized Authenticate",
        "plain Needs sign-in Unauthorized Retry",
        "off Disabled Connect",
        "slow Connecting…",
        "tiny Connected added for this OpenCode run Disconnect Remove",
      ]);
      assert.match(await text('[data-testid="mcp-panel"]'), /OpenCode's config is not changed/);
      await clearSent();
      await page.click('[data-name="github"] [data-testid="mcp-disconnect"]');
      await page.click('[data-name="db"] [data-testid="mcp-retry"]');
      await page.click('[data-name="remo"] [data-testid="mcp-auth"]');
      await page.click('[data-name="plain"] [data-testid="mcp-retry"]');
      await page.click('[data-name="off"] [data-testid="mcp-connect"]');
      await page.click('[data-testid="mcp-reload"]');
      assert.deepEqual(await sent(), [
        { type: "mcpDisconnect", name: "github" },
        { type: "mcpConnect", name: "db" },
        { type: "mcpAuth", name: "remo" },
        { type: "mcpConnect", name: "plain" },
        { type: "mcpConnect", name: "off" },
        { type: "reloadMcp" },
      ]);
      await page.click('[data-testid="mcp-close"]');
      assert.equal(await page.$('[data-testid="mcp-panel"]'), null);
    });

    it("the MCP panel removes a server added for this run only after confirming", async () => {
      await openMcp();
      await host({ type: "mcpServers", items: MCP });
      await clearSent();
      await page.click('[data-name="tiny"] [data-testid="mcp-remove"]');
      assert.match(await text('[data-testid="dialog"]'), /Remove tiny\?/);
      await page.keyboard.press("Escape");
      assert.deepEqual(await sent(), [], "cancelled: nothing sent");
      assert.ok(await page.$('[data-testid="mcp-panel"]'), "Escape in the dialog keeps the panel");
      await page.click('[data-name="tiny"] [data-testid="mcp-remove"]');
      await page.click('[data-testid="mcp-remove-confirm"]');
      assert.deepEqual(await sent(), [{ type: "mcpRemove", name: "tiny" }]);
      await page.keyboard.press("Escape");
    });

    it("the MCP panel waits while a change runs, and shows what it waits for on the row", async () => {
      await openMcp();
      await host({
        type: "mcpServers",
        items: MCP,
        busy: { name: "remo", text: "Finish signing in in your browser." },
      });
      assert.equal(await text('[data-testid="mcp-busy"]'), "remo: Finish signing in in your browser.");
      assert.equal(
        await text('[data-name="remo"] [data-testid="mcp-state"]'),
        "Finish signing in in your browser.",
      );
      const disabled = await page.$$eval('[data-testid="mcp-panel"] [data-testid="mcp-row"] button', (bs) =>
        bs.every((b) => (b as HTMLButtonElement).disabled),
      );
      assert.equal(disabled, true);
      for (const id of ["mcp-reload", "mcp-add"])
        assert.equal(
          await page.$eval(`[data-testid="${id}"]`, (b) => (b as HTMLButtonElement).disabled),
          true,
          id,
        );
      await host({ type: "mcpServers", items: MCP, busy: null });
      assert.equal(await page.$eval('[data-testid="mcp-busy"]', (b) => (b as HTMLElement).hidden), true);
      await host({ type: "mcpServers", items: null, error: "OpenCode could not list them." });
      assert.match(
        await text('[data-testid="mcp-note"]'),
        /Couldn't load them: OpenCode could not list them\./,
      );
      await host({ type: "mcpServers", items: [] });
      assert.match(await text('[data-testid="mcp-note"]'), /No MCP servers for this folder/);
      await page.keyboard.press("Escape");
    });

    it("the MCP panel adds a server for this run: checked first, the result kept or cleared", async () => {
      await openMcp();
      await host({ type: "mcpServers", items: MCP });
      await clearSent();
      await page.click('[data-testid="mcp-add-name"]');
      await page.keyboard.type("github");
      await page.click('[data-testid="mcp-add-target"]');
      await page.keyboard.type("npx -y x");
      await page.keyboard.press("Enter");
      assert.match(await text('[data-testid="mcp-add-error"]'), /already exists/);
      await page.click('[data-testid="mcp-add-name"]', { count: 3 });
      await page.keyboard.type("git");
      await page.click('[data-testid="mcp-add-target"]', { count: 3 });
      await page.keyboard.type("ws://host");
      await page.click('[data-testid="mcp-add"]');
      assert.match(await text('[data-testid="mcp-add-error"]'), /must start with http/);
      assert.deepEqual(await sent(), [], "nothing is sent until it checks out");
      await page.click('[data-testid="mcp-add-target"]', { count: 3 });
      await page.keyboard.type('uvx "mcp server git"');
      await page.keyboard.press("Enter");
      assert.deepEqual(await sent(), [{ type: "mcpAdd", name: "git", target: 'uvx "mcp server git"' }]);
      assert.equal(await page.$eval('[data-testid="mcp-add-error"]', (e) => (e as HTMLElement).hidden), true);
      assert.equal(
        await page.$eval('[data-testid="mcp-add"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      // OpenCode refused it: the fields stay for another try.
      await host({ type: "mcpAddResult", ok: false, error: "spawn uvx ENOENT" });
      assert.equal(await text('[data-testid="mcp-add-error"]'), "spawn uvx ENOENT");
      assert.equal(
        await page.$eval('[data-testid="mcp-add-name"]', (i) => (i as HTMLInputElement).value),
        "git",
      );
      // The list redrawn keeps what was typed; a success clears it.
      await host({ type: "mcpServers", items: MCP });
      assert.equal(
        await page.$eval('[data-testid="mcp-add-target"]', (i) => (i as HTMLInputElement).value),
        'uvx "mcp server git"',
      );
      await host({ type: "mcpAddResult", ok: true });
      assert.equal(
        await page.$eval('[data-testid="mcp-add-name"]', (i) => (i as HTMLInputElement).value),
        "",
      );
      assert.equal(
        await page.$eval('[data-testid="mcp-add"]', (b) => (b as HTMLButtonElement).disabled),
        false,
      );
      // Focus stays inside the panel with Tab.
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("Tab");
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="mcp-panel"]')));
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="mcp-panel"]'), null);
    });

    for (const width of [300, 520])
      it(`the MCP panel fits ${width} px without sideways scrolling`, async () => {
        await page.setViewport({ width, height: 700 });
        await openMcp();
        await host({ type: "mcpServers", items: MCP });
        const fit = await page.$eval('[data-testid="mcp-panel"]', (el) => {
          const r = el.getBoundingClientRect();
          const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="mcp-row"], .rule-form'));
          return {
            inside: r.left >= 0 && r.right <= window.innerWidth,
            scroll: el.scrollWidth <= el.clientWidth + 1,
            rows: rows.every((x) => x.scrollWidth <= x.clientWidth + 1),
            doc: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        assert.deepEqual(fit, { inside: true, scroll: true, rows: true, doc: true });
        await page.keyboard.press("Escape");
      });

    // ------------------------------------------------------------- agents

    const DOCS_DRAFT = {
      name: "docs",
      description: "Writes docs",
      mode: "all" as const,
      model: "opencode-go/qwen3.7-plus",
      variant: "high",
      temperature: 0.3,
      permissions: { edit: "deny" as const, webfetch: "allow" as const },
      prompt: "You write docs.",
      scope: "project" as const,
    };
    const AGENTS: AgentsView = {
      agents: [
        {
          id: "docs",
          name: "docs",
          description: "Writes docs",
          mode: "all",
          model: "opencode-go/qwen3.7-plus#high",
          source: "project",
          file: ".opencode/agents/docs.md",
          editable: true,
          problem: null,
          draft: DOCS_DRAFT,
          otherRules: 2,
        },
        {
          id: "old",
          name: "old",
          description: "",
          mode: "primary",
          model: null,
          source: "global",
          file: "C:\\Users\\me\\.config\\opencode\\agent\\old.md",
          editable: true,
          problem: null,
          draft: {
            ...DOCS_DRAFT,
            name: "old",
            description: "",
            mode: "primary",
            model: null,
            variant: null,
            temperature: null,
            permissions: {},
            prompt: "Old.",
            scope: "global",
          },
          legacy: true,
        },
        {
          id: "broken",
          name: "broken",
          description: "",
          mode: "primary",
          model: null,
          source: "project",
          file: ".opencode/agents/broken.md",
          editable: false,
          problem: "OpenCode did not load it: Unclosed flow collection (line 2)",
        },
        {
          id: "build",
          name: "Build",
          description: "The default agent.",
          mode: "primary",
          model: null,
          source: "built-in",
          file: null,
          editable: false,
          problem: null,
        },
      ],
      importable: { count: 3, sources: [".roomodes", "Roo Code (global)"] },
      projectDir: ".opencode/agents",
      globalDir: "C:\\Users\\me\\.config\\opencode\\agents",
      busy: null,
    };
    const PREVIEW: ImportPreview = {
      items: [
        {
          key: "C:\\repo\\.roomodes#docs-writer",
          name: "docs-writer",
          label: "📝 Documentation Writer",
          description: "Use this mode for writing documentation.",
          mode: "all",
          source: ".roomodes",
          conflict: null,
          notes: ["Roo Code's browser became web fetch and search; OpenCode's own browser stays off."],
          checked: true,
        },
        {
          key: "C:\\repo\\.roomodes#orchestrator",
          name: "orchestrator",
          label: "🪃 Orchestrator",
          description: "Coordinates work",
          mode: "primary",
          source: ".roomodes",
          conflict: null,
          notes: [],
          checked: true,
        },
        {
          key: "G#docs",
          name: "docs",
          label: "Docs",
          description: "Docs",
          mode: "all",
          source: "Roo Code (global)",
          conflict: "Replaces .opencode/agents/docs.md",
          notes: [],
          checked: false,
        },
      ],
    };
    const agentRows = () =>
      page.$$eval('[data-testid="agents-panel"] [data-testid="agent-row"]', (els) =>
        els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      );
    const openAgentsPanel = async (view: AgentsView = AGENTS) => {
      await page.click('[data-testid="commands-button"]');
      await clearSent();
      await page.click('[data-testid="agents"]');
      await host({ type: "agents", view });
    };
    const value = (testid: string) =>
      page.$eval(`[data-testid="${testid}"]`, (e) => (e as HTMLInputElement).value);
    const setValue = async (testid: string, v: string) => {
      await page.$eval(
        `[data-testid="${testid}"]`,
        (e, x) => {
          (e as HTMLInputElement).value = x as string;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
        },
        v,
      );
    };

    it("the Agents panel opens from the / menu: custom agents editable, built-in ones read-only", async () => {
      await page.click('[data-testid="commands-button"]');
      await clearSent();
      await page.click('[data-testid="agents"]');
      assert.deepEqual(await sent(), [{ type: "loadAgents" }]);
      assert.match(await text('[data-testid="agents-panel"]'), /Loading…/);
      await host({ type: "agents", view: AGENTS });
      assert.deepEqual(await agentRows(), [
        "docs Primary and subagent This project Writes docs Qwen3.7 Plus (high) · .opencode/agents/docs.md Edit Open file Delete",
        "old Primary Global C:\\Users\\me\\.config\\opencode\\agent\\old.md Edit Open file Delete",
        "broken Primary This project .opencode/agents/broken.md OpenCode did not load it: Unclosed flow collection (line 2) Open file Delete",
        "Build Primary Built-in · read-only The default agent. Built into OpenCode",
      ]);
      assert.match(
        await text('[data-testid="agents-import-banner"]'),
        /Found 3 Roo Code modes in \.roomodes, Roo Code \(global\)\./,
      );
      await clearSent();
      await page.click('[data-id="docs"] [data-testid="agent-open"]');
      assert.deepEqual(await sent(), [{ type: "openAgentFile", id: "docs" }]);
      await page.click('[data-testid="agents-close"]');
      assert.equal(await page.$('[data-testid="agents-panel"]'), null);
    });

    it("the agent switcher's Manage agents… and the host open the Agents panel", async () => {
      await page.click('[data-testid="mode-button"]');
      await clearSent();
      await page.click('[data-testid="manage-agents"]');
      assert.deepEqual(await sent(), [{ type: "loadAgents" }]);
      await host({ type: "agents", view: null, error: "OpenCode could not list them." });
      assert.match(
        await text('[data-testid="agents-panel"]'),
        /Couldn't load them: OpenCode could not list them\./,
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="agents-panel"]'), null);
      await clearSent();
      await host({ type: "showAgents", import: true });
      assert.deepEqual(await sent(), [{ type: "loadAgents" }, { type: "previewImport" }]);
      assert.match(await text('[data-testid="agents-panel"] h2'), /Import Roo Code modes/);
    });

    it("New agent checks the name and temperature, then sends the form's fields", async () => {
      await openAgentsPanel();
      await page.click('[data-testid="agents-new"]');
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid),
        "agent-name",
      );
      await clearSent();
      await page.click('[data-testid="agent-save"]');
      assert.match(await text('[data-testid="agent-error"]'), /Give the agent a name/);
      for (const [bad, why] of [
        ["has space", /letters, digits/],
        ["Build", /exists/],
        ["con", /Windows/],
      ] as const) {
        await setValue("agent-name", bad);
        await page.click('[data-testid="agent-save"]');
        assert.match(await text('[data-testid="agent-error"]'), why, bad);
      }
      assert.deepEqual(await sent(), [], "nothing is sent while the form has a problem");
      await setValue("agent-name", "reviewer");
      await setValue("agent-description", "Reviews changes");
      await setValue("agent-mode-select", "subagent");
      // The model list is the catalog, by provider; a model with variants offers them.
      const groups = await page.$$eval('[data-testid="agent-model"] optgroup', (g) =>
        g.map((x) => (x as HTMLOptGroupElement).label),
      );
      assert.deepEqual(groups, ["OpenCode Go", "Personal / OpenCode"]);
      assert.equal(
        await page.$eval('[data-testid="agent-variant"]', (e) => (e.closest("label") as HTMLElement).hidden),
        true,
      );
      await setValue("agent-model", "opencode-go/qwen3.7-plus");
      assert.equal(
        await page.$eval('[data-testid="agent-variant"]', (e) => (e.closest("label") as HTMLElement).hidden),
        false,
      );
      await setValue("agent-variant", "max");
      await setValue("agent-temperature", "3");
      await page.click('[data-testid="agent-save"]');
      assert.match(await text('[data-testid="agent-error"]'), /0 to 2/);
      await setValue("agent-temperature", "0.5");
      await setValue("agent-perm-edit", "deny");
      await setValue("agent-perm-shell", "ask");
      await setValue("agent-prompt", "Review the diff.\nBe brief.");
      await setValue("agent-scope", "global");
      await page.click('[data-testid="agent-save"]');
      assert.deepEqual(await sent(), [
        {
          type: "saveAgent",
          draft: {
            name: "reviewer",
            description: "Reviews changes",
            mode: "subagent",
            model: "opencode-go/qwen3.7-plus",
            variant: "max",
            temperature: 0.5,
            permissions: { edit: "deny", shell: "ask" },
            prompt: "Review the diff.\nBe brief.",
            scope: "global",
          },
          editing: null,
        },
      ]);
      assert.equal(
        await page.$eval('[data-testid="agent-save"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      // The host refused (it asked about writing outside the folder): the form stays.
      await host({ type: "agentResult", ok: false, error: "Not saved." });
      assert.equal(await text('[data-testid="agent-error"]'), "Not saved.");
      assert.equal(await value("agent-name"), "reviewer");
      await clearSent();
      await page.click('[data-testid="agent-open-editor"]');
      assert.equal((await lastSent("saveAgent"))?.open, true);
      await host({ type: "agentResult", ok: true, id: "reviewer" });
      assert.ok(await page.$('[data-testid="agents-list"]'), "saved: back to the list");
    });

    it("Edit fills the form from the file, keeps the name and says what saving keeps or converts", async () => {
      await openAgentsPanel();
      await page.click('[data-id="docs"] [data-testid="agent-edit"]');
      assert.match(await text('[data-testid="agents-panel"] h2'), /Edit docs/);
      assert.equal(
        await page.$eval('[data-testid="agent-name"]', (e) => (e as HTMLInputElement).disabled),
        true,
      );
      assert.deepEqual(
        await Promise.all(
          [
            "agent-name",
            "agent-description",
            "agent-mode-select",
            "agent-model",
            "agent-variant",
            "agent-temperature",
            "agent-perm-edit",
            "agent-perm-webfetch",
            "agent-perm-shell",
            "agent-prompt",
          ].map(value),
        ),
        [
          "docs",
          "Writes docs",
          "all",
          "opencode-go/qwen3.7-plus",
          "high",
          "0.3",
          "deny",
          "allow",
          "",
          "You write docs.",
        ],
      );
      assert.match(await text('[data-testid="agent-other-rules"]'), /2 more rules in the file are kept/);
      assert.equal(await page.$('[data-testid="agent-scope"]'), null, "an existing file stays where it is");
      await clearSent();
      await setValue("agent-perm-edit", "");
      await page.click('[data-testid="agent-save"]');
      const s = await lastSent("saveAgent");
      assert.equal(s?.editing, "docs");
      assert.deepEqual((s?.draft as { permissions: unknown }).permissions, { webfetch: "allow" });
      await host({ type: "agentResult", ok: true, id: "docs" });
      // OpenCode 1 files say that a permission change rewrites them.
      await page.click('[data-id="old"] [data-testid="agent-edit"]');
      assert.match(
        await text('[data-testid="agent-legacy"]'),
        /OpenCode 1's tools, permission and temperature/,
      );
      await page.keyboard.press("Escape");
      assert.ok(await page.$('[data-testid="agents-list"]'), "Escape goes back to the list");
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[data-testid="agents-panel"]'), null);
    });

    it("Delete asks first and sends nothing when cancelled", async () => {
      await openAgentsPanel();
      await clearSent();
      await page.click('[data-id="docs"] [data-testid="agent-delete"]');
      assert.match(await text('[data-testid="dialog"]'), /Delete docs\?.*\.opencode\/agents\/docs\.md/s);
      await page.keyboard.press("Escape");
      assert.deepEqual(await sent(), []);
      assert.ok(await page.$('[data-testid="agents-panel"]'));
      await page.click('[data-id="docs"] [data-testid="agent-delete"]');
      await page.click('[data-testid="agent-delete-confirm"]');
      assert.deepEqual(await sent(), [{ type: "deleteAgent", id: "docs" }]);
      // While the host works, the panel says so and the actions wait.
      await host({ type: "agents", view: { ...AGENTS, busy: "Deleting…" } });
      assert.equal(await text('[data-testid="agents-busy"]'), "Deleting…");
      assert.equal(
        await page.$eval(
          '[data-id="docs"] [data-testid="agent-edit"]',
          (b) => (b as HTMLButtonElement).disabled,
        ),
        true,
      );
      assert.equal(
        await page.$eval('[data-testid="agents-new"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
    });

    it("the import preview lists each mode with its notes, leaves conflicts unchecked and imports the checked ones", async () => {
      await openAgentsPanel();
      await clearSent();
      await page.click('[data-testid="agents-import-open"]');
      assert.deepEqual(await sent(), [{ type: "previewImport" }]);
      assert.match(await text('[data-testid="import-note"]'), /Looking for/);
      await host({ type: "agentImport", preview: PREVIEW });
      const rows = await page.$$eval('[data-testid="import-row"]', (els) =>
        els.map((e) => [
          (e.querySelector("input") as HTMLInputElement).checked,
          (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        ]),
      );
      assert.deepEqual(rows, [
        [
          true,
          "docs-writer Primary and subagent 📝 Documentation Writer · .roomodes Use this mode for writing documentation. Roo Code's browser became web fetch and search; OpenCode's own browser stays off.",
        ],
        [true, "orchestrator Primary 🪃 Orchestrator · .roomodes Coordinates work"],
        [false, "docs Primary and subagent Docs · Roo Code (global) Docs Replaces .opencode/agents/docs.md"],
      ]);
      assert.equal(await text('[data-testid="import-run"]'), "Import 2 modes");
      await page.click('[data-id="C:\\\\repo\\\\.roomodes#orchestrator"] input');
      assert.equal(await text('[data-testid="import-run"]'), "Import 1 mode");
      await setValue("import-scope", "global");
      await clearSent();
      await page.click('[data-testid="import-run"]');
      assert.deepEqual(await sent(), [
        { type: "importModes", keys: ["C:\\repo\\.roomodes#docs-writer"], scope: "global" },
      ]);
      await host({ type: "agentResult", ok: false, error: "Not imported." });
      assert.equal(await text('[data-testid="import-error"]'), "Not imported.");
      await host({ type: "agentResult", ok: true });
      assert.ok(await page.$('[data-testid="agents-list"]'));
      // Nothing to import: the reason, and no Import button.
      await page.click('[data-testid="agents-import"]');
      await host({ type: "agentImport", preview: null, error: "No Roo Code or Kilo Code modes found." });
      assert.match(await text('[data-testid="import-note"]'), /No Roo Code or Kilo Code modes found/);
      assert.equal(await page.$('[data-testid="import-run"]'), null);
      await page.click('[data-testid="import-back"]');
      assert.ok(await page.$('[data-testid="agents-list"]'));
    });

    it("focus stays inside the Agents panel with Tab, in the list and the form", async () => {
      await openAgentsPanel();
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("Tab");
        assert.ok(
          await page.evaluate(() => !!document.activeElement?.closest('[data-testid="agents-panel"]')),
        );
      }
      await page.click('[data-testid="agents-new"]');
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        assert.ok(
          await page.evaluate(() => !!document.activeElement?.closest('[data-testid="agents-panel"]')),
        );
      }
    });

    for (const width of [300, 520])
      it(`the Agents panel, its form and the import preview fit ${width} px`, async () => {
        await page.setViewport({ width, height: 700 });
        const fits = () =>
          page.$eval('[data-testid="agents-panel"]', (el) => {
            const r = el.getBoundingClientRect();
            const rows = Array.from(
              el.querySelectorAll<HTMLElement>("li, label, fieldset, select, textarea"),
            );
            return {
              inside: r.left >= 0 && r.right <= window.innerWidth,
              scroll: el.scrollWidth <= el.clientWidth + 1,
              rows: rows.every((x) => x.getBoundingClientRect().right <= r.right + 1),
              doc: document.documentElement.scrollWidth <= window.innerWidth,
            };
          });
        const ok = { inside: true, scroll: true, rows: true, doc: true };
        await host({ type: "showAgents" });
        await host({ type: "agents", view: AGENTS });
        assert.deepEqual(await fits(), ok, "list");
        await page.click('[data-id="docs"] [data-testid="agent-edit"]');
        assert.deepEqual(await fits(), ok, "form");
        await page.keyboard.press("Escape");
        await page.click('[data-testid="agents-import"]');
        await host({ type: "agentImport", preview: PREVIEW });
        assert.deepEqual(await fits(), ok, "import");
      });

    it("the / menu runs the setup check", async () => {
      await page.click('[data-testid="commands-button"]');
      await clearSent();
      await page.click('[data-testid="check-setup"]');
      assert.deepEqual(await sent(), [{ type: "checkSetup" }]);
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

    for (const width of [300, 400, 900]) {
      it(`keeps the find bar, code block actions, branch, Jump and box in view at ${width}px`, async () => {
        await page.setViewport({ width, height: 700 });
        const long = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n");
        await host({
          type: "transcript",
          items: [
            prompt("u1", "a prompt"),
            {
              kind: "assistant",
              id: "text:code",
              text: "```typescript\nconst aVeryLongIdentifierName = computeSomethingLong(1, 2, 3);\n```",
              streaming: false,
            },
            { kind: "assistant", id: "text:long", text: long, streaming: false },
          ],
        });
        await page.focus("textarea");
        await page.keyboard.down("Control");
        await page.keyboard.press("f");
        await page.keyboard.up("Control");
        await page.keyboard.type("line");
        await page.$eval(".conversation", (c) => c.scrollTo({ top: 0 }));
        await new Promise((r) => setTimeout(r, 60));
        const m = await page.evaluate(() => {
          const r = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el || (el as HTMLElement).hidden) return null;
            const b = el.getBoundingClientRect();
            return { left: b.left, right: b.right, width: b.width };
          };
          const bar = r('[data-id="text:code"] .codeblock-bar')!;
          const btns = ["insert-code", "open-code", "copy-code"].map((t) =>
            r(`[data-id="text:code"] [data-testid="${t}"]`)!,
          );
          const branch = document.querySelector<HTMLElement>('[data-testid="branch"]');
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            find: r('[data-testid="findbar"]')!,
            jump: r('[data-testid="jump-latest"]'),
            buttonsInBar: btns.every((b) => b.left >= bar.left - 0.5 && b.right <= bar.right + 0.5),
            buttonsApart: btns.every((b, i) => i === 0 || b.left >= btns[i - 1].right - 0.5),
            branchShown: !!branch && getComputedStyle(branch).display !== "none",
            box: r(".box")!.width,
          };
        });
        assert.ok(m.overflow <= 0, `horizontal overflow ${m.overflow}px`);
        assert.ok(
          m.find.left >= 0 && m.find.right <= width,
          `find bar in view (${m.find.left}–${m.find.right})`,
        );
        assert.ok(m.jump && m.jump.left >= 0 && m.jump.right <= width, "Jump to latest in view");
        assert.ok(m.buttonsInBar && m.buttonsApart, "Insert, Open and Copy fit the bar without overlapping");
        assert.equal(m.branchShown, width > 340, "the branch gives way in a narrow panel");
        if (width >= 900) assert.ok(Math.abs(m.box - 670) < 1, `box capped at 670px (${m.box})`);
        else assert.ok(m.box > width - 60, `box fills a narrow panel (${m.box})`);
      });
    }

    it("deletes an archived session from History's Archived view after a confirmation", async () => {
      await host({
        type: "state",
        state: baseState({
          archivedSessions: [
            {
              id: "ses_old",
              title: "Old work",
              created: 1,
              updated: 2,
              agent: "build",
              modelKey: null,
              outcome: null,
              variant: null,
              cost: 0,
              archived: true,
            },
          ],
        }),
      });
      await page.click('[data-testid="history-button"]');
      await page.click('[data-testid="history-archived"]');
      await page.click('[data-testid="session-delete"]');
      assert.match(await text('[data-testid="dialog"]'), /Old work/);
      await page.click('[data-testid="delete-confirm"]');
      assert.deepEqual(await lastSent("deleteSession"), { type: "deleteSession", id: "ses_old" });
    });

    it("opens find with Cmd+F too (macOS)", async () => {
      await page.focus("textarea");
      await page.keyboard.down("Meta");
      await page.keyboard.press("f");
      await page.keyboard.up("Meta");
      assert.equal(await page.$eval('[data-testid="findbar"]', (b) => (b as HTMLElement).hidden), false);
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
      await host({ type: "state", state: baseState({ busy: true }) });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await page.$('[data-testid="status-word"] .cur'), null, "no stepping cursor");
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
      assert.deepEqual(
        await sent(),
        [{ type: "rewindPreview", messageID: "msg_9" }],
        "only the preview is asked for before the dialog is answered",
      );
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
      assert.equal(await lastSent("rewind"), undefined, "Escape cancels");
      await clearSent();
      await page.click('[data-testid="rewind"]');
      await page.click('[data-testid="rewind-code"]');
      assert.deepEqual(await sent(), [
        { type: "rewindPreview", messageID: "msg_9" },
        { type: "rewind", messageID: "msg_9", files: true },
      ]);
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(
        await page.$eval('[data-testid="rewind"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      assert.equal(await page.$eval(".bubble", (b) => b.className), "bubble", "clicking ↺ does not open it");
    });

    it("the rewind dialog lists the files that revert and warns about shell commands", async () => {
      await host({ type: "transcript", items: [prompt("msg_9", "hello")] });
      await page.setViewport({ width: 300, height: 700 });
      await page.hover(".bubble");
      await page.click('[data-testid="rewind"]');
      assert.match(await text('[data-testid="rewind-preview"]'), /Checking which files would revert/);
      // An answer for another prompt is ignored.
      await host({ type: "rewindPreview", messageID: "msg_other", preview: null });
      assert.match(await text('[data-testid="rewind-preview"]'), /Checking/);
      const files = Array.from({ length: 8 }, (_, i) => ({
        path: `src/file-with-a-long-name-${i}.ts`,
        status: i === 0 ? ("added" as const) : ("modified" as const),
      }));
      await host({
        type: "rewindPreview",
        messageID: "msg_9",
        preview: { files, agentShell: 2, userShell: 1, shellFiles: ["dist/out.js"], kept: ["notes.md"] },
      });
      assert.match(await text('[data-testid="rewind-preview"]'), /With code, 8 files revert:/);
      assert.deepEqual(
        await page.$$eval('[data-testid="rewind-files"] li', (li) =>
          li.map((l) => (l as HTMLElement).innerText.replace(/\s+/g, " ")),
        ),
        [
          "src/file-with-a-long-name-0.ts new",
          ...Array.from({ length: 5 }, (_, i) => `src/file-with-a-long-name-${i + 1}.ts`),
          "and 2 more",
        ],
      );
      const warn = await text('[data-testid="rewind-shell-warning"]');
      assert.match(warn, /The agent ran 2 shell commands since/);
      assert.match(warn, /outside the folder or in ignored files stay/);
      assert.match(warn, /Changed by a command, not an edit: dist\/out\.js\./);
      assert.match(warn, /1 command you ran with ! is not in OpenCode's snapshots/);
      assert.match(warn, /Changed since, but not by the agent's steps, so it stays: notes\.md\./);
      assert.equal(
        await page.evaluate(() => {
          const d = document.querySelector('[data-testid="dialog"]')!.getBoundingClientRect();
          return (
            d.left >= 0 &&
            d.right <= window.innerWidth &&
            document.documentElement.scrollWidth <= window.innerWidth
          );
        }),
        true,
        "fits at 300 px",
      );
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid),
        "rewind-chat",
        "the safer choice keeps focus",
      );
      await page.keyboard.press("Escape");
      // Nothing recorded, and no shell command: plain sentences, no warning.
      await page.click('[data-testid="rewind"]');
      await host({
        type: "rewindPreview",
        messageID: "msg_9",
        preview: { files: [], agentShell: 0, userShell: 0, shellFiles: [], kept: [] },
      });
      assert.match(await text('[data-testid="rewind-preview"]'), /OpenCode recorded no file changes/);
      assert.equal(await page.$('[data-testid="rewind-shell-warning"]'), null);
      await page.keyboard.press("Escape");
      await page.click('[data-testid="rewind"]');
      await host({ type: "rewindPreview", messageID: "msg_9", preview: null });
      assert.match(await text('[data-testid="rewind-preview"]'), /could not tell which files would revert/);
      await page.keyboard.press("Escape");
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

    it("/ at the start of the message lists OpenCode's commands and inserts the pick (#1)", async () => {
      await page.click("textarea");
      await clearSent();
      await page.keyboard.type("/");
      assert.deepEqual(await lastSent("refreshCommands"), { type: "refreshCommands" });
      const rows = () =>
        page.$$eval('[data-testid="mention-option"]', (o) => o.map((x) => (x as HTMLElement).innerText));
      assert.equal(await page.$eval('[data-testid="mention-menu"]', (l) => (l as HTMLElement).hidden), false);
      assert.deepEqual(await rows(), [
        "/init\ncreate AGENTS.md",
        "/review\nreview changes",
        "/compact\nSummarize the conversation to free context",
        "/btw\nAsk a side question without adding it to this session",
      ]);
      await page.keyboard.type("rev");
      assert.deepEqual(await rows(), ["/review\nreview changes"]);
      // Commands that arrive while the list is open show up in it.
      await host({
        type: "state",
        state: baseState({ commands: [...baseState().commands, { name: "revert-all", description: null }] }),
      });
      assert.deepEqual(await rows(), ["/review\nreview changes", "/revert-all"]);
      await page.keyboard.press("Tab");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "/review ");
      assert.equal(await page.$eval('[data-testid="mention-menu"]', (l) => (l as HTMLElement).hidden), true);
      await page.keyboard.type("auth");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("runCommand"), { type: "runCommand", name: "review", text: "auth" });
      // Mid-message, a slash is just text.
      await page.keyboard.type("see a/b");
      assert.equal(await page.$eval('[data-testid="mention-menu"]', (l) => (l as HTMLElement).hidden), true);
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
          sessions: [
            sess("ses_1", "Token refresh"),
            { ...sess("ses_2", "Fork"), forked: true },
            { ...sess("ses_3", "Busy one"), running: true },
          ],
        }),
      });
      await page.click('[data-testid="history-button"]');
      assert.equal(await page.$$eval(".fork-mark", (m) => m.length), 1, "forks are marked");
      assert.deepEqual(
        await page.$$eval('[data-testid="session-running"]', (m) =>
          m.map((x) => x.closest(".session-item")!.querySelector(".session-item-title")!.textContent),
        ),
        ["Busy one"],
        "sessions OpenCode is working in show a spinner",
      );
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

    it("hints that a diff opens in the diff editor, and puts old beside new when the panel is wide", async () => {
      await host({ type: "transcript", items: TOOLS });
      const box = '[data-id="tool:edit"] [data-testid="tool-diff"]';
      assert.equal(await text(`${box} .diff-hint`), "Click to open in the diff editor");
      const hintOpacity = () => page.$eval(`${box} .diff-hint`, (e) => getComputedStyle(e).opacity);
      assert.equal(await hintOpacity(), "0", "hidden until hovered");
      await page.hover(box);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await hintOpacity(), "1");

      const shown = (sel: string) =>
        page.$eval(`${box} ${sel}`, (e) => getComputedStyle(e).display !== "none");
      assert.deepEqual(
        [await shown(".diff-lines"), await shown(".diff-split")],
        [true, false],
        "narrow: stacked",
      );
      await page.setViewport({ width: 900, height: 900 });
      assert.deepEqual(
        [await shown(".diff-lines"), await shown(".diff-split")],
        [false, true],
        "wide: side by side",
      );
      assert.deepEqual(
        await page.$$eval(`${box} .ds-row`, (rows) =>
          rows.map((r) =>
            [...r.querySelectorAll(".ds-cell")].map(
              (c) => `${c.className.replace("ds-cell ds-", "")}:${c.textContent}`,
            ),
          ),
        ),
        [
          ["ctx:keep", "ctx:keep"],
          ["del:old", "add:new one"],
          ["empty:", "add:new two"],
        ],
      );
      await page.setViewport({ width: 360, height: 900 });
    });

    it("resizes the old and new columns with a draggable divider that never opens the diff", async () => {
      await page.setViewport({ width: 900, height: 900 });
      await host({ type: "transcript", items: TOOLS });
      const box = '[data-id="tool:edit"] [data-testid="tool-diff"]';
      const handle = `${box} [data-testid="diff-divider"]`;
      const leftWidth = () => page.$eval(`${box} .ds-row .ds-cell`, (c) => c.getBoundingClientRect().width);
      const before = await leftWidth();
      const h0 = (await (await page.$(handle))!.boundingBox())!;
      await clearSent();
      await page.mouse.move(h0.x + h0.width / 2, h0.y + 10);
      await page.mouse.down();
      await page.mouse.move(h0.x + h0.width / 2 + 120, h0.y + 10, { steps: 6 });
      await page.mouse.up();
      const after = await leftWidth();
      assert.ok(after > before + 80, `the old column grew (${before} → ${after})`);
      assert.equal(await lastSent("openAgentDiff"), undefined, "dragging does not open the diff");

      // Keyboard: the divider is a focusable separator; arrows move it, Home centres it.
      await page.focus(handle);
      const value = () => page.$eval(handle, (e) => Number(e.getAttribute("aria-valuenow")));
      const v = await value();
      await page.keyboard.press("ArrowLeft");
      assert.ok((await value()) < v, "ArrowLeft narrows the old column");
      await page.keyboard.press("Home");
      assert.equal(await value(), 50);
      assert.equal(await lastSent("openAgentDiff"), undefined, "keys on the divider do not open the diff");
      await page.setViewport({ width: 360, height: 900 });
    });

    it("says what an edit did, not just its net line count", async () => {
      const edit = (id: string, additions: number, deletions: number) =>
        tool(id, "edit", "edit", "completed", {
          path: "/w/my-app/src/math.js",
          files: [{ path: "src/math.js", additions, deletions, status: "modified" }],
        });
      await host({
        type: "transcript",
        items: [edit("tool:e1", 1, 1), edit("tool:e2", 3, 0), edit("tool:e3", 0, 2), edit("tool:e4", 2, 3)],
      });
      assert.deepEqual(
        await page.$$eval('[data-testid="tool"] .tool-sub', (els) => els.map((e) => e.textContent)),
        ["Changed 1 line", "Added 3 lines", "Removed 2 lines", "Added 2, removed 3 lines"],
      );
    });

    it("shows an edit's changed lines inline and opens the diff editor on click or Enter", async () => {
      await host({ type: "transcript", items: TOOLS });
      // What changed, in words; the exact counts are also in its tooltip.
      assert.equal(await text('[data-id="tool:edit"] .tool-sub'), "Added 2, removed 1 line");
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
        { type: "loadProviders" },
      ]);
      assert.ok(await page.$('[data-testid="providers-panel"]'), "another provider: the Providers panel");
      await page.keyboard.press("Escape");
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

    it("onboarding D: no models → exact guidance, Connect a provider / Refresh, docs links", async () => {
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
      await page.click('[data-testid="onb-refresh"]');
      await page.click('[data-link="providers"]');
      await page.click('[data-link="go"]');
      await page.click('[data-testid="onb-provider"]');
      assert.deepEqual(await sent(), [
        { type: "refreshConnection" },
        { type: "openOfficial", link: "providers" },
        { type: "openOfficial", link: "go" },
        { type: "loadProviders" },
      ]);
      assert.ok(await page.$('[data-testid="providers-panel"]'));
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

    it("puts the streaming caret at the end of the text, not on a line of its own", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:s", text: "In JS, 0.1 - 0.2 is", streaming: true }],
      });
      const caret = await page.$eval(
        '[data-id="text:s"] .msg-body > p:last-child',
        (p) => getComputedStyle(p, "::after").content,
      );
      assert.equal(caret, '"▍"');
      assert.equal(
        await page.$eval('[data-id="text:s"] .msg-body', (b) => getComputedStyle(b, "::after").content),
        "none",
      );
    });

    it("runs the timeline rail straight through a subagent's report, which has no dot", async () => {
      await host({
        type: "transcript",
        items: [
          SUBAGENT_TOOL,
          {
            kind: "handback",
            id: "handback:h2",
            childID: "ses_sub",
            agent: "Explore",
            state: "completed",
            description: "Find token callers",
            report: "Found 4 callers.",
          },
          { kind: "assistant", id: "text:after", text: "Done.", streaming: false },
        ],
      });
      const gap = await page.$eval('[data-id="handback:h2"]', (el) => {
        const before = getComputedStyle(el, "::before");
        const after = getComputedStyle(el, "::after");
        return parseFloat(after.top) - (parseFloat(before.top) + parseFloat(before.height));
      });
      assert.ok(gap <= 0.5, `rail gap of ${gap}px around the missing dot`);
    });

    it("puts a reply's time on its own row above the text, with the dot on the first line", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "assistant",
            id: "text:t",
            text: "All baseline tests pass.",
            streaming: false,
            time: 1_700_000_000_000,
          },
        ],
      });
      const g = await page.$eval('[data-id="text:t"]', (item) => {
        const ts = item.querySelector(".ts")!.getBoundingClientRect();
        const p = item.querySelector(".msg-body p")!.getBoundingClientRect();
        const dot = item.querySelector(".dot")!.getBoundingClientRect();
        return {
          tsTop: ts.top,
          pTop: p.top,
          pBottom: p.bottom,
          tsBottom: ts.bottom,
          dotMid: (dot.top + dot.bottom) / 2,
        };
      });
      assert.ok(g.tsBottom <= g.pTop + 1, `time above the text (${JSON.stringify(g)})`);
      assert.ok(
        Math.abs(g.dotMid - (g.pTop + (g.pBottom - g.pTop) / 2)) < 3,
        `dot centred on the first line (${JSON.stringify(g)})`,
      );
    });

    it("leaves no empty dot for a reply part with only whitespace, and keeps the next reply's time", async () => {
      await host({
        type: "transcript",
        items: [
          { kind: "assistant", id: "text:blank", text: " \n\n", streaming: false, time: 1_700_000_000_000 },
          {
            kind: "assistant",
            id: "text:real",
            text: "Fixed both.",
            streaming: false,
            time: 1_700_000_060_000,
          },
        ],
      });
      assert.equal(
        await page.$eval('[data-id="text:blank"]', (e) => getComputedStyle(e).display),
        "none",
        "no rail entry, no dot",
      );
      assert.notEqual(await page.$('[data-id="text:real"] .ts, [data-id="text:real"] time'), null);
    });

    it("shows the agent's todo list as a checklist, not as a file edit", async () => {
      const detail = {
        facts: [],
        command: null,
        cwd: null,
        output: "1/3 completed",
        outputTruncated: false,
        exitCode: null,
        files: [],
        error: null,
        subagent: null,
        todos: [
          { content: "Find the callers", status: "completed" },
          { content: "Share one refresh", status: "in_progress" },
          { content: "Drop the old helper", status: "cancelled" },
        ],
      };
      await host({
        type: "transcript",
        items: [
          {
            kind: "tool",
            id: "tool:td",
            name: "todowrite",
            title: "1/3 completed, 1 in progress, 1 cancelled",
            category: "todo",
            status: "completed",
            detail,
          } as TranscriptItem,
        ],
      });
      assert.equal(await text('[data-id="tool:td"] [data-testid="tool-name"]'), "Todos");
      assert.equal(await page.$('[data-id="tool:td"] .tool-edit'), null);
      assert.deepEqual(
        await page.$$eval('[data-testid="todo-list"] li', (els) =>
          els.map((e) => e.getAttribute("aria-label")),
        ),
        ["Find the callers: done", "Share one refresh: in progress", "Drop the old helper: cancelled"],
      );
    });

    it("links a generated image to the file OpenCode saves", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "tool",
            id: "tool:img",
            name: "generate_image",
            title: "Image",
            category: "media",
            status: "completed",
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
              description: "A red fox in snow",
              path: "/w/my-app/fox.png",
              media: { kind: "image", state: "started" },
            },
          } as TranscriptItem,
        ],
      });
      assert.equal(await text('[data-testid="media-file"]'), "Generating in the background · fox.png");
      await clearSent();
      await page.click('[data-testid="media-path"]');
      assert.deepEqual(await lastSent("openFile"), { type: "openFile", path: "/w/my-app/fox.png" });
    });

    it("shows what OpenCode posts on its own as one line that expands", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "background",
            id: "background:b1",
            source: "shell",
            state: "completed",
            text: "12 passing\n0 failing",
            command: "npm test -- race",
            path: null,
          },
          {
            kind: "background",
            id: "background:g1",
            source: "goal",
            state: null,
            text: "",
            command: null,
            path: null,
          },
        ],
      });
      assert.equal(
        await text('[data-id="background:b1"] [data-testid="background"]'),
        "Background command · npm test -- race · completed: 12 passing",
      );
      await page.click('[data-id="background:b1"] summary');
      assert.equal(await text('[data-id="background:b1"] .bg-text'), "12 passing\n0 failing");
      assert.equal(await text('[data-id="background:g1"] [data-testid="background"]'), "Goal");
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

    // ------------------------------------------------------------ pasted text

    /** Pastes `t` into the message box; true when the box let the browser insert it. */
    const paste = (t: string) =>
      page.evaluate((t) => {
        const box = document.querySelector("textarea")!;
        box.focus();
        const dt = new DataTransfer();
        dt.setData("text/plain", t);
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(ev);
        return !ev.defaultPrevented;
      }, t);
    const boxValue = () => page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value);
    /** 120 lines with CRLF line ends, tabs, trailing spaces and Unicode. */
    const BIG = Array.from({ length: 120 }, (_, i) => `\tline ${i} ✓  `).join("\r\n") + "\r\n";
    const BIG_LF = BIG.replace(/\r\n/g, "\n");

    it("holds a large paste as a chip with its size and sends it exactly where it was pasted", async () => {
      await page.focus("textarea");
      await page.keyboard.type("Why does this fail? ");
      assert.equal(await paste("one line"), true, "a small paste goes into the box");
      assert.equal(await paste(BIG), false);
      await page.keyboard.type(" thanks");
      assert.equal(await boxValue(), "Why does this fail? [Pasted text #1] thanks");
      assert.deepEqual((await text('[data-testid="paste-chip"]')).split("\n"), [
        "Pasted text #1",
        "120 lines · ~393 tokens",
        "×",
      ]);
      // A long single line is a paste too.
      await paste("x".repeat(801));
      assert.equal(await page.$$eval('[data-testid="paste-chip"]', (c) => c.length), 2);
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), {
        type: "send",
        text: "Why does this fail? [Pasted text #1] thanks[Pasted text #2]",
        pastes: [
          { token: "[Pasted text #1]", text: BIG_LF },
          { token: "[Pasted text #2]", text: "x".repeat(801) },
        ],
      });
      assert.equal(await boxValue(), "");
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
    });

    it("opens a paste read-only, puts it back in the box with Edit, and removes it with ×", async () => {
      await paste(BIG);
      await page.click('[data-testid="paste-open"]');
      assert.equal(await page.$eval('[data-testid="paste-view"]', (v) => (v as HTMLElement).hidden), false);
      assert.equal(await page.$eval('[data-testid="paste-view"] pre', (p) => p.textContent), BIG_LF);
      assert.equal(
        await page.$eval('[data-testid="paste-open"]', (b) => b.getAttribute("aria-expanded")),
        "true",
      );
      await page.click('[data-testid="paste-open"]');
      assert.equal(await page.$eval('[data-testid="paste-view"]', (v) => (v as HTMLElement).hidden), true);
      await page.click('[data-testid="paste-edit"]');
      assert.equal(await boxValue(), BIG_LF);
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
      await page.$eval("textarea", (t) => ((t as HTMLTextAreaElement).value = ""));
      await page.type("textarea", "a ");
      await paste(BIG);
      await page.click('[data-testid="paste-remove"]');
      assert.equal(await boxValue(), "a ");
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
      await page.keyboard.type("b");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "a b" });
    });

    it("drops a paste whose token was deleted, and Undo brings it back", async () => {
      await paste(BIG);
      await page.keyboard.down("Shift");
      for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Shift");
      await page.keyboard.press("Backspace");
      assert.equal(await boxValue(), "[Pasted text #");
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
      await page.keyboard.down("Control");
      await page.keyboard.press("z");
      await page.keyboard.up("Control");
      assert.equal(await boxValue(), "[Pasted text #1]");
      assert.ok(await page.$('[data-testid="paste-chip"]'));
    });

    it("keeps chips when the view is reloaded", async () => {
      await page.type("textarea", "see ");
      await paste(BIG);
      await page.reload();
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "ready"),
      );
      await host({ type: "state", state: baseState() });
      assert.equal(await boxValue(), "see [Pasted text #1]");
      assert.ok(await page.$('[data-testid="paste-chip"]'));
      await page.focus("textarea");
      await page.keyboard.press("Enter");
      const m = (await lastSent("send"))!;
      assert.deepEqual(m.pastes, [{ token: "[Pasted text #1]", text: BIG_LF }]);
    });

    it("sends pastes as a steer while the agent works, and a message handed back keeps them", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await page.type("textarea", "also ");
      await paste(BIG);
      await page.keyboard.press("Enter");
      const m = (await lastSent("send"))!;
      assert.equal(m.delivery, "steer");
      assert.deepEqual(m.pastes, [{ token: "[Pasted text #1]", text: BIG_LF }]);
      // The host refused it (a mention it could not check): the box gets it back with its chip.
      await host({ type: "restoreInput", text: "also [Pasted text #1]" });
      assert.equal(await boxValue(), "also [Pasted text #1]");
      assert.ok(await page.$('[data-testid="paste-chip"]'));
      // A pending message put back for editing (its text from OpenCode) gets its chip too.
      await page.$eval("textarea", (t) => ((t as HTMLTextAreaElement).value = ""));
      await page.focus("textarea");
      await page.keyboard.type(" ");
      await page.keyboard.press("Backspace");
      await host({ type: "restoreInput", text: `edit ${BIG_LF.trim()}` });
      // Numbered after the chip the cleared box still keeps for Undo.
      assert.equal(await boxValue(), "edit [Pasted text #2]");
      await page.click('[data-testid="paste-open"]');
      assert.equal(await page.$eval('[data-testid="paste-view"] pre', (p) => p.textContent), BIG_LF);
    });

    it("folds a sent paste into a chip in the prompt and in ↑ history", async () => {
      await page.type("textarea", "check ");
      await paste(BIG);
      await page.keyboard.press("Enter");
      // OpenCode echoes the prompt as sent (the chat trims it).
      await host({ type: "transcript", items: [prompt("u1", `check ${BIG_LF}`.trim())] });
      const chip = '[data-id="user:u1"] [data-testid="prompt-paste"]';
      assert.equal(await text(chip), "Pasted text120 lines · ~392 tokens".replace("text", "text\n"));
      assert.equal(await page.$('[data-id="user:u1"] .paste-text'), null);
      await page.click(chip);
      assert.equal(
        await page.$eval('[data-id="user:u1"] .paste-text', (p) => p.textContent),
        BIG_LF.trimEnd(),
      );
      assert.match(await page.$eval('[data-id="user:u1"] .bubble', (b) => b.className), /open/);
      await page.click(chip);
      assert.equal(await page.$('[data-id="user:u1"] .paste-text'), null);
      // ↑ recalls the prompt with its chip, and sends the paste as it was first sent.
      await page.focus("textarea");
      await page.keyboard.press("ArrowUp");
      assert.equal(await boxValue(), "check [Pasted text #1]");
      assert.ok(await page.$('[data-testid="paste-chip"]'));
      await page.keyboard.press("ArrowDown");
      assert.equal(await boxValue(), "");
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      assert.deepEqual((await lastSent("send"))!.pastes, [{ token: "[Pasted text #1]", text: BIG_LF }]);
    });

    it("puts the text in for commands and shell lines, and leaves image paste alone", async () => {
      await page.type("textarea", "/review ");
      await paste(BIG);
      await page.keyboard.press("Enter");
      // A command takes its arguments trimmed, as when they are typed.
      assert.deepEqual(await lastSent("runCommand"), {
        type: "runCommand",
        name: "review",
        text: BIG_LF.trim(),
      });
      await page.click("textarea");
      await page.evaluate(async () => {
        const c = document.createElement("canvas");
        c.width = 4;
        c.height = 4;
        const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
        dt.setData("text/plain", "x\n".repeat(50));
        document
          .querySelector("textarea")!
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "attachImage"),
      );
      assert.equal(await page.$('[data-testid="paste-chip"]'), null);
    });

    it("fits paste chips and the open paste in a 300px panel", async () => {
      await page.setViewport({ width: 300, height: 700 });
      await paste(BIG);
      await paste("y".repeat(5000));
      await page.click('[data-testid="paste-open"]');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      const view = await page.$eval('[data-testid="paste-view"] pre', (p) => {
        const r = p.getBoundingClientRect();
        return { h: r.height, scroll: p.scrollHeight > p.clientHeight };
      });
      assert.ok(view.h <= 245 && view.scroll, JSON.stringify(view));
    });

    // -------------------------------------------------------------- ask aside

    const asideShown = () => page.$eval('[data-testid="aside"]', (a) => !(a as HTMLElement).hidden);
    const asideTurn = (over: Partial<AsideTurn> = {}): AsideTurn => ({
      question: "What does auth.ts export?",
      answer: "",
      error: null,
      done: false,
      ...over,
    });
    const asideView = (turns: AsideTurn[], over: Partial<AsideView> = {}): AsideView => ({
      status: turns.every((x) => x.done) ? "idle" : "running",
      turns,
      error: null,
      activity: null,
      ...over,
    });

    it("/btw asks aside: the card streams the answer while the main box keeps working", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await page.type("textarea", "/btw What does auth.ts export?");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("askAside"), { type: "askAside", text: "What does auth.ts export?" });
      assert.equal(await lastSent("send"), undefined, "nothing went to the main session");
      assert.equal(await boxValue(), "");
      assert.equal(await asideShown(), true);
      await host({ type: "aside", aside: asideView([asideTurn()], { activity: "Using read…" }) });
      assert.match(await text('[data-testid="aside-body"]'), /What does auth\.ts export\?\s+Using read…/);
      assert.equal(await text('[data-testid="aside-status"]'), "Answering…");
      assert.equal(await page.$eval('[data-testid="aside-to-main"]', (b) => (b as HTMLElement).hidden), true);
      await host({ type: "aside", aside: asideView([asideTurn({ answer: "It exports **login**." })]) });
      assert.equal(
        await page.$eval('[data-testid="aside-body"] .aside-a strong', (b) => b.textContent),
        "login",
      );
      // The main box still steers the running task.
      await page.type("textarea", "keep going");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "keep going", delivery: "steer" });
      // A follow-up waits until the answer is done.
      assert.equal(
        await page.$eval('[data-testid="aside-ask"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      await host({
        type: "aside",
        aside: asideView([asideTurn({ answer: "It exports **login**.", done: true })]),
      });
      assert.equal(await text('[data-testid="aside-status"]'), "Not added to this session");
      await clearSent();
      await page.click('[data-testid="aside-to-main"]');
      assert.deepEqual(await sent(), [{ type: "asideToMain" }]);
      await host({
        type: "aside",
        aside: asideView([asideTurn({ answer: "It exports **login**.", done: true, sent: true })]),
      });
      assert.equal(await text('[data-testid="aside-to-main"]'), "Sent to main");
      assert.equal(
        await page.$eval('[data-testid="aside-to-main"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      await page.click('[data-testid="aside-input"]');
      await page.keyboard.type("And logout?");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("askAside"), { type: "askAside", text: "And logout?" });
      assert.equal(await page.$eval('[data-testid="aside-input"]', (t) => (t as HTMLInputElement).value), "");
      await page.click('[data-testid="aside-close"]');
      assert.ok(await lastSent("closeAside"));
      assert.equal(await asideShown(), false);
    });

    it("/btw alone, or Ask aside in the / palette, opens the card with its field focused", async () => {
      await page.type("textarea", "/bt");
      assert.ok(
        (await page.$$eval('[data-testid="mention-option"]', (o) => o.map((x) => x.textContent))).some((x) =>
          x?.startsWith("/btw"),
        ),
      );
      await page.keyboard.press("Tab");
      assert.equal(await boxValue(), "/btw ");
      await page.keyboard.press("Enter");
      assert.equal(await asideShown(), true);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "aside-input",
      );
      assert.match(await text('[data-testid="aside-body"]'), /runs in a copy/);
      assert.equal(await lastSent("askAside"), undefined);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
      await page.click('[data-testid="aside-close"]');
      assert.equal(await lastSent("closeAside"), undefined, "nothing was asked, so nothing to delete");
      await page.click('[data-testid="commands-button"]');
      await page.click('[data-testid="command-aside"]');
      assert.equal(await asideShown(), true);
      await page.keyboard.type("Is there a test for this?");
      await page.click('[data-testid="aside-ask"]');
      assert.deepEqual(await lastSent("askAside"), { type: "askAside", text: "Is there a test for this?" });
    });

    it("shows why a side question failed, and a card the host closed goes away", async () => {
      await page.type("textarea", "/btw why?");
      await page.keyboard.press("Enter");
      await host({
        type: "aside",
        aside: asideView([asideTurn({ question: "why?", done: true })], {
          error: "Could not start the side thread: boom.",
        }),
      });
      assert.equal(
        await text('[data-testid="aside-body"] [role="alert"]'),
        "Could not start the side thread: boom.",
      );
      await host({
        type: "aside",
        aside: asideView([
          asideTurn({
            question: "why?",
            done: true,
            error: "The model provider reported that a usage quota was reached.",
          }),
        ]),
      });
      assert.match(await text('[data-testid="aside-body"]'), /usage quota/);
      await host({ type: "aside", aside: null });
      assert.equal(await asideShown(), false);
    });

    it("keeps an OpenCode command named btw, and fits the card in a 300px panel", async () => {
      await host({
        type: "state",
        state: baseState({ commands: [{ name: "btw", description: "my own" }] }),
      });
      await page.type("textarea", "/btw hi");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("runCommand"), { type: "runCommand", name: "btw", text: "hi" });
      assert.equal(await asideShown(), false);
      await page.setViewport({ width: 300, height: 700 });
      const long = "A long answer line that keeps going ".repeat(40);
      await host({
        type: "aside",
        aside: asideView([
          asideTurn({ answer: `${long}\n\n\`\`\`ts\n${"const x = 1;".repeat(20)}\n\`\`\``, done: true }),
        ]),
      });
      assert.equal(await asideShown(), true);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      const box = await page.$eval('[data-testid="aside"]', (a) => a.getBoundingClientRect().height);
      assert.ok(box <= 700 * 0.45 + 2, `card ${box}px tall`);
      for (const id of ["aside-input", "aside-ask", "aside-to-main", "aside-close"]) {
        const r = await page.$eval(`[data-testid="${id}"]`, (e) => e.getBoundingClientRect().right);
        assert.ok(r <= 300, `${id} at ${r}px`);
      }
    });

    // ------------------------------------------------------------ session strip

    const STRIP: StripTab[] = [
      { id: "ses_1", title: "Test session", status: "running", current: true },
      { id: "ses_2", title: "Refactor the authentication middleware", status: "waiting", current: false },
      { id: "ses_3", title: "Docs", status: "done", current: false },
      { id: "ses_4", title: "Flaky test", status: "failed", current: false },
      { id: "ses_5", title: "Spike", status: "idle", current: false },
    ];
    const stripShown = () => page.$eval('[data-testid="session-strip"]', (s) => !(s as HTMLElement).hidden);

    it("shows the strip once two sessions are on it, and hides it when turned off", async () => {
      assert.equal(await stripShown(), false, "no strip yet");
      await host({ type: "state", state: baseState({ strip: STRIP.slice(0, 1) }) });
      assert.equal(await stripShown(), false, "one session: no strip");
      await host({ type: "state", state: baseState({ strip: STRIP }) });
      assert.equal(await stripShown(), true);
      // Right under the header, above the conversation.
      const order = await page.evaluate(() => {
        const strip = document.querySelector('[data-testid="session-strip"]')!;
        return [
          strip.previousElementSibling?.tagName,
          !!(strip.compareDocumentPosition(document.querySelector(".conversation")!) & 4),
        ];
      });
      assert.deepEqual(order, ["HEADER", true]);
      await host({
        type: "state",
        state: baseState({
          strip: STRIP,
          prefs: { stickyPrompt: true, cacheWarmMinutes: 5, activity: "detailed", sessionStrip: false },
        }),
      });
      assert.equal(await stripShown(), false);
    });

    it("labels each tab with its status, and only the others can be closed", async () => {
      await host({ type: "state", state: baseState({ strip: STRIP }) });
      const tabs = await page.$$eval('[data-testid="strip-tab"]', (b) =>
        b.map((x) => [
          x.getAttribute("aria-label"),
          x.getAttribute("aria-current"),
          (x as HTMLElement).dataset.status,
          getComputedStyle(x.querySelector(".strip-dot")!).display,
        ]),
      );
      assert.deepEqual(tabs, [
        ["Test session, working (open)", "page", "running", "block"],
        ["Refactor the authentication middleware, waiting for you", null, "waiting", "block"],
        ["Docs, finished", null, "done", "block"],
        ["Flaky test, failed", null, "failed", "block"],
        ["Spike", null, "idle", "none"],
      ]);
      assert.equal(
        await page.$eval('[role="list"][aria-label="Open sessions"]', (l) => l.children.length),
        5,
      );
      const closes = await page.$$eval('[data-testid="strip-close"]', (b) =>
        b.map((x) => x.getAttribute("aria-label")),
      );
      assert.equal(closes.length, 4, "the open session has no ×");
      assert.equal(closes[0], "Remove Refactor the authentication middleware from the strip");
    });

    it("switches on click, takes a tab off with ×, and does nothing for the open one", async () => {
      await host({ type: "state", state: baseState({ strip: STRIP }) });
      await clearSent();
      await page.click('[data-testid="strip-tab"][data-status="running"]');
      assert.equal(await lastSent("selectSession"), undefined, "already open");
      const tab = await page.$$('[data-testid="strip-tab"]');
      await tab[2].click();
      assert.deepEqual(await lastSent("selectSession"), { type: "selectSession", id: "ses_3" });
      await page.hover('.strip-tab[data-id="ses_4"]');
      await page.click('.strip-tab[data-id="ses_4"] [data-testid="strip-close"]');
      assert.deepEqual(await lastSent("closeStripTab"), { type: "closeStripTab", id: "ses_4" });
      await host({ type: "state", state: baseState({ strip: STRIP.filter((t) => t.id !== "ses_4") }) });
      assert.equal(await page.$('.strip-tab[data-id="ses_4"]'), null);
    });

    it("moves between tabs with the arrow keys, Home and End, and Delete takes one off", async () => {
      await host({ type: "state", state: baseState({ strip: STRIP }) });
      await clearSent();
      await page.focus('.strip-tab[data-id="ses_1"] .strip-open');
      const focused = () =>
        page.evaluate(() => document.activeElement?.closest<HTMLElement>(".strip-tab")?.dataset.id);
      await page.keyboard.press("ArrowRight");
      assert.equal(await focused(), "ses_2");
      await page.keyboard.press("End");
      assert.equal(await focused(), "ses_5");
      await page.keyboard.press("ArrowRight");
      assert.equal(await focused(), "ses_5", "stays at the end");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("selectSession"), { type: "selectSession", id: "ses_3" });
      await page.keyboard.press("Delete");
      assert.deepEqual(await lastSent("closeStripTab"), { type: "closeStripTab", id: "ses_3" });
      await host({ type: "state", state: baseState({ strip: STRIP.filter((t) => t.id !== "ses_3") }) });
      assert.equal(await focused(), "ses_4", "the focus moves to the next tab");
      // Tab reaches the strip's tabs, not the × buttons.
      const tabbable = await page.$$eval('[data-testid="strip-close"]', (b) =>
        b.map((x) => x.getAttribute("tabindex")),
      );
      assert.ok(tabbable.every((t) => t === "-1"));
    });

    for (const width of [300, 400, 520]) {
      it(`fits the strip at ${width}px: ellipsized titles, a sideways scroll, no page overflow`, async () => {
        await page.setViewport({ width, height: 700 });
        const many: StripTab[] = [
          ...STRIP,
          { id: "ses_6", title: "Another long session title for overflow", status: "idle", current: false },
        ];
        await host({ type: "state", state: baseState({ strip: many }) });
        const m = await page.evaluate(() => {
          const strip = document.querySelector<HTMLElement>('[data-testid="session-strip"]')!;
          const title = document.querySelector<HTMLElement>('.strip-tab[data-id="ses_2"] .strip-title')!;
          const header = document.querySelector<HTMLElement>(".header")!;
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            scrolls: strip.scrollWidth > strip.clientWidth,
            overflowX: getComputedStyle(strip).overflowX,
            ellipsis:
              title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
            height: strip.getBoundingClientRect().height,
            right: strip.getBoundingClientRect().right,
            headerRight: header.getBoundingClientRect().right,
          };
        });
        assert.ok(m.overflow <= 0, `horizontal overflow ${m.overflow}px`);
        assert.equal(m.overflowX, "auto");
        assert.ok(m.scrolls, "six tabs scroll sideways");
        assert.ok(m.ellipsis, "a long title is cut with …");
        assert.ok(m.height <= 34, `strip ${m.height}px tall`);
        assert.ok(m.right <= width && m.headerRight <= width);
        // The last tab can be scrolled to and clicked.
        await page.$eval('.strip-tab[data-id="ses_6"]', (t) => t.scrollIntoView({ inline: "end" }));
        await clearSent();
        await page.click('.strip-tab[data-id="ses_6"] [data-testid="strip-tab"]');
        assert.deepEqual(await lastSent("selectSession"), { type: "selectSession", id: "ses_6" });
      });
    }

    it("stops the working dot with reduced motion", async () => {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await host({ type: "state", state: baseState({ strip: STRIP }) });
      assert.equal(
        await page.$eval('.strip-tab[data-id="ses_1"] .strip-dot', (d) => getComputedStyle(d).animationName),
        "none",
      );
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      assert.equal(
        await page.$eval('.strip-tab[data-id="ses_1"] .strip-dot', (d) => getComputedStyle(d).animationName),
        "dot-breathe",
      );
    });
  },
);
