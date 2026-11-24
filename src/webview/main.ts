// Sidebar webview. Renders state pushed by the extension host and sends user
// intents back as typed messages. All text is inserted with textContent; no
// innerHTML, no eval.

import type {
  BudgetLevel,
  CheckState,
  OnboardingStage,
  FileChange,
  FileDiff,
  FormAnswer,
  FormField,
  InboxDelivery,
  MentionCandidate,
  PromptMention,
  SubagentView,
  TranscriptItem,
} from "../shared/model";
import type { HostMessage, OfficialLink, ViewState, WebviewMessage } from "../shared/protocol";
import { Transcript } from "../shared/transcript";
import { translate, type StringKey } from "./i18n";
import { grammarFor, highlightBlock, highlightLine } from "./highlight";
import { parseMarkdown, type Block, type Inline } from "./markdown";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

type Attrs = Record<string, string | boolean | number | undefined | ((ev: Event) => void)>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "className") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const nonNull = (nodes: Array<Node | null | undefined | false>): Node[] =>
  nodes.filter((n): n is Node => !!n);

// ------------------------------------------------------------------ state

let state: ViewState | null = null;
const transcript = new Transcript();
const openDetails = new Set<string>();
const itemEls = new Map<string, HTMLElement>();
let sessionsOpen = false;
let changesOpen = false;
let draft = "";
let delivery: InboxDelivery = "steer";
/** `@` suggestions picked while typing this draft; sent with it when their token is still there. */
let mentions: PromptMention[] = [];
/** Copy feedback per button key ("msg:<itemId>" or "code:<itemId>:<n>"). */
const copyFeedback = new Map<string, "copied" | "failed">();
const copyRequests = new Map<string, { key: string; itemId: string }>();
const formErrors = new Map<string, string>();
/** In-progress (unsent) form answers, so re-renders do not lose user input. */
const formDrafts = new Map<string, FormAnswer>();
let requestSeq = 0;
/** The header title is being edited. */
let renaming = false;
/** Text typed in the history popover's search field. */
let sessionQuery = "";
/** The history popover shows archived sessions instead of active ones. */
let historyArchived = false;
/** When the current run started, for the "Working…" timer. */
let busySince: number | null = null;
/** Bookmarks popover open (from the header). */
let bookmarksOpen = false;
/** Subagent conversation shown instead of the main one (drill-in); its own transcript. */
let subView: { id: string; transcript: Transcript } | null = null;
let subagentSignature = "";

const persisted = vscode.getState() as
  { draft?: string; delivery?: InboxDelivery; mentions?: PromptMention[] } | undefined;
if (persisted?.draft) draft = persisted.draft;
if (persisted?.delivery === "queue") delivery = "queue";
if (Array.isArray(persisted?.mentions)) mentions = persisted.mentions;

const t = (key: StringKey) => translate(state?.locale ?? "en", key);

function persist() {
  vscode.setState({ draft, delivery, mentions });
}

// ------------------------------------------------------------------- icons
// 16px line icons drawn with DOM calls (no innerHTML). "F:" marks a filled path.

const ICON_PATHS: Record<string, string[]> = {
  rewind: ["M3 4v3.5h3.5", "M3.4 7.4A5 5 0 1 1 4.5 11.5"],
  bookmark: ["M4.5 2.5h7v11L8 11l-3.5 2.5z"],
  history: ["M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0", "M8 5v3l2 1.3"],
  clock: ["M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0", "M8 5v3l2 1.3"],
  newchat: ["M8 2.3a5.7 5.7 0 0 1 5 8.4l.8 2.8-2.8-.8A5.7 5.7 0 1 1 8 2.3z", "M8 5.6v4.8M5.6 8h4.8"],
  pencil: ["M10.5 2.5l3 3L6 13H3v-3z"],
  plus: ["M8 3v10M3 8h10"],
  copy: [
    "M6.5 5h5A1.5 1.5 0 0 1 13 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 5 11.5v-5A1.5 1.5 0 0 1 6.5 5z",
    "M3 10.5V4a1 1 0 0 1 1-1h6.5",
  ],
  up: ["M8 13V3M4 7l4-4 4 4"],
  stop: ["F:M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
  mode: ["M8 2.5l4.5 2v3.3c0 2.8-1.9 4.9-4.5 5.7-2.6-.8-4.5-2.9-4.5-5.7V4.5z"],
  plan: ["M3 3.5h10M3 8h10M3 12.5h6"],
  chev: ["M4 6l4 4 4-4"],
  close: ["M4 4l8 8M12 4l-8 8"],
  search: ["M11.5 7a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0", "M10.3 10.3L14 14"],
  file: ["M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z", "M9 2.5v3h3"],
  selection: ["M3 4h10M3 8h6M3 12h8", "F:M12 9.5h1.5v4H12z"],
  folder: ["M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"],
  image: [
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5",
    "F:M10.8 5.2a1.1 1.1 0 1 1 0 2.2a1.1 1.1 0 1 1 0-2.2z",
  ],
  agent: ["M8 2.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z", "M3 13.5c.5-2.6 2.5-4 5-4s4.5 1.4 5 4"],
  skill: ["M8.5 2L4 9h3.5L7 14l4.5-7H8z"],
  at: [
    "M10.5 8a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0",
    "M10.5 6v2.8c0 1 .7 1.7 1.6 1.7 1 0 1.6-1 1.6-2.5A5.7 5.7 0 1 0 11 13",
  ],
  fork: [
    "M5 2.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z",
    "M11 2.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z",
    "M5 10.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z",
    "M5 5.5v5M11 5.5v1a2 2 0 0 1-2 2H5",
  ],
  archive: ["M2.5 3.5h11v2.5h-11z", "M3.5 6v6.5h9V6", "M6.5 8.5h3"],
  restore: ["M3 4v3.5h3.5", "M3.4 7.4A5 5 0 1 1 4.5 11.5"],
};

function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `i i-${name}`);
  for (const d of ICON_PATHS[name] ?? []) {
    const p = document.createElementNS(NS, "path");
    const filled = d.startsWith("F:");
    p.setAttribute("d", filled ? d.slice(2) : d);
    if (filled) p.setAttribute("class", "fill");
    svg.append(p);
  }
  return svg;
}

let markCount = 0;

/**
 * Sidecar's mark for the Working line, in the logo's proportions: a ring (the work)
 * centred in the box, and the disc riding alongside it. The disc orbits the ring's
 * centre while the ring stays still; at rest it reads as the logo. The gap the disc
 * cuts in the ring is a mask, not paint, so the mark works on any background. The
 * mask's hole and the disc orbit with the same animation, started together.
 */
function markSpinner(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const id = `sidecar-mark-${++markCount}`;
  const svg = el("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", class: "i i-mark" }) as SVGSVGElement;
  const mask = el("mask", { id, maskUnits: "userSpaceOnUse", x: "0", y: "0", width: "16", height: "16" });
  const hole = el("g", { class: "orbit" });
  hole.append(el("circle", { class: "gap", cx: "13.55", cy: "8", r: "3.35" }));
  mask.append(el("rect", { class: "keep", width: "16", height: "16" }), hole);
  const disc = el("g", { class: "orbit" });
  disc.append(el("circle", { class: "disc", cx: "13.55", cy: "8", r: "2.45" }));
  svg.append(
    el("defs", {}),
    el("circle", { class: "ring", cx: "8", cy: "8", r: "4.4", mask: `url(#${id})` }),
    disc,
  );
  svg.firstChild!.appendChild(mask);
  return svg;
}

// ------------------------------------------------------------------ layout
//
// A slim header (title, history, new session), the conversation, then the
// message box: it floats near the bottom and carries the controls in its footer
// (context, subagents, model, agent mode, send/stop). Requests that need an
// answer take the message box's place until answered.

const app = document.getElementById("app")!;
const headerEl = h("header", { className: "header" });
const bannerEl = h("div", { className: "banners" });
const bookmarksEl = h("section", {
  className: "bookmarks popover",
  "aria-label": "Bookmarks",
  "data-testid": "bookmarks",
  hidden: true,
});
const sessionsEl = h("section", {
  className: "sessions popover",
  "aria-label": "Session history",
  "data-testid": "history",
  hidden: true,
});
const statusLive = h("div", { className: "sr-only", "aria-live": "polite", role: "status" });
const scroller = h("main", { className: "conversation", "aria-label": "Conversation", tabindex: "-1" });
const emptyEl = h("div", { className: "empty" });
const listEl = h("div", {
  className: "items",
  role: "log",
  "aria-live": "polite",
  "aria-relevant": "additions",
});
/** "Working…" with the elapsed time, under the timeline while the agent runs. */
const workingEl = h("div", { className: "working", "data-testid": "working", hidden: true });
scroller.append(emptyEl, listEl, workingEl);
const subHeaderEl = h("section", { className: "subagent-header", "aria-label": "Subagent", hidden: true });
const changesEl = h("section", { className: "changes", "aria-label": "Changed files" });
const pendingEl = h("section", { className: "pending", "aria-label": "Pending messages" });
/** A rewind staged in another OpenCode client: Restore or Apply. */
const revertEl = h("section", {
  className: "revert-bar",
  "aria-label": "Rewind from another client",
  "data-testid": "revert-bar",
  hidden: true,
});
const composerEl = h("footer", { className: "composer" });
/** The message box and its status lines float over the bottom of the conversation. */
/** Status lines (a staged rewind, changes, pending messages) sit on the box's top edge. */
const stripsEl = h("div", { className: "strips" }, revertEl, changesEl, pendingEl);
const bottomEl = h("div", { className: "bottom" }, stripsEl, composerEl);
app.append(headerEl, bannerEl, bookmarksEl, sessionsEl, subHeaderEl, scroller, bottomEl, statusLive);
// The conversation scrolls under the floating box; its last line stays reachable above it.
// The box keeps clear of the chat's scrollbar, whatever width the theme gives it.
const fitBottom = new ResizeObserver(() => {
  scroller.style.setProperty("--bottom-space", `${bottomEl.offsetHeight}px`);
  bottomEl.style.setProperty("--scrollbar", `${scroller.offsetWidth - scroller.clientWidth}px`);
  maybeScroll();
});
fitBottom.observe(bottomEl);
fitBottom.observe(scroller);

/** Transcript shown in the conversation area: the open subagent's, or the main one. */
const shown = (): Transcript => subView?.transcript ?? transcript;

// The message box is built once so focus and caret survive state updates.
const chipsEl = h("div", { className: "chips", "aria-label": "Attached context" });
const input = h("textarea", {
  className: "input",
  rows: 2,
  dir: "auto",
  placeholder: "Ask anything…",
  "aria-label": "Message OpenCode",
}) as HTMLTextAreaElement;
input.value = draft;

const toolBtn = (cls: string, label: string, testid: string, ...children: Array<Node | string>) =>
  h(
    "button",
    {
      className: cls,
      "data-tip": label,
      "aria-label": label,
      "aria-haspopup": "menu",
      "data-testid": testid,
    },
    ...children,
  );
const plusBtn = toolBtn("ico", "Add context", "add-context", icon("plus"));
const slashBtn = toolBtn("ico", "Commands", "commands-button", h("span", { className: "sqico" }, "/"));
const clockBtn = toolBtn("pill clean", "Prompt cache and usage", "cache-pill");
const agentsBtn = toolBtn("pill", "Subagents", "agents-pill");
const modelBtn = toolBtn("pill model", "Model", "model-pill");
const modeBtn = toolBtn("mode", "Agent", "mode-button");
const sendBtn = h("button", { className: "sq", "data-testid": "send" });
sendBtn.addEventListener("click", () => {
  if (sendBtn.dataset.testid === "stop") stop();
  else submit();
});
const boxTools = h(
  "div",
  { className: "box-tools" },
  plusBtn,
  slashBtn,
  clockBtn,
  agentsBtn,
  modelBtn,
  h("span", { className: "grow" }),
  modeBtn,
  sendBtn,
);
const boxEl = h("div", { className: "box" }, chipsEl, input, boxTools);
/** Permission and question docks replace the message box while a request waits. */
const dockEl = h("div", { className: "dock-slot", hidden: true });
composerEl.append(boxEl, dockEl);

plusBtn.addEventListener("click", () =>
  openMenu(
    plusBtn,
    [
      item("Attach current file", () => send({ type: "addCurrentFile" }), {
        icon: "file",
        testid: "menu-current-file",
      }),
      item("Attach selection", () => send({ type: "addSelection" }), {
        icon: "selection",
        testid: "menu-selection",
      }),
      item("Search workspace files…", () => send({ type: "searchFiles" }), {
        icon: "search",
        testid: "menu-pick-file",
      }),
      item("Attach image…", () => send({ type: "pickImage" }), {
        icon: "image",
        detail: "or paste",
        testid: "menu-image",
      }),
      item("Mention a file, agent or skill", () => startMention(), {
        icon: "at",
        detail: "@",
        testid: "menu-mention",
      }),
    ],
    { width: 260 },
  ),
);
agentsBtn.addEventListener("click", () =>
  openMenu(agentsBtn, agentsMenu(), { width: "box", title: t("subagents"), maxHeight: 320 }),
);
const commandsMenuOptions = (): MenuOptions => ({ width: "box", filter: "Filter actions…", maxHeight: 340 });
slashBtn.addEventListener("click", () => {
  if (openMenuState?.anchor !== slashBtn) send({ type: "refreshCommands" });
  openMenu(slashBtn, commandsMenu(), commandsMenuOptions());
});
clockBtn.addEventListener("click", () =>
  openMenu(clockBtn, usageMenu(), { width: "box", title: "Context and usage" }),
);
modelBtn.addEventListener("click", () => openMenu(modelBtn, modelMenu(), modelMenuOptions()));
modeBtn.addEventListener("click", () =>
  openMenu(modeBtn, modeMenu(), {
    width: 360,
    align: "end",
    title: "Agent",
    keys: ["⇧", "Tab"],
    keysText: "to switch",
  }),
);

input.addEventListener("keydown", (e) => {
  if (mentionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && state?.busy) {
    e.preventDefault();
    stop();
  } else if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    // Shift+Tab switches the agent (Build ↔ Plan), as in the agent menu's note.
    const agents = state?.agents ?? [];
    if (agents.length < 2 || input.disabled) return;
    e.preventDefault();
    const i = agents.findIndex((a) => a.id === state?.selectedAgent);
    send({ type: "selectAgent", id: agents[(i + 1) % agents.length].id });
  }
});
input.addEventListener("input", () => {
  draft = input.value;
  persist();
  autosize();
  updateMention();
  if (state) renderComposer(state);
});
// Moving the caret into or out of an `@token` opens or closes its list.
input.addEventListener("click", () => updateMention());
input.addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMention();
});
input.addEventListener("blur", () => closeMention());

// Pasted or dropped images are attached (PNG, JPEG, GIF, WebP).
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
input.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => IMAGE_TYPE.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) void attachImageFile(f);
});
boxEl.addEventListener("dragover", (e) => {
  if (!Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) return;
  e.preventDefault();
  boxEl.classList.add("drop");
});
boxEl.addEventListener("dragleave", () => boxEl.classList.remove("drop"));
boxEl.addEventListener("drop", (e) => {
  boxEl.classList.remove("drop");
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => IMAGE_TYPE.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) void attachImageFile(f);
});

/** Images over this size or side are re-encoded smaller before they are attached. */
const IMAGE_MAX_BYTES = 4_500_000;
const IMAGE_MAX_SIDE = 2048;

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("not an image"));
    img.src = url;
  });
}

/** Draws `img` scaled to fit `side` and returns it as a data: URI. */
function scaled(img: HTMLImageElement, side: number, type: string, quality?: number): string {
  const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, quality);
}

async function attachImageFile(f: File): Promise<void> {
  try {
    let dataUrl = await readDataUrl(f);
    const img = await loadImage(dataUrl);
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (f.size > IMAGE_MAX_BYTES || Math.max(width, height) > IMAGE_MAX_SIDE) {
      // Large screenshots are scaled down rather than refused, as models downscale them anyway.
      dataUrl = scaled(img, IMAGE_MAX_SIDE, "image/jpeg", 0.85);
      const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
      width = Math.round(width * k);
      height = Math.round(height * k);
    }
    const thumb = scaled(img, 64, "image/png");
    const name = (f.name || "image.png").replace(/[\\/]/g, "_");
    send({ type: "attachImage", name, dataUrl, thumb, width, height });
  } catch {
    // Not a readable image: nothing to attach.
  }
}

/** The message box grows with its text up to 240px (40% of a short panel), then scrolls. */
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240, Math.max(80, window.innerHeight * 0.4)) + "px";
}

function submit() {
  if (!state || state.connection.kind !== "connected") return;
  const text = input.value;
  if (!text.trim()) return;
  const cmd = /^\/([\w.:/-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const known = cmd && (state.commands ?? []).some((c) => c.name === cmd[1]);
  if (cmd && known)
    send(
      state.busy
        ? { type: "runCommand", name: cmd[1], text: cmd[2] ?? "", delivery }
        : { type: "runCommand", name: cmd[1], text: cmd[2] ?? "" },
    );
  else if (cmd && cmd[1] === "compact" && !cmd[2]) send({ type: "compact" });
  else if (text.startsWith("!") && text.slice(1).trim())
    send({ type: "shellCommand", command: text.slice(1).trim() });
  else {
    const picked = mentions.filter((m) => text.includes(m.text));
    send({
      type: "send",
      text,
      ...(state.busy ? { delivery } : {}),
      ...(picked.length ? { mentions: picked } : {}),
    });
  }
  input.value = "";
  draft = "";
  mentions = [];
  closeMention();
  persist();
  autosize();
  stickToBottom = true;
  renderComposer(state);
}

function stop() {
  send({ type: "stop" });
}

function copy(key: string, itemId: string, msg: { kind: "message" } | { kind: "code"; text: string }) {
  const requestId = `c${++requestSeq}`;
  copyRequests.set(requestId, { key, itemId });
  if (msg.kind === "message") send({ type: "copyMessage", itemId, requestId });
  else send({ type: "copy", text: msg.text, requestId });
}

// ------------------------------------------------------------------- menus
//
// Popup menus above the message box (and under the header). Wide menus span the
// message box; long ones scroll and can have a filter field. Arrow keys move,
// Enter picks, Escape closes and returns focus to the button that opened it.

interface MenuEntry {
  /** toggle: a switch that stays in the menu; slider: a row of dots to pick one of a few values. */
  kind: "item" | "heading" | "note" | "stat" | "sep" | "toggle" | "slider";
  label?: string;
  /** Muted text on the right (a shortcut, a figure). */
  detail?: string;
  /** Muted second line under the label. */
  sub?: string;
  icon?: keyof typeof ICON_PATHS;
  checked?: boolean;
  disabled?: boolean;
  testid?: string;
  dot?: "live" | "idle" | "err";
  value?: string;
  onPick?: () => void;
  /** slider: the values in order, the chosen one, and what to do on a change. */
  options?: Array<{ value: string; label: string }>;
  selected?: string;
  onSelect?: (value: string) => void;
}

interface MenuOptions {
  /** "box": as wide as the message box; a number: that many pixels at most. */
  width?: "box" | number;
  /** Line up with the button's left edge (default) or its right edge. */
  align?: "start" | "end";
  title?: string;
  /** Keys shown at the right of the title, e.g. ["⇧", "Tab"], then `keysText`. */
  keys?: string[];
  keysText?: string;
  /** Placeholder of a filter field at the top. */
  filter?: string;
  maxHeight?: number;
  /** Fixed rows under the scrolling list (sliders, toggles), set apart by a line. */
  footer?: MenuEntry[];
}

const item = (
  label: string,
  onPick: () => void,
  o: Omit<MenuEntry, "kind" | "label" | "onPick"> = {},
): MenuEntry => ({ kind: "item", label, onPick, ...o });
const heading = (label: string): MenuEntry => ({ kind: "heading", label });
const note = (label: string): MenuEntry => ({ kind: "note", label });
const stat = (label: string, value: string): MenuEntry => ({ kind: "stat", label, value });
const sep = (): MenuEntry => ({ kind: "sep" });
const toggle = (label: string, on: boolean, onPick: () => void, testid?: string): MenuEntry => ({
  kind: "toggle",
  label,
  checked: on,
  onPick,
  testid,
});
const slider = (
  label: string,
  options: Array<{ value: string; label: string }>,
  selected: string,
  onSelect: (value: string) => void,
  testid?: string,
): MenuEntry => ({ kind: "slider", label, options, selected, onSelect, testid });

let openMenuState: { anchor: HTMLElement; el: HTMLElement; cleanup: () => void } | null = null;

function closeMenu(restoreFocus = false): void {
  const m = openMenuState;
  if (!m) return;
  openMenuState = null;
  m.cleanup();
  m.el.remove();
  m.anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && m.anchor.isConnected) m.anchor.focus();
}

function openMenu(anchor: HTMLElement, entries: MenuEntry[], opts: MenuOptions = {}): void {
  const reopen = openMenuState?.anchor === anchor;
  closeMenu();
  hideTip();
  if (reopen) return; // a second click on the same button closes it
  const menu = h("div", { className: "menu", role: "menu", "data-testid": "menu" });
  if (opts.title || opts.keys)
    menu.append(
      h(
        "div",
        { className: "menu-title" },
        h("span", {}, opts.title ?? ""),
        opts.keys
          ? h(
              "span",
              { className: "menu-keys" },
              ...opts.keys.flatMap((k, i) => [i ? " + " : "", h("kbd", {}, k)]),
              opts.keysText ? ` ${opts.keysText}` : "",
            )
          : null,
      ),
    );
  const filter = opts.filter
    ? (h("input", {
        className: "menu-filter",
        type: "text",
        placeholder: opts.filter,
        "aria-label": opts.filter,
        "data-testid": "menu-filter",
      }) as HTMLInputElement)
    : null;
  if (filter) menu.append(filter);
  const list = h("div", { className: "menu-list" });
  menu.append(list);
  const items: HTMLElement[] = [];
  const build = (e: MenuEntry, into: HTMLElement) => {
    if (e.kind === "heading")
      into.append(h("div", { className: "menu-h", role: "presentation" }, e.label ?? ""));
    else if (e.kind === "note") into.append(h("div", { className: "menu-note" }, e.label ?? ""));
    else if (e.kind === "sep") into.append(h("hr", { role: "separator" }));
    else if (e.kind === "stat")
      into.append(
        h("div", { className: "menu-stat" }, h("span", {}, e.label ?? ""), h("span", {}, e.value ?? "")),
      );
    else if (e.kind === "toggle") {
      let on = !!e.checked;
      const sw = h("span", { className: "sw" + (on ? " on" : ""), "aria-hidden": "true" });
      const b = h(
        "button",
        {
          className: "menu-item toggle",
          role: "menuitemcheckbox",
          "aria-checked": String(on),
          tabindex: "-1",
          "data-testid": e.testid,
          "data-find": (e.label ?? "").toLowerCase(),
          onclick: () => {
            // A switch flips in place; the menu stays open.
            on = !on;
            sw.classList.toggle("on", on);
            b.setAttribute("aria-checked", String(on));
            e.onPick?.();
          },
        },
        h("span", { className: "menu-text" }, h("span", { className: "menu-label" }, e.label ?? "")),
        sw,
      );
      items.push(b);
      into.append(b);
    } else if (e.kind === "slider") {
      const opts2 = e.options ?? [];
      let cur = Math.max(
        0,
        opts2.findIndex((o) => o.value === e.selected),
      );
      const valueEl = h("span", { className: "slider-value" }, `(${opts2[cur]?.label ?? ""})`);
      const dots = opts2.map((o, i) =>
        h("span", {
          className: "sd" + (i === cur ? " on" : ""),
          role: "radio",
          "aria-checked": String(i === cur),
          "aria-label": o.label,
          "data-value": o.value,
          "data-tip": o.label,
          onclick: (ev: Event) => {
            ev.stopPropagation();
            pickAt(i);
          },
        }),
      );
      const pickAt = (i: number) => {
        if (i < 0 || i >= opts2.length || i === cur) return;
        cur = i;
        dots.forEach((d, j) => {
          d.classList.toggle("on", j === cur);
          d.setAttribute("aria-checked", String(j === cur));
        });
        valueEl.textContent = `(${opts2[cur].label})`;
        e.onSelect?.(opts2[cur].value);
      };
      const row = h(
        "div",
        {
          className: "menu-item slider",
          role: "radiogroup",
          "aria-label": e.label,
          tabindex: "-1",
          "data-testid": e.testid,
          "data-find": [e.label, ...opts2.map((o) => o.label)].join(" ").toLowerCase(),
          onkeydown: (ev: Event) => {
            const k = (ev as KeyboardEvent).key;
            if (k === "ArrowLeft" || k === "ArrowRight") {
              ev.preventDefault();
              ev.stopPropagation();
              pickAt(cur + (k === "ArrowRight" ? 1 : -1));
            }
          },
        },
        h(
          "span",
          { className: "menu-text" },
          h("span", { className: "menu-label" }, e.label ?? "", " ", valueEl),
        ),
        h("span", { className: "dots" }, ...dots),
      );
      items.push(row);
      into.append(row);
    } else {
      const b = h(
        "button",
        {
          className: "menu-item" + (e.checked ? " sel" : ""),
          role: e.checked === undefined ? "menuitem" : "menuitemradio",
          "aria-checked": e.checked === undefined ? undefined : String(e.checked),
          disabled: e.disabled,
          tabindex: "-1",
          "data-testid": e.testid,
          "data-find": [e.label, e.detail, e.sub].filter(Boolean).join(" ").toLowerCase(),
          onclick: () => {
            closeMenu(true);
            e.onPick?.();
          },
        },
        e.dot ? h("span", { className: `md md-${e.dot}`, "aria-hidden": "true" }) : null,
        e.icon ? icon(e.icon) : null,
        h(
          "span",
          { className: "menu-text" },
          h("span", { className: "menu-label", dir: "auto" }, e.label ?? ""),
          e.sub ? h("span", { className: "menu-sub", dir: "auto" }, e.sub) : null,
        ),
        e.detail ? h("span", { className: "k" }, e.detail) : null,
      );
      items.push(b);
      into.append(b);
    }
  };
  for (const e of entries) build(e, list);
  if (opts.footer?.length) {
    const foot = h("div", { className: "menu-foot" });
    for (const e of opts.footer) build(e, foot);
    menu.append(foot);
  }
  document.body.append(menu);

  // Menus of the message box open above it; others open under (or over) their button.
  const r = anchor.getBoundingClientRect();
  const inBox = composerEl.contains(anchor);
  const frame = inBox ? (boxEl.hidden ? dockEl : boxEl).getBoundingClientRect() : r;
  const vw = window.innerWidth;
  const natural = Math.max(menu.offsetWidth, 200);
  const width = Math.min(
    opts.width === "box" ? frame.width : Math.max(Math.min(natural, opts.width ?? natural), 200),
    vw - 16,
  );
  menu.style.width = `${Math.round(width)}px`;
  const left = opts.width === "box" ? frame.left : opts.align === "end" ? r.right - width : r.left;
  menu.style.left = `${Math.round(Math.max(8, Math.min(left, vw - width - 8)))}px`;
  list.style.maxHeight = `${opts.maxHeight ?? 360}px`;
  const chrome = menu.offsetHeight - list.offsetHeight;
  const room = inBox ? frame.top - 6 - 8 : window.innerHeight - r.bottom - 6 - 8;
  if (menu.offsetHeight > room) list.style.maxHeight = `${Math.max(80, room - chrome)}px`;
  const height = menu.offsetHeight;
  menu.style.top = `${Math.round(inBox ? Math.max(8, frame.top - 6 - height) : r.bottom + 6)}px`;
  anchor.setAttribute("aria-expanded", "true");

  const visible = () => items.filter((x) => !x.hidden && !(x as HTMLButtonElement).disabled);
  const focus = (i: number) => {
    const v = visible();
    if (!v.length) return;
    v[(i + v.length) % v.length].focus();
  };
  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    for (const it of items) it.hidden = !!q && !(it.dataset.find ?? "").includes(q);
    // Headings, notes and separators show only around matching items.
    let headingEl: HTMLElement | null = null;
    let any = false;
    for (const child of Array.from(list.children) as HTMLElement[]) {
      if (child.classList.contains("menu-h")) {
        if (headingEl) headingEl.hidden = !any;
        headingEl = child;
        any = false;
      } else if (child.classList.contains("menu-item")) {
        if (!child.hidden) any = true;
      } else child.hidden = !!q;
    }
    if (headingEl) headingEl.hidden = !any;
  });
  filter?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focus(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      visible()[0]?.click();
    }
  });
  menu.addEventListener("keydown", (e) => {
    const v = visible();
    const cur = v.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.target === filter) return;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.key === "ArrowUp" && cur === 0 && filter) filter.focus();
      else focus((cur < 0 ? 0 : cur) + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focus(e.key === "Home" ? 0 : v.length - 1);
    } else if (e.key === "Tab") closeMenu(true);
  });
  const onOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) closeMenu();
  };
  const onResize = () => closeMenu();
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onResize);
  openMenuState = {
    anchor,
    el: menu,
    cleanup: () => {
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    },
  };
  if (filter) filter.focus();
  else {
    const sel = items.find((i) => i.classList.contains("sel") && !(i as HTMLButtonElement).disabled);
    (sel ?? visible()[0] ?? menu).focus();
    (sel ?? visible()[0])?.scrollIntoView({ block: "nearest" });
  }
}

// ----------------------------------------------------------------- dialogs
//
// Confirmation for destructive actions, centered over the panel. Each choice is a
// button with a second line; Escape, Cancel or a click outside cancels. Focus stays
// inside while it is open and returns where it was.

interface DialogChoice {
  value: string;
  label: string;
  sub?: string;
  danger?: boolean;
  testid?: string;
}

let dialogOpen = false;

function confirmDialog(o: { title: string; body: string; choices: DialogChoice[] }): Promise<string | null> {
  if (dialogOpen) return Promise.resolve(null);
  dialogOpen = true;
  closeMenu();
  closeMention();
  hideTip();
  const before = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      dialogOpen = false;
      backdrop.remove();
      if (before?.isConnected) before.focus();
      resolve(v);
    };
    const buttons = o.choices.map((c) =>
      h(
        "button",
        {
          className: "modal-choice" + (c.danger ? " danger" : ""),
          "data-testid": c.testid,
          onclick: () => done(c.value),
        },
        h("span", { className: "modal-label" }, c.label),
        c.sub ? h("span", { className: "modal-sub" }, c.sub) : null,
      ),
    );
    const cancel = h(
      "button",
      { className: "btn subtle", "data-testid": "dialog-cancel", onclick: () => done(null) },
      "Cancel",
    );
    const dialog = h(
      "div",
      {
        className: "modal",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "modal-title",
        "aria-describedby": "modal-body",
        "data-testid": "dialog",
      },
      h("h2", { id: "modal-title" }, o.title),
      h("p", { id: "modal-body" }, o.body),
      h("div", { className: "modal-choices" }, ...buttons),
      h("div", { className: "modal-foot" }, cancel),
    );
    const backdrop = h(
      "div",
      {
        className: "modal-backdrop",
        onmousedown: (e: Event) => {
          if (e.target === backdrop) done(null);
        },
      },
      dialog,
    );
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === "Tab") {
        const f: HTMLElement[] = [...buttons, cancel];
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        e.preventDefault();
        buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
    });
    document.body.append(backdrop);
    // Safe first: focus the last choice (the least destructive one).
    buttons[buttons.length - 1]?.focus();
  });
}

async function confirmRewind(messageID: string): Promise<void> {
  const pick = await confirmDialog({
    title: "Rewind to before this prompt?",
    body: "OpenCode removes this prompt and everything after it from the session. This can't be undone. The prompt goes back into the message box.",
    choices: [
      {
        value: "code",
        label: "Rewind conversation and code",
        sub: "Also undo the file changes OpenCode made since",
        danger: true,
        testid: "rewind-code",
      },
      {
        value: "chat",
        label: "Rewind conversation only",
        sub: "Keep the files as they are now",
        testid: "rewind-chat",
      },
    ],
  });
  if (pick) send({ type: "rewind", messageID, files: pick === "code" });
}

// ---------------------------------------------------------------- tooltips
//
// Small dark tooltips for the header and message-box buttons (`data-tip`), shown
// after a short hover or on keyboard focus.

const tipEl = h("div", { className: "tip", role: "tooltip", "data-testid": "tooltip", hidden: true });
document.body.append(tipEl);
let tipFor: HTMLElement | null = null;
let tipTimer = 0;

function showTip(el: HTMLElement): void {
  const text = el.dataset.tip;
  if (!text || openMenuState?.anchor === el) return;
  tipFor = el;
  tipEl.textContent = text;
  tipEl.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const hgt = tipEl.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  const top = r.top - hgt - 6 >= 8 ? r.top - hgt - 6 : r.bottom + 6;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

function hideTip(): void {
  clearTimeout(tipTimer);
  tipFor = null;
  tipEl.hidden = true;
}

document.addEventListener("mouseover", (e) => {
  const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;
  if (el === tipFor) return;
  hideTip();
  if (el) {
    tipFor = el;
    tipTimer = window.setTimeout(() => showTip(el), 350);
  }
});
document.addEventListener("focusin", (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset?.tip && el.matches(":focus-visible")) showTip(el);
  else hideTip();
});
document.addEventListener("mousedown", () => hideTip(), true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTip();
});
window.addEventListener("blur", () => hideTip());

/** Subagents of the session: running and waiting first; each opens its conversation. */
// ---------------------------------------------------------------- mentions
//
// Typing `@` opens a list above the message box: files and folders (found by
// OpenCode), subagents and skills. The caret stays in the box; arrows move,
// Enter or Tab picks, Escape closes. A pick inserts its token (`@src/a.ts`) and is
// remembered, so the prompt carries it as an OpenCode mention.

const mentionEl = h("div", {
  className: "menu mention-menu",
  role: "listbox",
  id: "mention-list",
  "aria-label": "Mention",
  "data-testid": "mention-menu",
  hidden: true,
});
document.body.append(mentionEl);
let mention: {
  start: number;
  query: string;
  items: MentionCandidate[];
  active: number;
  requestId: string;
} | null = null;
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

const MENTION_ICONS: Record<MentionCandidate["kind"], keyof typeof ICON_PATHS> = {
  file: "file",
  folder: "folder",
  agent: "agent",
  skill: "skill",
};

/** The `@token` the caret is in: where its `@` is and what follows it. */
function mentionAtCaret(): { start: number; query: string } | null {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return null;
  const m = /(^|[\s([{"'`])@([^\s@]*)$/.exec(input.value.slice(0, pos));
  return m ? { start: pos - m[2].length - 1, query: m[2] } : null;
}

function updateMention(): void {
  const at = mentionAtCaret();
  if (!at || !state || state.connection.kind !== "connected" || input.disabled) return closeMention();
  if (mention && mention.start === at.start && mention.query === at.query) return;
  const keep = mention?.start === at.start ? mention.items : [];
  mention = { start: at.start, query: at.query, items: keep, active: 0, requestId: `m${++requestSeq}` };
  const requestId = mention.requestId;
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => send({ type: "findMentions", query: at.query, requestId }), 60);
  renderMention();
}

/** From the + menu: types an `@` at the caret and opens the list. */
function startMention(): void {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const pad = before && !/\s$/.test(before) ? " " : "";
  input.setRangeText(`${pad}@`, pos, input.selectionEnd, "end");
  input.focus();
  input.dispatchEvent(new Event("input"));
}

function closeMention(): void {
  clearTimeout(mentionTimer);
  mention = null;
  mentionEl.hidden = true;
  mentionEl.replaceChildren();
  input.removeAttribute("aria-activedescendant");
  input.setAttribute("aria-expanded", "false");
}

function renderMention(): void {
  const m = mention;
  if (!m || !m.items.length) {
    mentionEl.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }
  mentionEl.replaceChildren(
    ...m.items.map((c, i) =>
      h(
        "div",
        {
          className: "menu-item mention" + (i === m.active ? " active" : ""),
          role: "option",
          id: `mention-${i}`,
          "aria-selected": String(i === m.active),
          "data-testid": "mention-option",
          "data-kind": c.kind,
          // Keep the caret in the box: pick on mousedown, before it blurs.
          onmousedown: (e: Event) => {
            e.preventDefault();
            pickMention(i);
          },
          onmousemove: () => {
            if (mention && mention.active !== i) {
              mention.active = i;
              renderMention();
            }
          },
        },
        icon(MENTION_ICONS[c.kind]),
        h("span", { className: "menu-text" }, h("span", { className: "menu-label", dir: "auto" }, c.label)),
        c.detail ? h("span", { className: "k", dir: "auto" }, c.detail) : null,
      ),
    ),
  );
  mentionEl.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", `mention-${m.active}`);
  const frame = boxEl.getBoundingClientRect();
  mentionEl.style.width = `${Math.round(frame.width)}px`;
  mentionEl.style.left = `${Math.round(frame.left)}px`;
  mentionEl.style.maxHeight = `${Math.max(120, Math.min(320, frame.top - 14))}px`;
  mentionEl.style.top = `${Math.round(Math.max(8, frame.top - 6 - mentionEl.offsetHeight))}px`;
  mentionEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pickMention(i: number): void {
  const m = mention;
  const c = m?.items[i];
  if (!m || !c) return;
  const token = `@${c.value}${c.kind === "folder" ? "/" : ""}`;
  input.setRangeText(`${token} `, m.start, input.selectionStart, "end");
  if (!mentions.some((x) => x.text === token)) mentions.push({ kind: c.kind, value: c.value, text: token });
  closeMention();
  input.focus();
  input.dispatchEvent(new Event("input"));
}

/** Keys for the open `@` list; returns true when the key was used. */
function mentionKey(e: KeyboardEvent): boolean {
  const m = mention;
  if (!m || mentionEl.hidden || e.isComposing) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    m.active = (m.active + (e.key === "ArrowDown" ? 1 : -1) + m.items.length) % m.items.length;
    renderMention();
  } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pickMention(m.active);
  else if (e.key === "Escape") closeMention();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function agentsMenu(): MenuEntry[] {
  const subs = state?.subagents ?? [];
  if (!subs.length) return [note("No subagents in this session yet.")];
  const order = { waiting: 0, running: 1, failed: 2, stopped: 3, completed: 4 } as const;
  return [...subs]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((v) =>
      item(v.title || agentLabel(v.agent), () => send({ type: "openSubagent", sessionID: v.sessionID }), {
        sub: [v.agent, activityText(v)].filter(Boolean).join(" · "),
        detail:
          v.started !== null && v.status !== "waiting"
            ? formatDuration((v.ended ?? Date.now()) - v.started)
            : undefined,
        dot:
          v.status === "running" || v.status === "waiting" ? "live" : v.status === "failed" ? "err" : "idle",
        testid: "agents-menu-item",
      }),
    );
}

/** Models grouped by provider (they scroll); the session's usage when the clock is off. */
function modelMenu(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const out: MenuEntry[] = [];
  const models = s.models ?? [];
  let provider = "";
  for (const m of models) {
    if (m.providerName !== provider) {
      provider = m.providerName;
      out.push(heading(provider));
    }
    out.push(
      item(m.name, () => send({ type: "selectModel", key: m.key }), {
        checked: m.key === s.selectedModel,
        sub: m.contextLimit ? `${formatTokens(m.contextLimit)} context` : undefined,
        testid: "model-option",
      }),
    );
  }
  if (!models.length) out.push(note(modelPlaceholder(s)));
  // Usage lives in the clock's menu; without the clock it stays here.
  const stats = usageStats(s);
  if (stats.length && !clockShown(s)) out.push(sep(), heading("Session"), ...stats);
  return out;
}

/** The variant and Budget Guard as dot sliders, for the model menu's footer and the / menu. */
function modelSliders(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const out: MenuEntry[] = [];
  const model = s.models?.find((m) => m.key === s.selectedModel);
  if (model?.variants.length)
    out.push(
      slider(
        "Variant",
        [{ value: "", label: "Default" }, ...model.variants.map((v) => ({ value: v, label: capitalize(v) }))],
        s.selectedVariant ?? "",
        (v) => send({ type: "selectVariant", variant: v }),
        "variant-slider",
      ),
    );
  out.push(
    slider(
      `${t("budget")} Guard`,
      (["off", "small", "medium", "large", "custom"] as BudgetLevel[]).map((l) => ({
        value: l,
        label: budgetLabel(l, s).replace(/ \((.*)\)$/, " · $1"),
      })),
      s.budget.level,
      (v) => send({ type: "selectBudget", level: v as BudgetLevel }),
      "budget-slider",
    ),
  );
  return out;
}

/** Puts `/name ` (or `!`) at the start of the message box, ready for arguments. */
function insertCommand(prefix: string): void {
  const rest = input.value.replace(/^\/[\w.:/-]*\s*|^!/, "");
  input.value = prefix + rest;
  draft = input.value;
  persist();
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (state) renderComposer(state);
}

/**
 * The / menu: everything you can do from the message box, in sections. OpenCode's
 * commands, Compact and `!command`, plus context, model, session and Sidecar's
 * own settings (switches that flip in place).
 */
function commandsMenu(): MenuEntry[] {
  const s = state;
  const cmds = s?.commands ?? [];
  const connected = s?.connection.kind === "connected" && s.onboarding.stage === "ready";
  const model = s?.models?.find((m) => m.key === s.selectedModel);
  const out: MenuEntry[] = [
    heading("Context"),
    item("Attach current file", () => send({ type: "addCurrentFile" }), {
      icon: "file",
      disabled: !connected,
    }),
    item("Attach selection", () => send({ type: "addSelection" }), {
      icon: "selection",
      disabled: !connected,
    }),
    item("Search workspace files…", () => send({ type: "searchFiles" }), {
      icon: "search",
      disabled: !connected,
    }),
    item(
      "Bookmarks…",
      () => {
        bookmarksOpen = true;
        sessionsOpen = false;
        render();
      },
      { icon: "bookmark" },
    ),
    item(
      "Session history…",
      () => {
        sessionsOpen = true;
        bookmarksOpen = false;
        send({ type: "refreshSessions" });
        render();
      },
      { icon: "history" },
    ),
    sep(),
    heading("Model"),
    item("Switch model…", () => openMenu(modelBtn, modelMenu(), modelMenuOptions()), {
      detail: model?.name,
      disabled: modelBtn.disabled,
      testid: "command-switch-model",
    }),
    ...modelSliders(),
    sep(),
    heading("Session"),
    item("/compact", () => send({ type: "compact" }), {
      sub: "Summarize the conversation to free context",
      disabled: !s?.currentSession,
      testid: "command-compact",
    }),
    item(
      "Rename session…",
      () => {
        if (s?.currentSession) startRename(s.currentSession.title);
      },
      { disabled: !s?.currentSession },
    ),
    item("Fork session", () => send({ type: "forkSession" }), {
      icon: "fork",
      sub: "Continue in a copy; this session stays as it is",
      disabled: !s?.currentSession,
      testid: "command-fork",
    }),
    item(
      "Archive session",
      () => {
        if (s?.currentSession) send({ type: "archiveSession", id: s.currentSession.id, archived: true });
      },
      { icon: "archive", disabled: !s?.currentSession, testid: "command-archive" },
    ),
    item("New session", () => send({ type: "newSession" }), { icon: "newchat" }),
    sep(),
    heading("OpenCode commands"),
  ];
  for (const c of cmds.filter((c) => c.name !== "compact"))
    out.push(
      item(`/${c.name}`, () => insertCommand(`/${c.name} `), {
        detail: c.description ?? undefined,
        testid: "command-option",
      }),
    );
  if (!cmds.some((c) => c.name !== "compact"))
    out.push(note("OpenCode reports no commands for this folder."));
  out.push(
    item("!command", () => insertCommand("!"), {
      sub: "Run a shell command in the session",
      testid: "command-shell",
    }),
    sep(),
    heading("Customize"),
    toggle(
      "Pin the prompt you're reading",
      !!s?.prefs.stickyPrompt,
      () => send({ type: "setPref", key: "stickyPrompt", value: !state?.prefs.stickyPrompt }),
      "pref-sticky",
    ),
    toggle(
      "Group tool activity",
      s?.prefs.activity === "grouped",
      () =>
        send({
          type: "setPref",
          key: "activity",
          value: state?.prefs.activity === "grouped" ? "detailed" : "grouped",
        }),
      "pref-grouped",
    ),
    toggle(
      "Playful status words",
      state?.prefs.statusWords !== false,
      () => send({ type: "setPref", key: "statusWords", value: state?.prefs.statusWords === false }),
      "pref-words",
    ),
    item("Sidecar settings…", () => send({ type: "openSettings" }), { testid: "open-settings" }),
  );
  return out;
}

function modelMenuOptions(): MenuOptions {
  return { width: "box", title: "Select a model", maxHeight: 320, footer: modelSliders() };
}

/** The clock shows once a step has finished, unless `cacheWarmMinutes` is 0. */
function clockShown(s: ViewState): boolean {
  return s.prefs.cacheWarmMinutes > 0 && !!s.usage?.lastStepAt;
}

function cacheUntil(s: ViewState): number {
  return (s.usage?.lastStepAt ?? 0) + s.prefs.cacheWarmMinutes * 60_000;
}

function cacheLabel(until: number): string {
  const left = until - Date.now();
  return left > 0 ? `${Math.ceil(left / 60_000)}m` : "cold";
}

function cacheTip(until: number): string {
  const left = until - Date.now();
  return left > 0
    ? `Prompt cache warm, about ${Math.ceil(left / 60_000)} min left (estimate).`
    : "Prompt cache probably cold (estimate).";
}

/** Prompt cache estimate, the session's usage, and Compact conversation. */
function usageMenu(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const left = cacheUntil(s) - Date.now();
  const out: MenuEntry[] = [
    heading("Prompt cache"),
    stat("Warm for", left > 0 ? `~${Math.ceil(left / 60_000)} min` : "cold (estimate)"),
  ];
  if (s.usage?.cacheHit != null)
    out.push(stat("Cache hit", `${Math.round(s.usage.cacheHit * 100)}% of input`));
  out.push(
    note(
      `Estimated from the last step and your ${s.prefs.cacheWarmMinutes}-minute cache setting. OpenCode reports cache tokens, not the timer.`,
    ),
  );
  const stats = usageStats(s);
  if (stats.length) out.push(sep(), heading("Session"), ...stats);
  out.push(
    sep(),
    item("Compact conversation", () => send({ type: "compact" }), {
      disabled: !s.currentSession,
      testid: "compact",
    }),
  );
  return out;
}

function usageStats(s: ViewState): MenuEntry[] {
  const out: MenuEntry[] = [];
  const u = s.usage;
  if (u?.contextTokens != null) {
    const pct = u.contextLimit ? ` (${Math.round((u.contextTokens / u.contextLimit) * 100)}%)` : "";
    out.push(
      stat(
        "Context",
        `${formatTokens(u.contextTokens)}${u.contextLimit ? ` / ${formatTokens(u.contextLimit)}` : ""}${pct}`,
      ),
    );
  }
  if (u?.cost != null) out.push(stat("Cost", formatCost(u.cost)));
  if (s.steps > 0 && u) out.push(stat("Steps", String(s.steps)));
  const b = s.budget;
  if (b.level !== "off" && (b.active || b.taskSteps > 0)) {
    const parts: string[] = [];
    if (b.limits.maxCost !== null)
      parts.push(
        `${b.taskCost !== null ? formatCost(b.taskCost) : "n/a"} / ${formatCost(b.limits.maxCost * b.allowance)}`,
      );
    if (b.limits.maxSteps !== null) parts.push(`${b.taskSteps} / ${b.limits.maxSteps * b.allowance} steps`);
    out.push(stat("Task", parts.join(" · ")));
  }
  return out;
}

/** The agent (Build, Plan, …) with OpenCode's descriptions, and steer or queue. */
function modeMenu(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const out: MenuEntry[] = [];
  for (const a of s.agents ?? [])
    out.push(
      item(a.name, () => send({ type: "selectAgent", id: a.id }), {
        checked: a.id === s.selectedAgent,
        icon: a.id === "plan" ? "plan" : "mode",
        sub: a.description ?? undefined,
        testid: "agent-option",
      }),
    );
  if (!(s.agents ?? []).length) out.push(note("No agents available."));
  out.push(sep(), heading("While the agent works"));
  for (const mode of ["steer", "queue"] as const)
    out.push(
      item(
        mode === "steer" ? t("steer") : t("queue"),
        () => {
          delivery = mode;
          persist();
          render();
        },
        {
          checked: delivery === mode,
          sub:
            mode === "steer"
              ? "Your message reaches the agent at its next step."
              : "Your message is sent when the current task ends.",
          testid: `mode-${mode}`,
        },
      ),
    );
  return out;
}

// --------------------------------------------------------------- scrolling

let stickToBottom = true;
scroller.addEventListener("scroll", () => {
  stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
});
function maybeScroll() {
  if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
}

// -------------------------------------------------------------- formatting

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

function formatCost(c: number): string {
  return `$${c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2)}`;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function changeCounts(files: FileChange[]) {
  return files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), {
    add: 0,
    del: 0,
  });
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function budgetLabel(level: BudgetLevel, s: ViewState): string {
  if (level === "off") return "Off";
  const l = s.budgetPresets[level];
  const parts = [
    l.maxCost !== null ? formatCost(l.maxCost) : null,
    l.maxSteps !== null ? `${l.maxSteps} steps` : null,
  ].filter(Boolean);
  return `${capitalize(level)}${parts.length ? ` (${parts.join(" · ")})` : ""}`;
}

// ------------------------------------------------------------------ header

// The <select> stays the source of truth (value, focus, change events), but the
// open list is ours. VS Code draws native <select> popups with the operating
// system, so on macOS they ignore the theme and end up the same colour as the
// sidebar. The custom menu uses the raised surface defined in main.css.
let selectMenu: {
  select: HTMLSelectElement;
  el: HTMLElement;
  cleanup: () => void;
} | null = null;

function closeSelectMenu(restoreFocus = false): void {
  const open = selectMenu;
  if (!open) return;
  selectMenu = null;
  open.cleanup();
  open.el.remove();
  open.select.removeAttribute("aria-expanded");
  if (restoreFocus && open.select.isConnected) open.select.focus();
}

function openSelectMenu(sel: HTMLSelectElement): void {
  closeSelectMenu();
  if (sel.disabled) return;

  const menu = h("div", {
    className: "select-menu",
    role: "listbox",
    tabindex: "-1",
    "aria-label": sel.getAttribute("aria-label") ?? "Options",
    "data-testid": "select-menu",
    "data-for": sel.id,
  });
  const items: HTMLElement[] = [];
  let optionIndex = 0;

  const pick = (value: string): void => {
    closeSelectMenu();
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sel.focus();
  };

  const addOption = (opt: HTMLOptionElement): void => {
    const selected = opt.value === sel.value;
    const item = h(
      "div",
      {
        className: `select-menu-item${selected ? " selected" : ""}`,
        role: "option",
        id: `${sel.id}-option-${optionIndex++}`,
        "aria-selected": selected ? "true" : "false",
        "aria-disabled": opt.disabled ? "true" : undefined,
        "data-value": opt.value,
        title: opt.title || undefined,
        onclick: () => {
          if (!opt.disabled) pick(opt.value);
        },
      },
      h("span", { className: "select-menu-check", "aria-hidden": "true" }, selected ? "✓" : ""),
      h("span", { className: "select-menu-text" }, opt.textContent ?? ""),
    );
    items.push(item);
    menu.append(item);
  };

  for (const child of Array.from(sel.children)) {
    if (child instanceof HTMLOptGroupElement) {
      menu.append(h("div", { className: "select-menu-group", role: "presentation" }, child.label));
      for (const opt of Array.from(child.children)) if (opt instanceof HTMLOptionElement) addOption(opt);
    } else if (child instanceof HTMLOptionElement) addOption(child);
  }

  document.body.append(menu);

  const rect = sel.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 200), viewportWidth - 16);
  menu.style.width = `${Math.round(width)}px`;
  const height = menu.offsetHeight;
  const rtl = getComputedStyle(sel).direction === "rtl";
  const left = rtl ? rect.right - width : rect.left;
  let top = rect.bottom + 2;
  if (top + height > viewportHeight - 8) top = Math.max(8, rect.top - height - 2);
  menu.style.left = `${Math.round(Math.max(8, Math.min(left, viewportWidth - width - 8)))}px`;
  menu.style.top = `${Math.round(top)}px`;

  let active = Math.max(
    0,
    items.findIndex(
      (item) => item.classList.contains("selected") && item.getAttribute("aria-disabled") !== "true",
    ),
  );
  const setActive = (index: number): void => {
    if (items.length === 0) return;
    active = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, i) => item.classList.toggle("active", i === active));
    const item = items[active];
    if (!item) return;
    menu.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Tab") {
      // Hand focus back to the select so Tab continues to the next control.
      closeSelectMenu(true);
      return;
    }
    if (
      e.key !== "Escape" &&
      e.key !== "Enter" &&
      e.key !== " " &&
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      closeSelectMenu(true);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      items[active]?.click();
      return;
    }
    if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(items.length - 1);
    else setActive(active + (e.key === "ArrowDown" ? 1 : -1));
  };
  menu.addEventListener("keydown", onKey);

  const onOutside = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!menu.contains(target) && target !== sel) closeSelectMenu();
  };
  const onViewport = (e: Event): void => {
    if (e.type === "scroll" && menu.contains(e.target as Node)) return;
    closeSelectMenu();
  };
  const onBlur = (): void => closeSelectMenu();
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  window.addEventListener("blur", onBlur);

  selectMenu = {
    select: sel,
    el: menu,
    cleanup: () => {
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      window.removeEventListener("blur", onBlur);
    },
  };
  sel.setAttribute("aria-expanded", "true");
  setActive(active);
  menu.focus();
}

function select(
  id: string,
  label: string,
  options: Array<{ value: string; text: string; title?: string; group?: string }>,
  selected: string | null,
  disabled: boolean,
  onChange: (v: string) => void,
  emptyText: string,
): HTMLSelectElement {
  const sel = h("select", {
    className: "select",
    id,
    "aria-label": label,
    disabled: disabled || options.length === 0,
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
  });
  if (options.length === 0) sel.append(h("option", {}, emptyText));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const o of options) {
    const opt = h("option", { value: o.value, title: o.title }, o.text);
    if (o.value === selected) opt.selected = true;
    if (o.group) {
      let g = groups.get(o.group);
      if (!g) {
        g = h("optgroup", { label: o.group });
        groups.set(o.group, g);
        sel.append(g);
      }
      g.append(opt);
    } else sel.append(opt);
  }
  sel.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || sel.disabled) return;
    // Prevent the native popup so the themed menu below is the only one shown.
    e.preventDefault();
    if (selectMenu?.select === sel) closeSelectMenu(true);
    else {
      sel.focus();
      openSelectMenu(sel);
    }
  });
  sel.addEventListener("keydown", (e) => {
    if (sel.disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openSelectMenu(sel);
  });
  return sel;
}

/** What the model pill says when no model can be picked yet. */
function modelPlaceholder(s: ViewState): string {
  const connected = s.connection.kind === "connected";
  const loading =
    s.onboarding.stage === "loading" ||
    (connected && s.models === null && !!s.workspace.active && s.onboarding.stage !== "catalog-error");
  return !connected
    ? "No model"
    : !s.workspace.active
      ? "Open a folder first"
      : loading
        ? "Loading models…"
        : s.models
          ? "No models — connect a provider"
          : "Models could not be loaded";
}

/**
 * The header: the session title (hover shows ✎, click to rename), then History
 * and New session. Connection problems show in the onboarding card and the status
 * bar; the header keeps a screen-reader-only status.
 */
function renderHeader(s: ViewState) {
  renderBanners(s);
  if (renaming && headerEl.querySelector(".p-rename")) return;
  const conn = s.connection;
  const connected = conn.kind === "connected";
  const stage = s.onboarding.stage;
  const statusText = STAGE_STATUS[stage];
  const statusTitle =
    conn.kind === "connected" ? `${statusText} — OpenCode ${conn.version} at ${conn.url}` : statusText;
  const title = s.currentSession?.title ?? "New session";
  const titleEl = s.currentSession
    ? h(
        "button",
        {
          className: "p-title",
          "data-tip": "Rename the session",
          "aria-label": `Session: ${title}. Rename`,
          "data-testid": "session-title",
          disabled: !connected,
          onclick: () => startRename(title),
        },
        h("span", { dir: "auto" }, title),
        icon("pencil"),
      )
    : h("span", { className: "p-title static", "data-testid": "session-title", dir: "auto" }, title);
  const iconBtn = (
    name: "history" | "newchat" | "bookmark",
    label: string,
    testid: string,
    onclick: () => void,
    expanded?: boolean,
  ) =>
    h(
      "button",
      {
        className: "ico",
        "data-tip": label,
        "aria-label": label,
        "aria-expanded": expanded === undefined ? undefined : String(expanded),
        "data-testid": testid,
        disabled: !connected,
        onclick,
      },
      icon(name),
    );
  headerEl.replaceChildren(
    titleEl,
    h("span", { className: "grow" }),
    h(
      "div",
      { className: "p-icons" },
      iconBtn(
        "bookmark",
        "Bookmarks",
        "bookmarks-button",
        () => {
          bookmarksOpen = !bookmarksOpen;
          sessionsOpen = false;
          render();
          if (bookmarksOpen) bookmarksEl.querySelector<HTMLElement>("button")?.focus();
        },
        bookmarksOpen,
      ),
      iconBtn(
        "history",
        "Session history",
        "history-button",
        () => {
          sessionsOpen = !sessionsOpen;
          bookmarksOpen = false;
          if (sessionsOpen) {
            sessionQuery = "";
            send({ type: "refreshSessions" });
          }
          render();
          if (sessionsOpen) sessionsEl.querySelector<HTMLInputElement>("input")?.focus();
        },
        sessionsOpen,
      ),
      iconBtn("newchat", "New session", "new-session", () => {
        sessionsOpen = false;
        send({ type: "newSession" });
        render();
      }),
    ),
    h(
      "span",
      { className: "sr-only", role: "status", title: statusTitle, "data-testid": "connection-status" },
      statusText,
    ),
  );
}

function startRename(current: string): void {
  renaming = true;
  const field = h("input", {
    className: "p-rename",
    type: "text",
    maxlength: 200,
    "aria-label": "Session title",
    "data-testid": "rename-input",
  }) as HTMLInputElement;
  field.value = current;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    renaming = false;
    const next = field.value.trim();
    if (save && next && next !== current) send({ type: "renameSession", title: next });
    if (state) renderHeader(state);
    headerEl.querySelector<HTMLElement>(".p-title")?.focus();
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  field.addEventListener("blur", () => finish(false));
  headerEl.querySelector(".p-title")?.replaceWith(field);
  field.focus();
  field.select();
}

function renderBanners(s: ViewState) {
  const connected = s.connection.kind === "connected";
  const ws = s.workspace;
  const banners: HTMLElement[] = [];
  if (ws.repoKind === "worktree") {
    banners.push(
      h(
        "div",
        { className: "banner warn", role: "note" },
        h("strong", {}, "⚠ Working in a separate Git worktree"),
        h(
          "div",
          { className: "muted" },
          ws.mainWorktree ? `Main working tree: ${ws.mainWorktree}` : "This folder is a secondary worktree.",
        ),
      ),
    );
  }
  if (ws.folders.length > 1) {
    banners.push(
      h(
        "div",
        { className: "banner info row" },
        h("span", {}, "Multi-root workspace — OpenCode works in"),
        select(
          "root-select",
          "Active workspace folder",
          ws.folders.map((f) => ({ value: f.path, text: f.name, title: f.path })),
          ws.active?.path ?? null,
          false,
          (v) => send({ type: "selectRoot", path: v }),
          "",
        ),
      ),
    );
  }
  const ob = s.onboarding;
  if (ob.stage === "ready" && ob.hint) {
    const expired = ob.hint === "sign-in-expired";
    banners.push(
      h(
        "div",
        {
          className: `banner ${expired ? "warn" : "info"} hint-banner`,
          role: "note",
          "data-testid": "sign-in-hint",
        },
        h(
          "span",
          {},
          ob.signIn === "waiting"
            ? "Waiting for sign-in — finish it in the OpenCode terminal and your browser."
            : expired
              ? "OpenCode reports that your OpenCode account sign-in needs to be renewed."
              : "No OpenCode account is connected. Sign in for more models.",
        ),
        h(
          "span",
          { className: "hint-actions" },
          ob.signIn === "waiting"
            ? null
            : h("button", { className: "btn small", onclick: () => send({ type: "signIn" }) }, "Sign in"),
          expired
            ? null
            : h(
                "button",
                {
                  className: "btn subtle small",
                  "aria-label": "Dismiss sign-in note",
                  onclick: () => send({ type: "dismissSignInHint" }),
                },
                "Dismiss",
              ),
        ),
      ),
    );
  }
  if (s.showPlacementHint && connected) {
    banners.push(
      h(
        "div",
        { className: "banner info hint-banner", role: "note" },
        h(
          "span",
          {},
          "Tip: drag the Sidecar icon to the Secondary Side Bar (right) to keep chat beside your editor.",
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": "Dismiss tip",
            onclick: () => send({ type: "dismissHint" }),
          },
          "Dismiss",
        ),
      ),
    );
  }
  // Keep the open folder menu (if any) alive: rebuild only when the banners change.
  const sig = JSON.stringify([
    ws.repoKind,
    ws.mainWorktree,
    ws.folders,
    ws.active?.path,
    ob.stage,
    ob.hint,
    ob.signIn,
    s.showPlacementHint,
    connected,
  ]);
  if (bannerEl.dataset.sig === sig) return;
  bannerEl.dataset.sig = sig;
  bannerEl.replaceChildren(...banners);
}

// --------------------------------------------------------------- history

const sessionSearch = h("input", {
  className: "text-input",
  type: "search",
  placeholder: "Search sessions",
  "aria-label": "Search sessions",
  "data-testid": "history-search",
}) as HTMLInputElement;
sessionSearch.addEventListener("input", () => {
  sessionQuery = sessionSearch.value;
  if (state) renderSessions(state);
});
const sessionList = h("ul", { className: "session-list", role: "list" });
sessionsEl.append(sessionSearch, sessionList);
sessionsEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    sessionsOpen = false;
    render();
    headerEl.querySelector<HTMLElement>('[data-testid="history-button"]')?.focus();
  }
});
document.addEventListener(
  "mousedown",
  (e) => {
    if (!sessionsOpen) return;
    const target = e.target as Element;
    if (sessionsEl.contains(target) || target.closest('[data-testid="history-button"]')) return;
    sessionsOpen = false;
    render();
  },
  true,
);

const archivedToggle = h("button", {
  className: "history-switch",
  "data-testid": "history-archived",
  onclick: () => {
    historyArchived = !historyArchived;
    if (historyArchived) send({ type: "loadArchived" });
    if (state) renderSessions(state);
  },
});
sessionsEl.append(archivedToggle);

/**
 * History popover: a search field and this workspace's sessions, each with Archive;
 * or, switched at the bottom, the archived ones with Restore.
 */
function renderSessions(s: ViewState) {
  sessionsEl.hidden = !sessionsOpen;
  if (!sessionsOpen) return;
  if (sessionSearch.value !== sessionQuery) sessionSearch.value = sessionQuery;
  const q = sessionQuery.trim().toLowerCase();
  const source = historyArchived ? (s.archivedSessions ?? []) : s.sessions;
  const matches = source.filter((x) => !q || x.title.toLowerCase().includes(q));
  const rows: HTMLElement[] = matches.map((sess) => {
    const current = sess.id === s.currentSession?.id;
    const meta = [relativeTime(sess.updated), sess.modelKey?.split("/").pop(), sess.agent]
      .filter(Boolean)
      .join(" · ");
    const act = historyArchived ? "Restore" : "Archive";
    return h(
      "li",
      { className: "session-row" },
      h(
        "button",
        {
          className: "session-item" + (current ? " current" : ""),
          "aria-current": current ? "true" : undefined,
          title: `Created ${new Date(sess.created).toLocaleString()}`,
          onclick: () => {
            sessionsOpen = false;
            send({ type: "selectSession", id: sess.id });
            render();
          },
        },
        h(
          "span",
          { className: "session-item-title", dir: "auto" },
          sess.forked
            ? h("span", { className: "fork-mark", "data-tip": "Forked session" }, icon("fork"))
            : null,
          sess.title,
        ),
        h("span", { className: "muted small" }, meta),
      ),
      h(
        "button",
        {
          className: "session-act",
          "data-tip": historyArchived ? "Restore to the history" : "Archive (hide from the history)",
          "aria-label": `${act} ${sess.title}`,
          "data-testid": historyArchived ? "session-restore" : "session-archive",
          onclick: () => send({ type: "archiveSession", id: sess.id, archived: !historyArchived }),
        },
        icon(historyArchived ? "restore" : "archive"),
      ),
    );
  });
  if (!rows.length)
    rows.push(
      h(
        "li",
        { className: "muted small" },
        historyArchived
          ? s.archivedSessions === null
            ? "Loading archived sessions…"
            : "No archived sessions."
          : s.sessions.length
            ? "No sessions match."
            : "No sessions in this workspace yet.",
      ),
    );
  sessionList.replaceChildren(...rows);
  archivedToggle.replaceChildren(
    icon(historyArchived ? "history" : "archive"),
    historyArchived ? "Back to sessions" : "Archived sessions",
  );
}

// --------------------------------------------------------------- bookmarks

bookmarksEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    bookmarksOpen = false;
    render();
    headerEl.querySelector<HTMLElement>('[data-testid="bookmarks-button"]')?.focus();
  }
});
document.addEventListener(
  "mousedown",
  (e) => {
    if (!bookmarksOpen) return;
    const target = e.target as Element;
    if (bookmarksEl.contains(target) || target.closest('[data-testid="bookmarks-button"]')) return;
    bookmarksOpen = false;
    render();
  },
  true,
);

/** Bookmarked answers of this workspace; one opens its session at the answer. */
function renderBookmarks(s: ViewState) {
  bookmarksEl.hidden = !bookmarksOpen;
  if (!bookmarksOpen) return;
  const rows = s.bookmarks.map((b) =>
    h(
      "li",
      { className: "bm" },
      h(
        "button",
        {
          className: "session-item",
          "data-testid": "bookmark-item",
          title: b.excerpt,
          onclick: () => {
            bookmarksOpen = false;
            send({ type: "openBookmark", id: b.id });
            render();
          },
        },
        h("span", { className: "bm-text", dir: "auto" }, b.excerpt),
        h(
          "span",
          { className: "muted small", dir: "auto" },
          `${b.sessionTitle} · ${relativeTime(b.created)}`,
        ),
      ),
      h(
        "button",
        {
          className: "ico small",
          title: "Remove bookmark",
          "aria-label": `Remove bookmark: ${b.excerpt.slice(0, 40)}`,
          "data-testid": "bookmark-remove",
          onclick: () => send({ type: "removeBookmark", id: b.id }),
        },
        icon("close"),
      ),
    ),
  );
  bookmarksEl.replaceChildren(
    h("div", { className: "menu-h" }, "Bookmarks"),
    rows.length
      ? h("ul", { className: "session-list", role: "list" }, ...rows)
      : h(
          "p",
          { className: "muted small" },
          "No bookmarks yet. Bookmark an answer with the button under it.",
        ),
  );
}

// ----------------------------------------------------------------- working

/**
 * Words for the Working line, one per run: Sidecar riding along while the agent drives.
 * Sidecar's own list, on its own theme.
 */
const STATUS_WORDS = [
  "Riding along",
  "Reading the map",
  "Taking the corner",
  "Checking the mirrors",
  "Shifting gears",
  "Leaning into the turn",
  "Finding the route",
  "Holding the line",
  "Charting a course",
  "Rounding the bend",
  "Kicking the tires",
  "Tuning the engine",
  "Following the road",
  "Signaling left",
  "Hugging the curve",
  "Merging carefully",
  "Watching the road",
  "Reading the signs",
];
let statusWord = STATUS_WORDS[0];

/** "Riding along… 2:14 · Esc to stop" under the timeline while the agent runs. */
function renderWorking(s: ViewState) {
  const show = s.busy && !subView;
  workingEl.hidden = !show;
  if (!show) {
    busySince = null;
    workingEl.replaceChildren();
    return;
  }
  // The mark is made once per run and kept: rebuilding it on every render would restart
  // its orbit each time the agent's state changes. Only the text after it is redrawn.
  let mark = workingEl.querySelector<HTMLElement>(":scope > .mark-spin");
  let label = workingEl.querySelector<HTMLElement>(":scope > .working-text");
  if (!mark || !label) {
    mark = h("span", { className: "mark-spin", "aria-hidden": "true" }, markSpinner());
    label = h("span", { className: "working-text" });
    workingEl.replaceChildren(mark, label);
  }
  if (busySince === null) {
    // A new run gets a new word.
    statusWord = STATUS_WORDS[Math.floor(Math.random() * STATUS_WORDS.length)];
    // Time the run from its prompt when that is recent; a resumed session starts now.
    const last = [...transcript.items].reverse().find((i) => i.kind === "user");
    const at = last?.kind === "user" ? last.time : undefined;
    busySince = at !== undefined && Date.now() - at < 6 * 3600_000 ? at : Date.now();
  }
  const word = s.stopping ? "Stopping" : s.prefs.statusWords === false ? "Working" : statusWord;
  label.replaceChildren(
    h("b", { "data-testid": "status-word", title: "OpenCode is working" }, `${word}…`),
    h(
      "span",
      { className: "muted" },
      h("span", { "data-elapsed-from": String(busySince) }, formatDuration(Date.now() - busySince)),
      s.stopping ? "" : " · Esc to stop",
    ),
  );
}

// ------------------------------------------------------------- empty state

function renderEmpty(s: ViewState) {
  const stage = s.onboarding.stage;
  let content: Array<Node | null> = [];
  if (subView) {
    if (subView.transcript.items.length === 0)
      content = [
        h(
          "p",
          { className: "muted" },
          s.viewingSubagent?.loading ? t("subagentLoading") : t("subagentEmpty"),
        ),
      ];
  } else if (stage === "connecting") content = [h("p", { className: "muted" }, "Connecting to OpenCode…")];
  else if (stage === "loading") {
    if (transcript.items.length === 0)
      content = [h("p", { className: "muted" }, "Checking OpenCode models and account…")];
  } else if (stage === "ready") {
    if (transcript.items.length === 0)
      content = [
        h("h2", {}, "Ask OpenCode anything"),
        h(
          "p",
          { className: "muted" },
          "Context is explicit: only the files and selections you attach are sent along with your message.",
        ),
      ];
  } else content = [renderOnboarding(s)];
  emptyEl.replaceChildren(...nonNull(content));
  emptyEl.hidden = content.length === 0;
}

// -------------------------------------------------------------- onboarding

const STAGE_STATUS: Record<OnboardingStage, string> = {
  connecting: "Connecting…",
  "not-installed": "OpenCode not installed",
  stopped: "OpenCode stopped",
  error: "Not connected",
  "no-folder": "No folder open",
  loading: "Checking…",
  "sign-in": "Sign-in required",
  "sign-in-expired": "Sign-in required",
  "no-models": "No models",
  "catalog-error": "Models unavailable",
  ready: "Connected",
};

const CHECK_MARK: Record<CheckState, string> = {
  done: "✓",
  todo: "○",
  optional: "–",
  expired: "!",
  unknown: "…",
};
const CHECK_TEXT: Record<CheckState, string> = {
  done: "done",
  todo: "not yet",
  optional: "optional",
  expired: "needs renewal",
  unknown: "not checked yet",
};

function checklist(s: ViewState): HTMLElement {
  const c = s.onboarding.checklist;
  const row = (label: string, state: CheckState, note?: string) =>
    h(
      "li",
      {
        className: `setup-check setup-${state}`,
        "data-check": state,
        "aria-label": `${label}: ${CHECK_TEXT[state]}`,
      },
      h("span", { className: "setup-mark", "aria-hidden": "true" }, CHECK_MARK[state]),
      h("span", {}, label),
      note ? h("span", { className: "muted small" }, ` ${note}`) : null,
    );
  return h(
    "ul",
    { className: "checklist", "aria-label": "Setup checklist", "data-testid": "onboarding-checklist" },
    row("Extension installed", "done"),
    row("OpenCode installed", c.installed),
    row("OpenCode connected", c.connected),
    row("Account signed in", c.account, c.account === "optional" ? "(optional)" : undefined),
    row("Models available", c.models),
  );
}

function actionBtn(label: string, msg: WebviewMessage, primary = false, testid?: string): HTMLElement {
  return h(
    "button",
    { className: primary ? "btn primary" : "btn", onclick: () => send(msg), "data-testid": testid },
    label,
  );
}

function linkBtn(label: string, link: OfficialLink): HTMLElement {
  return h(
    "button",
    { className: "link-btn", onclick: () => send({ type: "openOfficial", link }), "data-link": link },
    label,
  );
}

function renderOnboarding(s: ViewState): HTMLElement {
  const ob = s.onboarding;
  const conn = s.connection;
  const signInButtons = (primary: boolean) =>
    ob.signIn === "waiting"
      ? [actionBtn("Check again", { type: "refreshConnection" }, primary, "onb-refresh")]
      : [
          actionBtn("Sign in to OpenCode", { type: "signIn" }, primary, "onb-sign-in"),
          actionBtn("Refresh", { type: "refreshConnection" }, false, "onb-refresh"),
        ];
  let title = "";
  let body: Array<Node | string> = [];
  let actions: HTMLElement[] = [];
  let extra: Array<Node | null> = [];
  switch (ob.stage) {
    case "not-installed":
      title = "OpenCode is required";
      body = ["Sidecar is a UI for OpenCode and requires OpenCode to be installed."];
      actions = [
        actionBtn("Install OpenCode", { type: "openOfficial", link: "install" }, true, "onb-install"),
        actionBtn("Check again", { type: "retry" }, false, "onb-check"),
        actionBtn("Set Path…", { type: "configurePath" }),
      ];
      if (conn.kind === "cli-not-found")
        extra = [
          h(
            "details",
            {},
            h("summary", { className: "small" }, "Locations searched"),
            h(
              "ul",
              { className: "small" },
              ...conn.searched.slice(0, 30).map((p) => h("li", {}, h("code", {}, p))),
            ),
          ),
        ];
      break;
    case "stopped": {
      const canStart = conn.kind === "not-running" && conn.canStart;
      title = "OpenCode is installed";
      body = [
        canStart
          ? "Its background service is not running. Start it to continue."
          : conn.kind === "not-running"
            ? conn.detail
            : "",
      ];
      actions = [
        canStart ? actionBtn("Start OpenCode", { type: "startOpenCode" }, true, "onb-start") : null,
        actionBtn("Check again", { type: "retry" }, !canStart, "onb-check"),
      ].filter((x): x is HTMLElement => !!x);
      break;
    }
    case "error":
      title = "Could not connect to OpenCode";
      body = [conn.kind === "error" ? conn.message : "OpenCode did not respond."];
      actions = [
        actionBtn("Retry", { type: "retry" }, true, "onb-check"),
        actionBtn("Show Logs", { type: "showLogs" }),
      ];
      break;
    case "no-folder":
      title = "Open a project to start coding";
      body = ["OpenCode works inside a folder. Open one to start a session."];
      actions = [actionBtn("Open Folder", { type: "openFolder" }, true, "onb-open-folder")];
      break;
    case "sign-in":
    case "sign-in-expired":
      title = ob.stage === "sign-in" ? "Sign in to OpenCode" : "Sign-in needs to be renewed";
      body = [
        ob.stage === "sign-in"
          ? "No models are available yet. Sign in to your OpenCode account, or connect another provider in OpenCode."
          : "OpenCode reports that your OpenCode account sign-in has expired, and no models are available.",
      ];
      actions = [
        ...signInButtons(true),
        actionBtn("Connect another provider", { type: "connectProvider" }, false, "onb-provider"),
      ];
      extra = [
        h(
          "p",
          { className: "muted small privacy-note" },
          "Sign in using OpenCode. This extension never sees or stores your password.",
        ),
        h("p", { className: "small" }, linkBtn("Create or manage your OpenCode account", "account")),
      ];
      break;
    case "no-models":
      title = "No models are available yet.";
      body = ["Configure a provider in OpenCode or use an OpenCode Go model."];
      actions = [
        actionBtn("Configure models", { type: "connectProvider" }, true, "onb-provider"),
        actionBtn("Refresh", { type: "refreshConnection" }, false, "onb-refresh"),
      ];
      extra = [
        h(
          "p",
          { className: "small links" },
          linkBtn("Providers guide", "providers"),
          " · ",
          linkBtn("OpenCode Go", "go"),
        ),
      ];
      break;
    case "catalog-error":
      title = "Models could not be loaded";
      body = [
        "OpenCode did not return its model list. It may still be starting, or a provider may be unreachable.",
      ];
      actions = [
        actionBtn("Refresh", { type: "refreshConnection" }, true, "onb-refresh"),
        actionBtn("Show Logs", { type: "showLogs" }),
      ];
      break;
    default:
      break;
  }
  const signInNote =
    ob.signIn === "waiting"
      ? h(
          "p",
          { className: "banner info", role: "status", "data-testid": "sign-in-waiting" },
          "Waiting for sign-in — finish it in the OpenCode terminal and your browser. This view updates automatically.",
        )
      : ob.signIn === "cancelled"
        ? h(
            "p",
            { className: "banner warn", role: "status" },
            "Sign-in was not completed. You can try again.",
          )
        : ob.signIn === "failed"
          ? h(
              "p",
              { className: "banner warn", role: "status" },
              "OpenCode could not complete the sign-in. Check the terminal for details, then try again.",
            )
          : null;
  return h(
    "div",
    { className: "onboarding", "data-stage": ob.stage, "data-testid": "onboarding" },
    h("h2", {}, title),
    ...body.map((b) => h("p", {}, b)),
    signInNote,
    h("div", { className: "actions" }, ...actions),
    ...nonNull(extra),
    checklist(s),
    h("p", { className: "small muted help" }, "Need help? ", linkBtn("View setup guide", "setupGuide")),
  );
}

// -------------------------------------------------------------- transcript

function renderInline(nodes: Inline[]): Node[] {
  return nodes.map((n) => {
    switch (n.t) {
      case "text":
        return document.createTextNode(n.v);
      case "code":
        return h("code", {}, n.v);
      case "strong":
        return h("strong", {}, ...renderInline(n.c));
      case "em":
        return h("em", {}, ...renderInline(n.c));
      case "del":
        return h("del", {}, ...renderInline(n.c));
      case "br":
        return h("br");
      case "link":
        return h(
          "a",
          {
            href: n.href,
            title: n.href,
            onclick: (e: Event) => {
              e.preventDefault();
              send({ type: "openLink", href: n.href });
            },
          },
          ...renderInline(n.c),
        );
    }
  });
}

function copyButton(
  key: string,
  label: string,
  ariaLabel: string,
  disabled: boolean,
  onClick: () => void,
  testid: string,
): HTMLElement {
  const fb = copyFeedback.get(key);
  return h(
    "span",
    { className: "copy-wrap" },
    h(
      "button",
      {
        className: "btn subtle small copy-btn" + (fb === "copied" ? " copied" : ""),
        "aria-label": ariaLabel,
        "data-testid": testid,
        "data-key": key,
        disabled,
        onclick: onClick,
      },
      fb === "copied" ? t("copied") : label,
    ),
    fb === "failed" ? h("span", { className: "copy-error small", role: "alert" }, t("copyFailed")) : null,
  );
}

function renderBlocks(blocks: Block[], itemId: string, counter = { n: 0 }): Node[] {
  return blocks.map((b) => {
    switch (b.t) {
      case "p":
        return h("p", { dir: "auto" }, ...renderInline(b.c));
      case "h": {
        const level = Math.min(6, b.level + 2) as 3 | 4 | 5 | 6;
        return h(`h${level}` as "h3", { dir: "auto" }, ...renderInline(b.c));
      }
      case "hr":
        return h("hr");
      case "quote":
        return h("blockquote", {}, ...renderBlocks(b.c, itemId, counter));
      case "list": {
        const el = b.ordered
          ? h("ol", b.start !== 1 ? { start: b.start, dir: "auto" } : { dir: "auto" })
          : h("ul", { dir: "auto" });
        for (const item of b.items) el.append(h("li", {}, ...renderBlocks(item, itemId, counter)));
        return el;
      }
      case "table": {
        const table = h("table", { dir: "auto" });
        const headRow = h("tr");
        b.head.forEach((cell, i) =>
          headRow.append(
            h("th", b.align[i] ? { className: `align-${b.align[i]}` } : {}, ...renderInline(cell)),
          ),
        );
        table.append(h("thead", {}, headRow));
        const body = h("tbody");
        for (const row of b.rows) {
          const tr = h("tr");
          row.forEach((cell, i) =>
            tr.append(h("td", b.align[i] ? { className: `align-${b.align[i]}` } : {}, ...renderInline(cell))),
          );
          body.append(tr);
        }
        table.append(body);
        return h("div", { className: "table-wrap" }, table);
      }
      case "code": {
        const key = `code:${itemId}:${counter.n++}`;
        const text = b.text;
        return h(
          "div",
          { className: "codeblock" },
          h(
            "div",
            { className: "codeblock-bar" },
            h("span", { className: "muted small" }, b.lang || "code"),
            copyButton(
              key,
              t("copyCode"),
              t("copyCode"),
              false,
              () => copy(key, itemId, { kind: "code", text }),
              "copy-code",
            ),
          ),
          // Colored once the block is complete; while it streams it stays plain.
          h(
            "pre",
            { dir: "ltr" },
            h("code", {}, ...(b.closed ? highlightBlock(b.text, grammarFor(b.lang)) : [b.text])),
          ),
        );
      }
    }
  });
}

function details(id: string, summary: Node[], body: Node[], extraClass = ""): HTMLDetailsElement {
  const el = h("details", { className: "activity " + extraClass, open: openDetails.has(id) });
  el.addEventListener("toggle", () => {
    if (el.open) openDetails.add(id);
    else openDetails.delete(id);
  });
  el.append(h("summary", {}, ...summary), h("div", { className: "activity-body" }, ...body));
  return el;
}

function fileList(files: FileChange[], diffAction: "openAgentDiff" | null): HTMLElement {
  return h(
    "ul",
    { className: "file-list" },
    ...files.map((f) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            className: "link-btn",
            title: `Open ${f.path}`,
            onclick: () => send({ type: "openFile", path: f.path }),
          },
          f.path,
        ),
        h("span", { className: "adds" }, `+${f.additions}`),
        h("span", { className: "dels" }, `−${f.deletions}`),
        f.status !== "modified" ? h("span", { className: "muted small" }, f.status) : null,
        diffAction
          ? h(
              "button",
              {
                className: "btn subtle small",
                "aria-label": `View diff of ${f.path}`,
                "data-testid": "file-diff",
                onclick: () => send({ type: diffAction, path: f.path }),
              },
              "Diff",
            )
          : null,
      ),
    ),
  );
}

// --------------------------------------------------------------- tool rows
//
// Every tool call is its own timeline entry: the tool's name in bold and what it
// worked on. Shell calls show an IN/OUT box (output fades after three lines and
// expands on click), reads link to the file, edits show the changed lines inline
// and open VS Code's diff editor on click.

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** OpenCode tool names as people read them; anything else is capitalized as is. */
const TOOL_LABELS: Record<string, string> = {
  bash: "Shell",
  grep: "Search",
  glob: "Find files",
  list: "List",
  ls: "List",
  webfetch: "Fetch",
  websearch: "Web search",
  codesearch: "Code search",
  apply_patch: "Patch",
};

function toolLabel(item: ToolItem): string {
  const name = item.name.toLowerCase();
  return TOOL_LABELS[name] ?? capitalize(name.replace(/[_-]+/g, " "));
}

/** A path inside the open folder is shown relative to it; the link keeps the full path. */
function displayPath(p: string): string {
  const root = state?.workspace.active?.path;
  if (!root) return p;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const prefix = norm(root).replace(/\/+$/, "") + "/";
  const n = norm(p);
  const windows = /^[a-z]:\//i.test(prefix);
  const inside = windows ? n.toLowerCase().startsWith(prefix.toLowerCase()) : n.startsWith(prefix);
  return inside && n.length > prefix.length ? p.slice(prefix.length) : p;
}

function pathLink(p: string, testid = "tool-path"): HTMLElement {
  // An inline link (not a button) so a long path wraps right after the tool name.
  return h(
    "a",
    {
      className: "plink",
      href: "#",
      title: `Open ${p}`,
      "data-testid": testid,
      onclick: (e: Event) => {
        e.preventDefault();
        send({ type: "openFile", path: p });
      },
    },
    displayPath(p),
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Added 3 lines", "Added 2 lines, removed 1 line", "Removed 4 lines". */
/** What an edit did, in one phrase: the net lines added or removed, or "Modified". */
function changeText(f: FileChange | undefined): string {
  if (!f) return "Modified";
  if (f.status === "added") return `Created with ${plural(f.additions, "line")}`;
  if (f.status === "deleted") return "Deleted";
  const net = f.additions - f.deletions;
  return net > 0 ? `Added ${plural(net, "line")}` : net < 0 ? `Removed ${plural(-net, "line")}` : "Modified";
}

function changeSub(f: FileChange | undefined): HTMLElement {
  return h(
    "div",
    { className: "tool-sub", "data-tip": f ? `+${f.additions} −${f.deletions}` : undefined },
    changeText(f),
  );
}

/** A clickable box: Enter and Space work like a click. */
function clickable(attrs: Attrs, onActivate: () => void, ...children: Array<Node | null>): HTMLElement {
  return h(
    "div",
    {
      ...attrs,
      role: "button",
      tabindex: "0",
      onclick: onActivate,
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          onActivate();
        }
      },
    },
    ...children,
  );
}

const DIFF_MARK = { add: "+", del: "−", ctx: " ", gap: "⋯" } as const;
/** Diffs taller than this fade out at the bottom; the whole change is in the diff editor. */
const DIFF_VISIBLE = 16;
/** A written file shows its first lines, fading out; a click opens the file. */
const WRITTEN_VISIBLE = 6;

function diffBox(diff: FileDiff): HTMLElement {
  const long = diff.lines.length > DIFF_VISIBLE || diff.more > 0;
  const grammar = grammarFor(diff.path);
  return clickable(
    {
      className: "diff" + (long ? " long" : ""),
      title: `Open the change to ${diff.path} in the diff editor`,
      "aria-label": `Open the change to ${diff.path} in the diff editor`,
      "data-testid": "tool-diff",
    },
    () => send({ type: "openAgentDiff", path: diff.path }),
    h(
      "div",
      { className: "diff-lines" },
      ...diff.lines.map((l) =>
        h(
          "div",
          { className: `dl dl-${l.t}` },
          h("span", { className: "dm", "aria-hidden": "true" }, DIFF_MARK[l.t]),
          h("span", { className: "dt" }, ...(l.t === "gap" ? [] : highlightLine(l.text || " ", grammar))),
        ),
      ),
    ),
  );
}

function writtenBox(path: string, w: { lines: string[]; total: number }): HTMLElement {
  const grammar = grammarFor(path);
  return clickable(
    {
      className:
        "diff written" + (w.lines.length > WRITTEN_VISIBLE || w.total > w.lines.length ? " long" : ""),
      title: `Open ${path}`,
      "aria-label": `Open ${path}`,
      "data-testid": "tool-written",
    },
    () => send({ type: "openFile", path }),
    h(
      "div",
      { className: "diff-lines" },
      ...w.lines.map((l) =>
        h(
          "div",
          { className: "dl dl-ctx" },
          h("span", { className: "dm", "aria-hidden": "true" }, " "),
          h("span", { className: "dt" }, ...highlightLine(l || " ", grammar)),
        ),
      ),
    ),
  );
}

function ioRow(
  label: "IN" | "OUT",
  value: HTMLElement,
  copyOf?: { itemId: string; text: string },
): HTMLElement {
  const key = copyOf ? `io:${copyOf.itemId}:${label}` : "";
  const fb = copyOf ? copyFeedback.get(key) : undefined;
  const what = label === "IN" ? "command" : "output";
  return h(
    "div",
    { className: `io-row io-${label.toLowerCase()}` },
    h("span", { className: "io-k", "aria-hidden": "true" }, label),
    value,
    copyOf
      ? h(
          "button",
          {
            className: "io-copy" + (fb === "copied" ? " done" : ""),
            "aria-label": `Copy ${what}`,
            "data-tip": fb === "copied" ? "Copied" : `Copy ${what}`,
            "data-testid": "io-copy",
            onclick: (e: Event) => {
              e.stopPropagation();
              copy(key, copyOf.itemId, { kind: "code", text: copyOf.text });
            },
          },
          fb === "copied" ? "✓" : icon("copy"),
        )
      : null,
  );
}

/**
 * An IN or OUT value. Long output shows three lines that fade out. A click (or
 * Enter) opens the whole text in an editor tab, read-only, like a file.
 */
function ioValue(itemId: string, part: "in" | "out" | "prompt", text: string): HTMLElement {
  const body = text.replace(/\n+$/, "");
  const long = part === "out" && body.split("\n").length > 3;
  const what = part === "in" ? "Command" : part === "prompt" ? "Prompt" : "Output";
  return clickable(
    {
      className: "io-v io-open" + (long ? " io-fold" : "") + (part === "prompt" ? " io-prompt" : ""),
      "aria-label": `${what} (open in an editor tab)`,
      "data-tip": "Open in an editor tab",
      "data-testid": part === "out" ? "tool-output" : part === "in" ? "tool-command" : "subagent-prompt",
      "data-key": `${itemId}:${part}`,
      dir: part === "prompt" ? "auto" : undefined,
    },
    () => send({ type: "openToolText", itemId, part }),
    part === "prompt" ? document.createTextNode(body) : h("pre", {}, body),
  );
}

function renderTool(item: ToolItem): HTMLElement {
  const d = item.detail;
  const head = h(
    "div",
    { className: "th" },
    h("span", { className: "tool-name", "data-testid": "tool-name" }, toolLabel(item)),
  );
  const desc = (text: string, mono = false) =>
    h("span", { className: "desc" + (mono ? " mono" : ""), dir: "auto" }, text);
  const parts: Array<Node | null> = [head];
  let output: string | null = null;

  switch (item.category) {
    case "shell": {
      if (d.description) head.append(desc(d.description));
      const command = d.command ?? item.title;
      const rows = [ioRow("IN", ioValue(item.id, "in", command), { itemId: item.id, text: command })];
      if (d.output)
        rows.push(ioRow("OUT", ioValue(item.id, "out", d.output), { itemId: item.id, text: d.output }));
      parts.push(h("div", { className: "io", "data-testid": "tool-io" }, ...rows));
      if (item.status === "failed" && d.exitCode !== null && !d.error)
        parts.push(h("div", { className: "tool-error" }, `Exit code ${d.exitCode}`));
      break;
    }
    case "read":
      head.append(d.path ? pathLink(d.path) : desc(item.title));
      break;
    case "edit": {
      const diffs = d.diffs ?? [];
      if (diffs.length) {
        diffs.forEach((diff, i) => {
          if (i > 0)
            parts.push(
              h(
                "div",
                { className: "th" },
                h("span", { className: "tool-name" }, toolLabel(item)),
                pathLink(diff.path),
              ),
            );
          else head.append(pathLink(d.path && diffs.length === 1 ? d.path : diff.path));
          parts.push(changeSub(d.files.find((f) => f.path === diff.path)), diffBox(diff));
          if (diff.more)
            parts.push(h("div", { className: "tool-sub" }, `${plural(diff.more, "more line")} in the diff`));
        });
      } else if (d.written && d.path) {
        head.append(pathLink(d.path));
        parts.push(h("div", { className: "tool-sub" }, `Wrote ${plural(d.written.total, "line")}`));
        if (d.written.lines.length && item.status === "completed") parts.push(writtenBox(d.path, d.written));
      } else {
        head.append(d.path ? pathLink(d.path) : desc(item.title));
        if (d.files.length) parts.push(changeSub(d.files[0]));
      }
      break;
    }
    case "search": {
      const what = d.pattern ?? item.title;
      head.append(desc(what, !!d.pattern));
      if (d.pattern && d.path) head.append(desc(`in ${displayPath(d.path)}`));
      output = d.output;
      break;
    }
    default: {
      const fact = d.description ?? d.pattern ?? d.facts[0]?.[1] ?? null;
      if (fact) head.append(desc(fact));
      output = d.output;
    }
  }
  if (d.error) parts.push(h("div", { className: "tool-error", dir: "auto" }, d.error));

  const attrs = {
    className: `tool tool-${item.category}`,
    "data-status": item.status,
    "data-testid": "tool",
    "aria-label": `${toolLabel(item)}: ${item.status}`,
  };
  // Searches and other tools: a line count that opens the output in an editor tab.
  if (output) {
    const n = output.replace(/\n+$/, "").split("\n").length;
    parts.splice(
      1,
      0,
      clickable(
        {
          className: "tool-sub tool-out",
          "aria-label": `${plural(n, "line")} of output (open in an editor tab)`,
          "data-tip": "Open in an editor tab",
          "data-testid": "tool-output",
        },
        () => send({ type: "openToolText", itemId: item.id, part: "out" }),
        document.createTextNode(`${plural(n, "line")} of output`),
      ),
    );
  }
  return h("div", attrs, ...parts);
}

// ----------------------------------------------------------------- forms

function fieldValue(field: FormField, draftAnswer: FormAnswer) {
  if (field.type === "external") return undefined;
  return draftAnswer[field.key] ?? field.default;
}

function fieldActive(field: FormField, answers: FormAnswer): boolean {
  if (field.type === "external") return true;
  return (field.when ?? []).every((c) => {
    const v = answers[c.key];
    if (v === undefined || v === "") return false;
    const eq = Array.isArray(v) ? v.includes(String(c.value)) : v === c.value;
    return c.op === "eq" ? eq : !eq;
  });
}

// ------------------------------------------------------------------ docks
//
// A permission request or a question takes the message box's place until it is
// answered. The timeline keeps a one-line row for each, and a card of the answers.

type PermItem = Extract<TranscriptItem, { kind: "permission" }>;
type FormItem = Extract<TranscriptItem, { kind: "form" }>;

/** Per-form tab, the "Other" choice and the instruction typed for a rejection. */
const dockTab = new Map<string, number>();
const dockOther = new Set<string>();
const dockTell = new Map<string, string>();
let dockCollapsed = false;
let dockSignature = "";

function pendingRequests(): Array<PermItem | FormItem> {
  return transcript.items.filter(
    (i): i is PermItem | FormItem =>
      (i.kind === "permission" || i.kind === "form") && (i.status === "pending" || i.status === "sending"),
  );
}

const PERMISSION_DONE: Record<string, string> = {
  once: "Allowed once",
  always: "Always allowed",
  reject: "Denied",
  expired: "Request expired",
  sending: "Sending…",
};

/** "Allow this shell command?", "Allow write to <path>?", … and the lines to show under it. */
function permissionAsk(r: PermItem["request"]): { title: Node[]; command: string | null; list: string[] } {
  const a = r.action.toLowerCase();
  const code = (s: string) => h("code", {}, s);
  const one = r.resources.length === 1 ? r.resources[0] : null;
  if (/(bash|shell|command|exec)/.test(a))
    return {
      title: [document.createTextNode("Allow this shell command?")],
      command: r.resources.join("\n") || null,
      list: [],
    };
  if (/(edit|write|patch)/.test(a))
    return one
      ? {
          title: [
            document.createTextNode("Allow write to "),
            code(displayPath(one)),
            document.createTextNode("?"),
          ],
          command: null,
          list: [],
        }
      : {
          title: [document.createTextNode(`Allow writes to ${r.resources.length} files?`)],
          command: null,
          list: r.resources,
        };
  if (/(read|list|glob|grep)/.test(a))
    return one
      ? {
          title: [
            document.createTextNode("Allow reading "),
            code(displayPath(one)),
            document.createTextNode("?"),
          ],
          command: null,
          list: [],
        }
      : { title: [document.createTextNode("Allow reading these files?")], command: null, list: r.resources };
  if (/(web|fetch)/.test(a))
    return one
      ? {
          title: [document.createTextNode("Allow fetching "), code(one), document.createTextNode("?")],
          command: null,
          list: [],
        }
      : { title: [document.createTextNode("Allow these web requests?")], command: null, list: r.resources };
  if (/external/.test(a))
    return {
      title: [document.createTextNode("Allow access outside the project?")],
      command: null,
      list: r.resources,
    };
  return { title: [document.createTextNode(`Allow ${r.action}?`)], command: null, list: r.resources };
}

function dockHead(children: Array<Node | null>, count: number, trailing: Node | null = null): HTMLElement {
  return h(
    "div",
    { className: "dock-head" },
    ...nonNull(children),
    count > 1 ? h("span", { className: "dock-count" }, `1 of ${count}`) : null,
    h(
      "button",
      {
        className: "ico small",
        title: dockCollapsed ? "Expand" : "Collapse",
        "aria-label": dockCollapsed ? "Expand the request" : "Collapse the request",
        "aria-expanded": String(!dockCollapsed),
        "data-key": "dock-collapse",
        "data-testid": "dock-collapse",
        onclick: () => {
          dockCollapsed = !dockCollapsed;
          renderDock(true);
        },
      },
      icon("chev"),
    ),
    trailing,
  );
}

function permissionDock(item: PermItem, count: number): HTMLElement {
  const r = item.request;
  const sending = item.status === "sending";
  const ask = permissionAsk(r);
  const respond = (decision: "once" | "always" | "reject", message?: string) => {
    if (sending) return;
    dockTell.delete(r.id);
    send(
      message
        ? { type: "respondPermission", requestId: r.id, decision, message }
        : { type: "respondPermission", requestId: r.id, decision },
    );
  };
  const head = dockHead([h("b", { className: "dock-title", dir: "auto" }, ...ask.title)], count);
  const parts: Array<Node | null> = [head];
  if (!dockCollapsed) {
    parts.push(fromSubagentTag(r.sessionID));
    if (ask.command) parts.push(h("pre", { className: "cmd", dir: "ltr" }, ask.command));
    if (ask.list.length)
      parts.push(h("ul", { className: "resources" }, ...ask.list.map((x) => h("li", {}, h("code", {}, x)))));
    if (r.message) parts.push(h("div", { className: "dock-desc", dir: "auto" }, r.message));
    if (item.sensitive.length)
      parts.push(
        h(
          "div",
          { className: "sensitive", role: "note" },
          h("strong", {}, "⚠ Sensitive path"),
          h("ul", {}, ...item.sensitive.map((x) => h("li", {}, x))),
        ),
      );
    const options: Array<{ key: string; label: Node[]; act: () => void; testid: string }> = [
      {
        key: "once",
        label: [document.createTextNode("Yes")],
        act: () => respond("once"),
        testid: "perm-once",
      },
    ];
    if (r.canAlways) {
      const pats = (r.patterns ?? []).filter((p) => p && p !== "*");
      options.push({
        key: "always",
        label: pats.length
          ? [document.createTextNode("Yes, always allow "), h("code", {}, pats.join(", "))]
          : [document.createTextNode("Yes, always allow this")],
        act: () => respond("always"),
        testid: "perm-always",
      });
    }
    options.push({
      key: "reject",
      label: [document.createTextNode("No")],
      act: () => respond("reject"),
      testid: "perm-deny",
    });
    options.forEach((o, i) =>
      parts.push(
        h(
          "button",
          {
            className: "opt-row" + (i === 0 ? " sel" : ""),
            "data-key": `perm:${o.key}`,
            "data-testid": o.testid,
            disabled: sending,
            onclick: o.act,
          },
          h("span", { className: "n" }, String(i + 1)),
          h("b", {}, ...o.label),
        ),
      ),
    );
    const tell = h("input", {
      className: "tell",
      type: "text",
      placeholder: "Tell the agent what to do instead",
      "aria-label": "Tell the agent what to do instead (rejects the request)",
      "data-key": "perm:tell",
      "data-testid": "perm-tell",
      disabled: sending,
    }) as HTMLInputElement;
    tell.value = dockTell.get(r.id) ?? "";
    tell.addEventListener("input", () => dockTell.set(r.id, tell.value));
    tell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && tell.value.trim()) {
        e.preventDefault();
        respond("reject", tell.value.trim());
      }
    });
    parts.push(tell, h("div", { className: "esc" }, sending ? "Sending…" : "Esc to cancel"));
    const keys = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          dockEl.querySelector<HTMLElement>(".opt-row")?.focus();
        }
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) {
        e.preventDefault();
        options[n - 1].act();
      } else if (e.key === "Escape") {
        e.preventDefault();
        respond("reject");
      }
    };
    return h(
      "div",
      {
        className: "dock",
        role: "alertdialog",
        "aria-label": "Permission request",
        "data-testid": "permission-dock",
        onkeydown: keys as (ev: Event) => void,
      },
      ...nonNull(parts),
    );
  }
  return h(
    "div",
    {
      className: "dock collapsed",
      role: "alertdialog",
      "aria-label": "Permission request",
      "data-testid": "permission-dock",
    },
    head,
  );
}

/** Choice fields a question can be answered with: radios, checkboxes, yes/no. */
function choicesOf(field: FormField): Array<{ value: string; label: string; description?: string }> | null {
  if (field.type === "boolean")
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  if (field.type === "multiselect") return field.options;
  if (field.type === "string" && field.options?.length) return field.options;
  return null;
}

function answered(field: FormField, v: FormAnswer[string] | undefined): boolean {
  if (field.type === "external") return true;
  if (v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function questionDock(item: FormItem, count: number): HTMLElement {
  const form = item.form;
  const sending = item.status === "sending";
  const answers: FormAnswer = { ...(formDrafts.get(form.id) ?? {}) };
  for (const f of form.fields) {
    const d = fieldValue(f, answers);
    if (f.type !== "external" && answers[f.key] === undefined && d !== undefined) answers[f.key] = d;
  }
  const fields = form.fields.filter((f) => !(f.type !== "external" && f.hidden) && fieldActive(f, answers));
  const tab = Math.min(dockTab.get(form.id) ?? 0, Math.max(0, fields.length - 1));
  const field = fields[tab];
  const update = (key: string, v: FormAnswer[string] | undefined, advance = false) => {
    const d = { ...(formDrafts.get(form.id) ?? {}) };
    if (v === undefined) delete d[key];
    else d[key] = v;
    formDrafts.set(form.id, d);
    if (advance && tab < fields.length - 1) dockTab.set(form.id, tab + 1);
    renderDock(true);
  };
  const needed = (f: FormField) =>
    f.type !== "external" && (choicesOf(f) !== null || (f as { required?: boolean }).required === true);
  const ready = !sending && fields.every((f) => !needed(f) || answered(f, answers[f.key]));
  const submit = () => {
    if (!ready) return;
    formErrors.delete(form.id);
    const out: FormAnswer = {};
    for (const f of fields)
      if (f.type !== "external" && answers[f.key] !== undefined) out[f.key] = answers[f.key];
    send({ type: "answerForm", formId: form.id, answer: out });
  };
  const cancel = () => {
    if (!sending) send({ type: "cancelForm", formId: form.id });
  };
  const tabs = h(
    "div",
    { className: "tabs", role: "tablist" },
    ...fields.map((f, i) =>
      h(
        "button",
        {
          className: "tab" + (i === tab ? " on" : ""),
          role: "tab",
          "aria-selected": String(i === tab),
          "data-key": `tab:${i}`,
          "data-testid": "question-tab",
          onclick: () => {
            dockTab.set(form.id, i);
            renderDock(true);
          },
        },
        f.title ?? (f.type === "external" ? "Link" : f.key),
        answered(f, answers[f.key]) && i !== tab ? " ✓" : "",
      ),
    ),
  );
  const head = dockHead(
    [tabs, h("span", { className: "grow" })],
    count,
    h(
      "button",
      {
        className: "ico small",
        title: "Cancel",
        "aria-label": "Cancel the question",
        "data-key": "dock-cancel",
        "data-testid": "form-cancel",
        onclick: cancel,
      },
      icon("close"),
    ),
  );
  if (dockCollapsed)
    return h(
      "div",
      {
        className: "dock collapsed",
        role: "dialog",
        "aria-label": form.title,
        "data-testid": "question-dock",
      },
      head,
    );

  const parts: Array<Node | null> = [head, fromSubagentTag(form.sessionID)];
  const choices: Array<{ act: () => void }> = [];
  if (field) {
    parts.push(
      h(
        "b",
        { className: "q", dir: "auto", id: `q-${form.id}` },
        field.description ?? field.title ?? field.key,
      ),
    );
    const opts = choicesOf(field);
    if (field.type === "external") {
      parts.push(
        h(
          "button",
          { className: "opt-row", onclick: () => send({ type: "openLink", href: field.url }) },
          h("b", {}, `Open ${field.title ?? "link"}`),
        ),
      );
    } else if (opts) {
      const multi = field.type === "multiselect";
      const value = answers[field.key];
      const otherKey = `${form.id}:${field.key}`;
      const custom = "custom" in field && field.custom;
      const isOther =
        custom &&
        (dockOther.has(otherKey) ||
          (typeof value === "string" && value !== "" && !opts.some((o) => o.value === value)));
      const chosen = (v: string) =>
        multi
          ? Array.isArray(value) && value.includes(v)
          : field.type === "boolean"
            ? String(value) === v
            : value === v && !isOther;
      const pickValue = (v: string) => {
        dockOther.delete(otherKey);
        if (multi) {
          const set = new Set(Array.isArray(value) ? value : []);
          if (set.has(v)) set.delete(v);
          else set.add(v);
          update(field.key, [...set]);
        } else update(field.key, field.type === "boolean" ? v === "true" : v, true);
      };
      const rows = opts.map((o, i) => {
        const on = chosen(o.value);
        const act = () => pickValue(o.value);
        choices.push({ act });
        return h(
          "button",
          {
            className: "q-opt" + (on ? " sel" : ""),
            role: multi ? "checkbox" : "radio",
            "aria-checked": String(on),
            "data-key": `opt:${field.key}:${i}`,
            "data-testid": "form-option",
            disabled: sending,
            onclick: act,
          },
          h("span", { className: "rc" + (multi ? " box" : "") + (on ? " on" : ""), "aria-hidden": "true" }),
          h(
            "span",
            { className: "q-text" },
            h("span", { className: "l", dir: "auto" }, o.label),
            o.description ? h("span", { className: "dsc", dir: "auto" }, o.description) : null,
          ),
          h("span", { className: "n", "aria-hidden": "true" }, String(i + 1)),
        );
      });
      if (custom && !multi) {
        const act = () => {
          dockOther.add(otherKey);
          update(field.key, typeof value === "string" && isOther ? value : undefined);
          dockEl.querySelector<HTMLInputElement>('[data-key="other"]')?.focus();
        };
        choices.push({ act });
        rows.push(
          h(
            "button",
            {
              className: "q-opt" + (isOther ? " sel" : ""),
              role: "radio",
              "aria-checked": String(!!isOther),
              "data-key": `opt:${field.key}:other`,
              "data-testid": "form-option-other",
              disabled: sending,
              onclick: act,
            },
            h("span", { className: "rc" + (isOther ? " on" : ""), "aria-hidden": "true" }),
            h("span", { className: "q-text" }, h("span", { className: "l" }, "Other")),
            h("span", { className: "n", "aria-hidden": "true" }, String(rows.length + 1)),
          ),
        );
      }
      parts.push(
        h(
          "div",
          { className: "q-opts", role: multi ? "group" : "radiogroup", "aria-labelledby": `q-${form.id}` },
          ...rows,
        ),
      );
      if (isOther) {
        const other = h("input", {
          className: "tell",
          type: "text",
          placeholder: "Your answer",
          "aria-label": "Other answer",
          "data-key": "other",
          "data-testid": "form-other",
          disabled: sending,
        }) as HTMLInputElement;
        other.value = typeof value === "string" ? value : "";
        other.addEventListener("input", () => {
          const d = { ...(formDrafts.get(form.id) ?? {}) };
          if (other.value) d[field.key] = other.value;
          else delete d[field.key];
          formDrafts.set(form.id, d);
          dockSignature = "";
          refreshSubmit();
        });
        other.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            renderDock(true);
            if (tab < fields.length - 1) {
              dockTab.set(form.id, tab + 1);
              renderDock(true);
            } else submitBtn.click();
          }
        });
        parts.push(other);
      }
    } else {
      const numeric = field.type === "number" || field.type === "integer";
      const inp = h("input", {
        className: "tell",
        type: numeric ? "number" : "text",
        placeholder: field.type === "string" ? (field.placeholder ?? "Your answer") : "",
        "aria-labelledby": `q-${form.id}`,
        "data-key": `field:${field.key}`,
        "data-testid": "form-input",
        disabled: sending,
      }) as HTMLInputElement;
      const v = answers[field.key];
      if (v !== undefined) inp.value = String(v);
      inp.addEventListener("input", () => {
        const d = { ...(formDrafts.get(form.id) ?? {}) };
        if (inp.value === "") delete d[field.key];
        else d[field.key] = numeric ? Number(inp.value) : inp.value;
        formDrafts.set(form.id, d);
        dockSignature = "";
        refreshSubmit();
      });
      parts.push(inp);
    }
  }
  const error = formErrors.get(form.id);
  if (error) parts.push(h("div", { className: "error-text small", role: "alert" }, error));
  const submitBtn = h(
    "button",
    {
      className: "submit" + (ready ? " ready" : ""),
      "data-key": "submit",
      "data-testid": "form-submit",
      "aria-disabled": String(!ready),
      onclick: submit,
    },
    sending ? "Sending…" : "Submit answers",
  );
  // Text answers update the button without rebuilding the dock (keeps the caret).
  const refreshSubmit = () => {
    const d = formDrafts.get(form.id) ?? {};
    const ok = !sending && fields.every((f) => !needed(f) || answered(f, d[f.key] ?? answers[f.key]));
    submitBtn.classList.toggle("ready", ok);
    submitBtn.setAttribute("aria-disabled", String(!ok));
  };
  parts.push(submitBtn, h("div", { className: "esc" }, "Esc to cancel"));
  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= choices.length) {
      e.preventDefault();
      choices[n - 1].act();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && fields.length > 1) {
      e.preventDefault();
      dockTab.set(form.id, Math.max(0, Math.min(fields.length - 1, tab + (e.key === "ArrowRight" ? 1 : -1))));
      renderDock(true);
    }
  };
  return h(
    "div",
    {
      className: "dock",
      role: "dialog",
      "aria-label": form.title,
      "data-testid": "question-dock",
      onkeydown: keys as (ev: Event) => void,
    },
    ...nonNull(parts),
  );
}

/** Shows the first waiting request in place of the message box (or the box again). */
function renderDock(force = false): void {
  const reqs = pendingRequests();
  const req = reqs[0];
  const sig = JSON.stringify([
    req?.id,
    req?.status,
    reqs.length,
    dockCollapsed,
    req?.kind === "form"
      ? [formDrafts.get(req.form.id), formErrors.get(req.form.id), dockTab.get(req.form.id)]
      : null,
    state?.subagents.map((v) => [v.sessionID, v.agent, v.title]),
    state?.locale,
  ]);
  if (!force && sig === dockSignature) return;
  dockSignature = sig;
  boxEl.hidden = !!req;
  dockEl.hidden = !req;
  if (!req) {
    if (dockEl.dataset.req) {
      delete dockEl.dataset.req;
      dockEl.replaceChildren();
      dockCollapsed = false;
      if (!input.disabled) input.focus();
    }
    return;
  }
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && dockEl.contains(active) ? active.dataset.key : undefined;
  const fresh = dockEl.dataset.req !== req.id;
  if (fresh) dockCollapsed = false;
  dockEl.dataset.req = req.id;
  dockEl.replaceChildren(
    req.kind === "permission" ? permissionDock(req, reqs.length) : questionDock(req, reqs.length),
  );
  const target =
    (focusKey &&
      Array.from(dockEl.querySelectorAll<HTMLElement>("[data-key]")).find(
        (n) => n.dataset.key === focusKey,
      )) ||
    (fresh ? dockEl.querySelector<HTMLElement>(".opt-row.sel, .q-opt.sel, .q-opt, .opt-row, input") : null);
  target?.focus();
}

/** Timeline row for a permission: waiting, or how it was answered. */
function renderPermissionRow(item: PermItem): HTMLElement {
  const r = item.request;
  const first = r.resources[0];
  return h(
    "div",
    { className: "tool tool-request", "data-testid": "permission-row" },
    h(
      "div",
      { className: "th" },
      h("span", { className: "tool-name" }, "Permission"),
      h(
        "span",
        { className: "desc mono", dir: "auto" },
        `${r.action}${first ? `: ${first}` : ""}${r.resources.length > 1 ? ` +${r.resources.length - 1}` : ""}`,
      ),
    ),
    h(
      "div",
      { className: "tool-sub", "data-testid": "permission-status" },
      item.status === "pending"
        ? "Waiting for your answer below"
        : (PERMISSION_DONE[item.status] ?? item.status),
      item.feedback ? ` · told the agent: “${item.feedback}”` : "",
    ),
  );
}

/** Timeline row for a question: waiting, or a card of the answers once answered. */
function renderFormRow(item: FormItem): HTMLElement {
  const form = item.form;
  const fields = form.fields.filter((f) => f.type !== "external" && !f.hidden);
  const n = fields.length;
  const status =
    item.status === "answered"
      ? `Answered · ${n} question${n === 1 ? "" : "s"}`
      : item.status === "cancelled"
        ? "Cancelled"
        : item.status === "expired"
          ? "Question expired"
          : item.status === "sending"
            ? "Sending…"
            : "Waiting for your answer below";
  const head = [
    h("span", { className: "tool-name" }, "Question"),
    h("span", { className: "desc", "data-testid": "form-status" }, status),
  ];
  if (item.status !== "answered" || !item.answer)
    return h(
      "div",
      { className: "tool tool-request", "data-testid": "form-card" },
      h("div", { className: "th" }, ...head),
    );
  const answer = item.answer;
  const card = h(
    "div",
    { className: "qcard" },
    ...fields.map((f) => {
      const v = answer[f.key];
      const opts = choicesOf(f);
      const picked = (x: string) => (Array.isArray(v) ? v.includes(x) : String(v) === x);
      const custom = typeof v === "string" && opts && !opts.some((o) => o.value === v) ? v : null;
      return h(
        "div",
        { className: "qa" },
        h("div", { className: "q", dir: "auto" }, f.description ?? f.title ?? f.key),
        ...(opts
          ? [
              ...opts.map((o) =>
                h(
                  "div",
                  { className: "radio" + (picked(o.value) ? "" : " off") },
                  h("span", { className: "rc" + (picked(o.value) ? " on" : ""), "aria-hidden": "true" }),
                  h(
                    "span",
                    { className: "l", dir: "auto" },
                    o.label,
                    picked(o.value) ? h("span", { className: "sr-only" }, " (chosen)") : null,
                  ),
                ),
              ),
              ...(custom
                ? [
                    h(
                      "div",
                      { className: "radio" },
                      h("span", { className: "rc on", "aria-hidden": "true" }),
                      h("span", { className: "l", dir: "auto" }, custom),
                    ),
                  ]
                : []),
            ]
          : [
              h(
                "div",
                { className: "a", dir: "auto" },
                v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : String(v),
              ),
            ]),
      );
    }),
  );
  return h(
    "div",
    { className: "tool tool-request", "data-testid": "form-card" },
    details(item.id, head, [card], "tool-fold"),
  );
}

// ------------------------------------------------------------- item views

function renderItem(item: TranscriptItem): HTMLElement {
  switch (item.kind) {
    case "user":
      return renderPrompt(item);
    case "assistant":
      return h(
        "div",
        { className: "msg assistant" + (item.streaming ? " streaming" : ""), "data-testid": "assistant" },
        h("div", { className: "msg-body" }, ...renderBlocks(parseMarkdown(item.text), item.id)),
        isFinalAnswer(item) ? answerActions(item) : null,
      );
    case "reasoning": {
      // "Thought for 9s" when OpenCode reported both ends; history from before times existed says "Thought".
      const label = item.streaming
        ? "Thinking…"
        : item.started !== undefined && item.ended !== undefined && item.ended >= item.started
          ? `Thought for ${formatThought(item.ended - item.started)}`
          : "Thought";
      return details(
        item.id,
        [h("span", { className: "thought-label", "data-testid": "thought" }, label)],
        [h("div", { className: "reasoning", dir: "auto" }, item.text)],
        "thought",
      );
    }
    case "tool":
      return item.category === "agent" ? renderSubagentCard(item) : renderTool(item);
    case "permission":
      return renderPermissionRow(item);
    case "handback":
      return renderHandback(item);
    case "turn-summary": {
      const c = changeCounts(item.files);
      return h(
        "div",
        { className: "turn-summary" },
        h(
          "div",
          {},
          h("strong", {}, `Edited ${item.files.length} file${item.files.length === 1 ? "" : "s"}`),
          " ",
          h("span", { className: "adds" }, `+${c.add}`),
          " / ",
          h("span", { className: "dels" }, `−${c.del}`),
        ),
        fileList(item.files, "openAgentDiff"),
      );
    }
    case "notice":
      return h(
        "div",
        {
          className: `notice ${item.level}`,
          role: item.level === "error" ? "alert" : undefined,
          dir: "auto",
        },
        item.text,
      );
    case "form":
      return renderFormRow(item);
    case "error":
      return h(
        "div",
        { className: "error-card", role: "alert", "data-testid": "error-card" },
        h("div", { className: "error-title", dir: "auto" }, item.title),
        item.detail
          ? h(
              "div",
              {
                className: "small muted",
                title: "Technical details are in the Sidecar output channel",
              },
              item.detail,
            )
          : null,
        item.actions.length
          ? h(
              "div",
              { className: "actions" },
              ...item.actions.map((a) =>
                a === "changeModel"
                  ? h(
                      "button",
                      { className: "btn", onclick: () => send({ type: "focusModelPicker" }) },
                      t("changeModel"),
                    )
                  : h(
                      "button",
                      {
                        className: "btn",
                        disabled: !!state?.busy,
                        onclick: () => send({ type: "retryLast" }),
                      },
                      t("retry"),
                    ),
              ),
            )
          : null,
      );
    case "budget": {
      const stopped = item.state === "stopped";
      const resolvedText =
        item.resolved === "continued"
          ? "Continued once."
          : item.resolved === "increased"
            ? "Budget increased; continued."
            : item.resolved === "new-session"
              ? "Started a new session."
              : null;
      const act = (action: "continue" | "increase" | "newSession") =>
        send({ type: "budgetAction", itemId: item.id, action });
      return h(
        "div",
        {
          className: `budget-card budget-${item.state}`,
          role: stopped ? "alert" : "status",
          "data-testid": `budget-${item.state}`,
        },
        h("div", { dir: "auto" }, h("strong", {}, stopped ? "⛔ " : "⚠ "), item.text),
        stopped && !item.resolved
          ? h(
              "div",
              { className: "actions" },
              h(
                "button",
                {
                  className: "btn primary",
                  "data-testid": "budget-continue",
                  disabled: !!state?.busy,
                  onclick: () => act("continue"),
                },
                t("continueOnce"),
              ),
              h(
                "button",
                {
                  className: "btn",
                  "data-testid": "budget-increase",
                  disabled: !!state?.busy,
                  onclick: () => act("increase"),
                },
                t("increaseBudget"),
              ),
              h(
                "button",
                { className: "btn", "data-testid": "budget-new", onclick: () => act("newSession") },
                t("newSession"),
              ),
            )
          : resolvedText
            ? h("div", { className: "small muted" }, resolvedText)
            : null,
      );
    }
  }
}

// ----------------------------------------------------------------- prompts
//
// A prompt sits in a bubble at the head of its turn. Long prompts show two lines
// that fade out and open on click. ↺ rewinds the session to just before it. With
// the `stickyPrompt` setting, the prompt of the turn being read stays pinned.

function renderPrompt(item: Extract<TranscriptItem, { kind: "user" }>): HTMLElement {
  const key = `${item.id}:open`;
  const open = openDetails.has(key);
  const messageID = item.id.replace(/^user:/, "");
  const busy = !!state?.busy;
  const toggle = () => {
    if (!bubble.classList.contains("long")) return;
    if (openDetails.has(key)) openDetails.delete(key);
    else openDetails.add(key);
    bubble.classList.toggle("open", openDetails.has(key));
    bubble.setAttribute("aria-expanded", String(openDetails.has(key)));
  };
  const bubble = h(
    "div",
    {
      className: "bubble" + (open ? " open long" : ""),
      "data-testid": "prompt",
      "data-key": key,
      onclick: (e: Event) => {
        if ((e.target as Element).closest("button, a")) return;
        toggle();
      },
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if ((k === "Enter" || k === " ") && e.target === bubble && bubble.classList.contains("long")) {
          e.preventDefault();
          toggle();
        }
      },
    },
    item.attachments.length
      ? h(
          "div",
          { className: "chips" },
          ...item.attachments.map((a) =>
            h(
              "span",
              { className: "chip static", "data-tip": a },
              icon(IMAGE_NAME.test(a) ? "image" : /:\d/.test(a) ? "selection" : "file"),
              h("span", { className: "chip-label" }, a),
            ),
          ),
        )
      : null,
    h("div", { className: "btxt", dir: "auto" }, item.text),
    subView
      ? null
      : h(
          "span",
          { className: "pacts" },
          h(
            "button",
            {
              className: "rw",
              "data-tip": "Fork from here: a new session with the conversation before this prompt",
              "aria-label": "Fork the conversation from before this prompt",
              "data-testid": "fork",
              onclick: () => send({ type: "forkSession", messageID }),
            },
            icon("fork"),
          ),
          h(
            "button",
            {
              className: "rw",
              "data-tip": busy ? "Stop the task to rewind" : "Rewind to before this prompt",
              "aria-label": "Rewind to before this prompt",
              "data-testid": "rewind",
              disabled: busy,
              onclick: () => void confirmRewind(messageID),
            },
            icon("rewind"),
          ),
        ),
  );
  if (open) bubble.setAttribute("aria-expanded", "true");
  return bubble;
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/** Marks prompts taller than two lines as "long" (clamped, fading, click to open). */
function measurePrompts(root: ParentNode = listEl): void {
  for (const b of root.querySelectorAll<HTMLElement>(".bubble:not(.open)")) {
    const txt = b.querySelector<HTMLElement>(".btxt");
    if (!txt) continue;
    const long = txt.scrollHeight > txt.clientHeight + 1;
    b.classList.toggle("long", long);
    if (long) {
      b.tabIndex = 0;
      b.setAttribute("role", "button");
      b.setAttribute("aria-expanded", "false");
      b.title = "Show the whole prompt";
    } else {
      b.removeAttribute("tabindex");
      b.removeAttribute("role");
      b.removeAttribute("aria-expanded");
      b.removeAttribute("title");
    }
  }
}
let measureFrame = 0;
function scheduleMeasure(): void {
  if (measureFrame) return;
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    measurePrompts();
  });
}
new ResizeObserver(() => scheduleMeasure()).observe(scroller);

// ---------------------------------------------------------- answer actions

/**
 * The final answer of a turn: the last text of a finished turn in the main chat.
 * Only it gets Copy and Bookmark (intermediate messages do not).
 */
function isFinalAnswer(item: Extract<TranscriptItem, { kind: "assistant" }>): boolean {
  if (subView || !item.text.trim()) return false;
  const items = transcript.items;
  const i = transcript.indexOf(item.id);
  if (i < 0) return false;
  for (let j = i + 1; j < items.length; j++) {
    if (items[j].kind === "user") return true;
    if (items[j].kind === "assistant") return false;
  }
  // The last turn is final once the agent has stopped working.
  return !state?.busy;
}

function answerActions(item: Extract<TranscriptItem, { kind: "assistant" }>): HTMLElement {
  const key = `msg:${item.id}`;
  const fb = copyFeedback.get(key);
  const marked = !!state?.bookmarks.some(
    (b) => b.sessionID === state?.currentSession?.id && b.itemId === item.id,
  );
  return h(
    "div",
    { className: "actions answer-actions" },
    h(
      "button",
      {
        className: "ico act" + (fb === "copied" ? " done" : ""),
        title: fb === "copied" ? t("copied") : t("copyMessage"),
        "aria-label": t("copyMessage"),
        "data-testid": "copy-message",
        "data-key": key,
        onclick: () => copy(key, item.id, { kind: "message" }),
      },
      fb === "copied" ? h("span", { className: "copied-text" }, t("copied")) : icon("copy"),
    ),
    h(
      "button",
      {
        className: "ico act" + (marked ? " on" : ""),
        title: marked ? "Remove bookmark" : "Bookmark this answer",
        "aria-label": "Bookmark this answer",
        "aria-pressed": String(marked),
        "data-testid": "bookmark",
        "data-key": `bm:${item.id}`,
        onclick: () => send({ type: "toggleBookmark", itemId: item.id }),
      },
      icon("bookmark"),
    ),
    fb === "failed" ? h("span", { className: "copy-error small", role: "alert" }, t("copyFailed")) : null,
  );
}

// ---------------------------------------------------------------- timeline
//
// The conversation is a list of turns. Each turn is a prompt followed by a timeline
// of everything the agent did for it: a vertical rail with a dot per item (grey for
// text and thinking, green for finished work, pulsing accent for work in progress or
// waiting on you, error colour for failures). A date divider starts each day.

type Dot = "idle" | "ok" | "run" | "err" | "none";

const dateFormats = new Map<string, { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>();
function formats() {
  const locale = state?.locale ?? "en";
  let f = dateFormats.get(locale);
  if (!f) {
    const make = (o: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale, o);
      } catch {
        return new Intl.DateTimeFormat("en", o);
      }
    };
    f = {
      time: make({ hour: "numeric", minute: "2-digit" }),
      day: make({ weekday: "short", month: "short", day: "numeric" }),
    };
    dateFormats.set(locale, f);
  }
  return f;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function timestamp(ms: number): HTMLElement {
  const d = new Date(ms);
  return h(
    "time",
    { className: "ts", datetime: d.toISOString(), title: d.toLocaleString(state?.locale ?? "en") },
    formats().time.format(d),
  );
}

function dateDivider(ms: number): HTMLElement {
  const label = formats().day.format(new Date(ms));
  return h(
    "div",
    { className: "day", role: "separator", "aria-label": label, "data-testid": "date-divider" },
    h("span", { "aria-hidden": "true" }, label),
  );
}

/** "9s", "1m 05s": how long the model thought. */
function formatThought(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function subagentStatusOf(item: Extract<TranscriptItem, { kind: "tool" }>) {
  return subagentOf(item.detail.subagent)?.status ?? (item.status === "failed" ? "failed" : "running");
}

function dotOf(item: TranscriptItem): Dot {
  switch (item.kind) {
    case "user":
      return "none";
    case "assistant":
    case "reasoning":
      return "idle";
    case "tool": {
      if (item.category === "agent") {
        const s = subagentStatusOf(item);
        return s === "running" || s === "waiting"
          ? "run"
          : s === "completed"
            ? "ok"
            : s === "failed"
              ? "err"
              : "idle";
      }
      return item.status === "completed" ? "ok" : item.status === "failed" ? "err" : "run";
    }
    case "permission":
    case "form":
      return item.status === "pending" || item.status === "sending"
        ? "run"
        : item.status === "answered" || item.status === "once" || item.status === "always"
          ? "ok"
          : "idle";
    case "notice":
      return item.level === "error" ? "err" : "idle";
    case "error":
      return "err";
    case "budget":
    case "turn-summary":
    case "handback":
      return "none";
  }
}

/** Assistant text shows its time when it starts a block of text (after a prompt, tool or thought). */
function showsTime(
  item: TranscriptItem,
  tr: Transcript,
): item is Extract<TranscriptItem, { kind: "assistant" }> {
  if (item.kind !== "assistant" || item.time === undefined) return false;
  const prev = tr.items[tr.indexOf(item.id) - 1];
  return prev?.kind !== "assistant";
}

/** An item in its timeline frame: the prompt with its time, or a rail entry with its dot. */
function renderEntry(item: TranscriptItem, tr: Transcript): HTMLElement {
  const content = renderItem(item);
  if (item.kind === "user")
    return h(
      "div",
      { className: "prompt", "data-id": item.id },
      item.time !== undefined ? timestamp(item.time) : null,
      content,
    );
  const ts = showsTime(item, tr) ? timestamp(item.time!) : null;
  return h(
    "div",
    {
      className: `tl-item dot-${dotOf(item)}${ts ? " has-ts" : ""}`,
      "data-id": item.id,
      "data-groupable": groupable(item) ? "1" : undefined,
    },
    h("span", { className: "dot", "aria-hidden": "true" }),
    ts,
    content,
  );
}

/** Where the next entry goes: the open turn's timeline, and the day of the last divider. */
let layout: { day: string | null; timeline: HTMLElement | null } = { day: null, timeline: null };

function openTurn(head: HTMLElement | null): HTMLElement {
  const timeline = h("div", { className: "timeline" });
  listEl.append(h("section", { className: "turn" }, head, timeline));
  layout.timeline = timeline;
  return timeline;
}

/** Appends a new entry at the end of the conversation; a prompt starts a new turn. */
function place(item: TranscriptItem, el: HTMLElement) {
  if (item.kind === "user") {
    if (item.time !== undefined) {
      const day = dayKey(item.time);
      if (day !== layout.day) {
        listEl.append(dateDivider(item.time));
        layout.day = day;
      }
    }
    openTurn(el);
    return;
  }
  const timeline = layout.timeline ?? openTurn(null);
  if (state?.prefs.activity === "grouped" && groupable(item)) {
    const last = timeline.lastElementChild as HTMLElement | null;
    if (last?.classList.contains("tl-group")) {
      last.querySelector(".grp-body")!.append(el);
      updateGroup(last);
      return;
    }
    if (last?.dataset.groupable === "1") {
      const group = makeGroup(last.dataset.id ?? "");
      last.replaceWith(group);
      group.querySelector(".grp-body")!.append(last, el);
      updateGroup(group);
      return;
    }
  }
  timeline.append(el);
}

// --------------------------------------------------------- grouped activity
//
// With `activity: grouped`, a run of tool calls folds into one line
// ("Explored · 2 searches, 3 reads, 1 command ›") that opens to the calls.

function groupable(item: TranscriptItem): boolean {
  return item.kind === "tool" && item.category !== "agent";
}

function makeGroup(firstId: string): HTMLElement {
  const key = `group:${firstId}`;
  const det = h("details", { className: "grp", open: openDetails.has(key) });
  det.addEventListener("toggle", () => {
    if (det.open) openDetails.add(key);
    else openDetails.delete(key);
  });
  det.append(h("summary", {}), h("div", { className: "grp-body" }));
  return h(
    "div",
    { className: "tl-item tl-group dot-ok", "data-testid": "activity-group" },
    h("span", { className: "dot", "aria-hidden": "true" }),
    det,
  );
}

const GROUP_WORDS: Record<string, [string, string]> = {
  search: ["search", "searches"],
  read: ["read", "reads"],
  shell: ["command", "commands"],
  edit: ["edit", "edits"],
  web: ["fetch", "fetches"],
  other: ["other call", "other calls"],
};

/** Recounts a group's calls and sets its dot from their states. */
function updateGroup(group: HTMLElement): void {
  const tr = shown();
  const tools = Array.from(group.querySelectorAll<HTMLElement>(".grp-body > [data-id]"))
    .map((e) => tr.get(e.dataset.id ?? ""))
    .filter((i): i is ToolItem => i?.kind === "tool");
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const parts = ["search", "read", "shell", "edit", "web", "other"]
    .filter((c) => counts.has(c))
    .map((c) => {
      const n = counts.get(c)!;
      return `${n} ${GROUP_WORDS[c][n === 1 ? 0 : 1]}`;
    });
  const label = counts.has("edit") || counts.has("shell") ? "Worked" : "Explored";
  const dot = tools.some((t) => t.status === "running" || t.status === "pending")
    ? "run"
    : tools.some((t) => t.status === "failed")
      ? "err"
      : "ok";
  group.className = `tl-item tl-group dot-${dot}`;
  group
    .querySelector("summary")!
    .replaceChildren(
      h("span", { className: "tool-name" }, label),
      h("span", { className: "desc" }, parts.join(", ")),
    );
}

function renderItemById(id: string) {
  const tr = shown();
  const item = tr.get(id);
  if (!item) return;
  const prev = itemEls.get(id);
  // New items normally arrive at the end. If one lands before an item already on
  // screen, lay the whole conversation out again so turns stay in order.
  if (!prev && tr.items.slice(tr.indexOf(id) + 1).some((later) => itemEls.has(later.id))) {
    renderAllItems();
    return;
  }
  const el = renderEntry(item, tr);
  // Keep keyboard focus on the equivalent control when an item re-renders.
  const active = document.activeElement;
  const focusKey =
    prev && active instanceof HTMLElement && prev.contains(active) ? active.dataset.key : undefined;
  if (prev) prev.replaceWith(el);
  else place(item, el);
  itemEls.set(id, el);
  const group = el.parentElement?.closest<HTMLElement>(".tl-group");
  if (group) updateGroup(group);
  if (!prev && item.kind === "assistant") {
    for (let j = tr.indexOf(id) - 1; j >= 0; j--) {
      const before = tr.items[j];
      if (before.kind === "user") break;
      if (before.kind === "assistant") {
        if (itemEls.has(before.id)) renderItemById(before.id);
        break;
      }
    }
  }
  if (focusKey) {
    const target = Array.from(el.querySelectorAll<HTMLElement>("[data-key]")).find(
      (n) => n.dataset.key === focusKey,
    );
    target?.focus();
  }
}

function renderAllItems() {
  listEl.replaceChildren();
  itemEls.clear();
  layout = { day: null, timeline: null };
  const tr = shown();
  for (const item of tr.items) {
    const el = renderEntry(item, tr);
    place(item, el);
    itemEls.set(item.id, el);
  }
  scheduleMeasure();
  renderDock();
  applyRevert();
}

// Coalesce item re-renders to one per animation frame (streaming tokens arrive in bursts).
const dirtyItems = new Set<string>();
let frame = 0;
function scheduleItems(ids: Iterable<string>) {
  for (const id of ids) dirtyItems.add(id);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const ids = [...dirtyItems];
    dirtyItems.clear();
    for (const id of ids) renderItemById(id);
    if (ids.length && state) renderEmpty(state);
    if (ids.length) scheduleMeasure();
    renderDock();
    maybeScroll();
  });
}

// -------------------------------------------------------------- subagents

const SUBAGENT_ICON = { running: "●", waiting: "⏸", completed: "✓", failed: "✕", stopped: "■" } as const;
const SUBAGENT_STATUS = {
  running: "statusRunning",
  waiting: "statusWaiting",
  completed: "statusCompleted",
  failed: "statusFailed",
  stopped: "statusStopped",
} as const;

function subagentOf(id: string | null | undefined): SubagentView | undefined {
  return id ? state?.subagents.find((v) => v.sessionID === id) : undefined;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h2 = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h2 > 0 ? `${h2}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function agentLabel(agent: string | null | undefined): string {
  return (agent || t("subagent")).toUpperCase();
}

function activityText(v: SubagentView): string {
  if (v.status === "running") {
    const a = v.activity;
    if (!a) return t("subagentStarting");
    if (a.kind === "writing") return t("subagentWriting");
    if (a.kind === "thinking") return t("subagentThinking");
    return a.title;
  }
  if (v.status === "failed" && v.error) return v.error;
  return t(SUBAGENT_STATUS[v.status]);
}

/** "12 tools · 3 files · 0:41 · $0.02"; parts OpenCode did not report are left out. */
function subagentMeta(v: SubagentView): HTMLElement {
  const parts: Array<Node | string> = [];
  const add = (node: Node | string) => {
    if (parts.length) parts.push(" · ");
    parts.push(node);
  };
  if (v.tools !== null) add(`${v.tools} tool${v.tools === 1 ? "" : "s"}`);
  if (v.files) add(`${v.files} file${v.files === 1 ? "" : "s"}`);
  if (v.started !== null) {
    const live = v.ended === null;
    add(
      h(
        "span",
        live ? { "data-elapsed-from": String(v.started) } : {},
        formatDuration((v.ended ?? Date.now()) - v.started),
      ),
    );
  }
  if (v.cost) add(formatCost(v.cost));
  return h("div", { className: "subagent-meta muted small", "data-testid": "subagent-meta" }, ...parts);
}

/** What a waiting subagent waits for: a permission or a question raised from its session. */
function waitingText(sessionID: string): string {
  const pending = (i: TranscriptItem) =>
    (i.kind === "permission" && i.request.sessionID === sessionID && i.status === "pending") ||
    (i.kind === "form" && i.form.sessionID === sessionID && i.status === "pending");
  const item = transcript.items.find(pending) ?? subView?.transcript.items.find(pending);
  return item?.kind === "permission"
    ? t("waitingPermission")
    : item?.kind === "form"
      ? t("waitingAnswer")
      : t("statusWaiting");
}

/** "Running · Searched refreshToken(", "Finished", "Failed · <error>", … */
function subagentStatusText(item: ToolItem, v: SubagentView | undefined): string {
  if (!v)
    return item.status === "failed"
      ? `${t("statusFailed")} · ${item.detail.error ?? ""}`
      : t("subagentStarting");
  switch (v.status) {
    case "running":
      return `${t("statusRunning")} · ${activityText(v)}`;
    case "waiting":
      return waitingText(v.sessionID);
    case "completed":
      return t("subagentFinished");
    case "failed":
      return v.error ? `${t("statusFailed")} · ${v.error}` : t("statusFailed");
    case "stopped":
      return t("statusStopped");
  }
}

function inlineLink(label: string, attrs: Attrs, onActivate: () => void): HTMLElement {
  return h(
    "a",
    {
      ...attrs,
      href: "#",
      className: "ag-link",
      onclick: (e: Event) => {
        e.preventDefault();
        onActivate();
      },
    },
    label,
  );
}

/**
 * A subagent call: "Agent:" and its task, the exact prompt in an IN box (one line,
 * click to expand), and a status line with its progress, Stop and Open ›.
 */
function renderSubagentCard(item: ToolItem): HTMLElement {
  const v = subagentOf(item.detail.subagent);
  const fact = (k: string) => item.detail.facts.find(([key]) => key === k)?.[1] ?? null;
  const status = subagentStatusOf(item);
  const description = fact("description") ?? v?.title ?? item.title;
  const agent = v?.agent ?? fact("agent");
  const prompt = item.detail.prompt ?? fact("prompt");
  const parts: Array<Node | null> = [
    h(
      "div",
      { className: "th" },
      h("span", { className: "tool-name" }, "Agent:"),
      h("span", { className: "desc mono", dir: "auto", "data-testid": "subagent-title" }, description),
      agent ? h("span", { className: "desc", "data-testid": "subagent-agent" }, agent.toLowerCase()) : null,
    ),
  ];
  if (prompt) parts.push(h("div", { className: "io" }, ioRow("IN", ioValue(item.id, "prompt", prompt))));
  const active = v?.status === "running" || v?.status === "waiting";
  const meta: string[] = [];
  if (v?.tools != null) meta.push(`${v.tools} tool${v.tools === 1 ? "" : "s"}`);
  if (v?.files) meta.push(`${v.files} file${v.files === 1 ? "" : "s"}`);
  const metaEl =
    v && (meta.length || v.started !== null)
      ? h(
          "span",
          { "data-testid": "subagent-meta", title: v.cost ? `Cost ${formatCost(v.cost)}` : undefined },
          meta.length ? ` · ${meta.join(" · ")}` : "",
          v.started !== null ? " · " : "",
          v.started !== null
            ? h(
                "span",
                v.ended === null ? { "data-elapsed-from": String(v.started) } : {},
                formatDuration((v.ended ?? Date.now()) - v.started),
              )
            : null,
        )
      : null;
  parts.push(
    h(
      "div",
      { className: `ag-status ag-${status}`, "data-testid": "subagent-status" },
      h("span", { className: "d", "aria-hidden": "true" }),
      h(
        "span",
        { className: "ag-line" },
        h("span", { "data-testid": "subagent-activity", dir: "auto" }, subagentStatusText(item, v)),
        metaEl,
      ),
      v && active
        ? inlineLink(
            t("stopSubagent"),
            {
              "data-testid": "subagent-stop",
              "data-key": `stop:${v.sessionID}`,
              title: "Stop this subagent; the rest of the task continues",
            },
            () => send({ type: "stopSubagent", sessionID: v.sessionID }),
          )
        : null,
      v
        ? inlineLink(
            `${t("openSubagent")} ›`,
            {
              "data-testid": "subagent-open",
              "data-key": `open:${v.sessionID}`,
              "aria-label": `${t("openSubagent")}: ${description}`,
            },
            () => send({ type: "openSubagent", sessionID: v.sessionID }),
          )
        : null,
    ),
  );
  return h(
    "div",
    {
      className: `tool tool-agent subagent-${status}`,
      role: "group",
      "aria-label": `${t("subagent")} ${agent ?? ""}: ${description}`,
      "data-testid": "subagent-card",
    },
    ...parts,
  );
}

/** A subagent's report back: one muted italic line that expands to the whole report. */
function renderHandback(item: Extract<TranscriptItem, { kind: "handback" }>): HTMLElement {
  const who = (item.agent ?? t("subagent")).toLowerCase();
  // The one-line summary is plain text: drop heading marks, emphasis and code ticks.
  const first = (item.report.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^\s*(#+|[-*]|\d+\.)\s+/, "")
    .replace(/(\*\*|__|`)/g, "");
  const line = `${t("reportFrom")} ${who}${item.description ? ` · ${item.description}` : ""}: ${first}`;
  const childID = item.childID;
  const body: Node[] = [
    h("div", { className: "msg hb-report" }, ...renderBlocks(parseMarkdown(item.report), item.id)),
  ];
  if (childID)
    body.push(
      inlineLink(`${t("openSubagent")} ›`, { "data-testid": "handback-open" }, () =>
        send({ type: "openSubagent", sessionID: childID }),
      ),
    );
  return details(
    item.id,
    [h("span", { className: "hb-line", dir: "auto", "data-testid": "handback" }, line)],
    body,
    "handback",
  );
}

/** Small "From subagent EXPLORE" line on requests raised by a subagent. */
function fromSubagentTag(sessionID: string): HTMLElement | null {
  if (!state || sessionID === state.currentSession?.id || subView?.id === sessionID) return null;
  const v = subagentOf(sessionID);
  if (!v) return null;
  return h(
    "div",
    { className: "from-subagent small", "data-testid": "from-subagent" },
    `${t("fromSubagent")} `,
    h("span", { className: "subagent-agent" }, agentLabel(v.agent)),
    v.title ? h("span", { className: "muted", dir: "auto" }, ` ${v.title}`) : null,
    " ",
    h(
      "button",
      { className: "link-btn", onclick: () => send({ type: "openSubagent", sessionID }) },
      `${t("openSubagent")} ›`,
    ),
  );
}

/** Follows the host's `viewingSubagent`: switches the conversation area between transcripts. */
function syncSubagentView(s: ViewState) {
  const id = s.viewingSubagent?.id ?? null;
  if (id === (subView?.id ?? null)) return;
  // A new subagent's items arrive as `subagentTranscript`; until then it is empty (loading).
  subView = id ? { id, transcript: new Transcript() } : null;
  renderAllItems();
  renderEmpty(s);
  stickToBottom = true;
  maybeScroll();
}

/** Breadcrumb and live status above a subagent's conversation. */
function renderSubHeader() {
  const v = subView ? subagentOf(subView.id) : undefined;
  subHeaderEl.hidden = !subView;
  if (!subView) {
    subHeaderEl.replaceChildren();
    return;
  }
  // Path from the main chat down to this subagent (nested subagents have parents).
  const chain: SubagentView[] = [];
  for (let cur = v; cur; cur = subagentOf(cur.parentID)) chain.unshift(cur);
  const crumbs: Node[] = [
    h(
      "button",
      {
        className: "link-btn crumb",
        "data-testid": "subagent-back",
        "data-key": "crumb:root",
        onclick: () => {
          send({ type: "closeSubagent" });
        },
      },
      `‹ ${t("backToChat")}`,
    ),
  ];
  for (const c of chain.slice(0, -1)) {
    crumbs.push(
      h("span", { className: "muted", "aria-hidden": "true" }, " / "),
      h(
        "button",
        {
          className: "link-btn crumb",
          "data-key": `crumb:${c.sessionID}`,
          onclick: () => send({ type: "openSubagent", sessionID: c.sessionID }),
        },
        agentLabel(c.agent),
      ),
    );
  }
  const status = v?.status ?? "running";
  subHeaderEl.replaceChildren(
    ...nonNull([
      h("nav", { className: "crumbs", "aria-label": "Subagent path" }, ...crumbs),
      h(
        "div",
        { className: "subagent-head" },
        h("span", { className: `icon subagent-icon subagent-${status}` }, SUBAGENT_ICON[status]),
        h("span", { className: "subagent-agent" }, agentLabel(v?.agent)),
        h(
          "span",
          { className: "subagent-title", dir: "auto", "data-testid": "subagent-view-title" },
          v?.title || t("subagent"),
        ),
      ),
      v
        ? h(
            "div",
            { className: "row subagent-view-status" },
            h("span", { className: `subagent-activity subagent-${status}` }, activityText(v)),
            subagentMeta(v),
            v.status === "running" || v.status === "waiting"
              ? h(
                  "button",
                  {
                    className: "btn subtle small",
                    "data-key": "view-stop",
                    onclick: () => send({ type: "stopSubagent", sessionID: v.sessionID }),
                  },
                  t("stopSubagent"),
                )
              : null,
          )
        : null,
    ]),
  );
}

// ---------------------------------------------------------- changes panel

function renderChanges(s: ViewState) {
  const ac = s.agentChanges;
  const ws = s.workspaceChanges;
  // An agent-only diff that OpenCode could not provide (no snapshots, such as in a folder
  // that is not a git repository) is not a strip of its own: there is nothing to open.
  // When workspace changes are shown instead, their line says why.
  const showAgent = ac.status === "ok";
  const showWs = !!ws && ws.count > 0 && s.connection.kind === "connected";
  if (!showAgent && !showWs) {
    changesEl.replaceChildren();
    changesEl.hidden = true;
    return;
  }
  changesEl.hidden = false;
  const parts: Array<Node | null> = [];
  if (ac.status === "ok") {
    const c = changeCounts(ac.files);
    parts.push(
      h(
        "div",
        { className: "row" },
        h(
          "button",
          {
            className: "link-btn changes-toggle",
            "aria-expanded": String(changesOpen),
            "data-testid": "agent-changes-toggle",
            onclick: () => {
              changesOpen = !changesOpen;
              render();
            },
          },
          `${changesOpen ? "▾" : "▸"} ${t("agentChanges")} · ${ac.files.length} file${ac.files.length === 1 ? "" : "s"}`,
        ),
        h("span", { className: "adds" }, `+${c.add}`),
        h("span", { className: "dels" }, `−${c.del}`),
        h(
          "button",
          {
            className: "btn subtle small",
            "data-testid": "view-agent-changes",
            onclick: () => send({ type: "openAgentDiffAll" }),
            title: "Changes recorded by OpenCode's session snapshots, shown in VS Code's diff editor",
          },
          t("viewAgentChanges"),
        ),
      ),
      changesOpen ? fileList(ac.files, "openAgentDiff") : null,
    );
  }
  if (showWs && ws) {
    const why = ac.status === "unavailable" ? `${t("agentDiffUnavailable")}: ${ac.reason}` : undefined;
    parts.push(
      h(
        "div",
        { className: "row small" },
        h(
          "span",
          { className: "muted", "data-testid": "workspace-changes", title: why },
          `${t("workspaceChanges")}: ${ws.count} file${ws.count === 1 ? "" : "s"} (HEAD ↔ working tree)`,
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "data-testid": "view-workspace-changes",
            onclick: () => send({ type: "openWorkspaceDiffAll" }),
          },
          "View",
        ),
      ),
    );
  }
  changesEl.replaceChildren(...nonNull(parts));
}

// ---------------------------------------------------------------- pending

function renderPending(s: ViewState) {
  if (!s.pending.length) {
    pendingEl.replaceChildren();
    pendingEl.hidden = true;
    return;
  }
  pendingEl.hidden = false;
  pendingEl.replaceChildren(
    ...s.pending.map((p) =>
      h(
        "div",
        { className: `pending-item pending-${p.delivery}`, "data-testid": "pending-item" },
        h("span", { className: "badge" }, p.delivery === "queue" ? t("queued") : t("steering")),
        h("span", { className: "pending-text", dir: "auto", title: p.text }, p.text),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": `${t("edit")}: ${p.text.slice(0, 40)}`,
            onclick: () => send({ type: "editPending", id: p.id }),
          },
          t("edit"),
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": `${t("remove")}: ${p.text.slice(0, 40)}`,
            onclick: () => send({ type: "removePending", id: p.id }),
          },
          t("remove"),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------- staged rewind

/**
 * A rewind staged in another OpenCode client (such as `/undo` in its terminal UI):
 * the messages from its boundary on are hidden, and the bar offers Restore (bring
 * them back) or Apply (remove them for good).
 */
function renderRevert(s: ViewState) {
  const r = subView ? null : s.revert;
  revertEl.hidden = !r;
  if (!r) {
    revertEl.replaceChildren();
    return;
  }
  revertEl.replaceChildren(
    icon("rewind"),
    h(
      "span",
      { className: "revert-text" },
      "Rewound in another OpenCode client",
      r.files
        ? h("span", { className: "muted" }, ` · ${r.files} file${r.files === 1 ? "" : "s"} restored`)
        : null,
    ),
    h(
      "button",
      {
        className: "btn subtle small",
        "data-tip": "Bring the hidden messages back. OpenCode may carry on with anything still queued.",
        "data-testid": "revert-restore",
        onclick: () => send({ type: "resolveRevert", action: "restore" }),
      },
      "Restore",
    ),
    h(
      "button",
      {
        className: "btn subtle small",
        "data-tip": "Remove the hidden messages from the session",
        "data-testid": "revert-apply",
        onclick: async () => {
          const pick = await confirmDialog({
            title: "Apply the rewind?",
            body: "OpenCode removes the hidden messages from the session. This can't be undone.",
            choices: [{ value: "apply", label: "Apply rewind", danger: true, testid: "revert-confirm" }],
          });
          if (pick) send({ type: "resolveRevert", action: "apply" });
        },
      },
      "Apply",
    ),
  );
}

/** Hides the turns from a staged rewind's boundary on (they stay in OpenCode until applied). */
function applyRevert(): void {
  for (const el of listEl.querySelectorAll(".reverted")) el.classList.remove("reverted");
  const id = subView ? null : state?.revert?.messageID;
  if (!id) return;
  const at =
    listEl.querySelector(`[data-id="user:${CSS.escape(id)}"]`) ??
    listEl.querySelector(`[data-id*="${CSS.escape(id)}"]`);
  let node: Element | null = at;
  while (node && node.parentElement !== listEl) node = node.parentElement;
  for (; node; node = node.nextElementSibling) node.classList.add("reverted");
}

// ---------------------------------------------------------------- composer

// ---------------------------------------------------------------- message box

function renderComposer(s: ViewState) {
  chipsEl.replaceChildren(
    ...s.attachments.map((a) =>
      h(
        "span",
        { className: "chip" + (a.kind === "image" ? " img" : ""), "data-tip": a.detail },
        a.thumb
          ? h("img", { className: "chip-thumb", src: a.thumb, alt: "" })
          : icon(a.kind === "image" ? "image" : /:\d/.test(a.label) ? "selection" : "file"),
        h("span", { className: "chip-label" }, a.label),
        a.kind === "image" ? h("span", { className: "chip-detail" }, a.detail.split(" · ")[0]) : null,
        h(
          "button",
          {
            className: "chip-x",
            "aria-label": `Remove ${a.label}`,
            onclick: () => send({ type: "removeAttachment", id: a.id }),
          },
          "×",
        ),
      ),
    ),
  );
  chipsEl.hidden = s.attachments.length === 0 || !!subView;
  // The message box works only when the chat is usable (connected, folder open, models available).
  // A subagent's conversation is read-only: messages always go to the main chat.
  const connected = s.connection.kind === "connected" && s.onboarding.stage === "ready" && !subView;
  input.disabled = !connected;
  input.placeholder = subView
    ? t("subagentReadOnly")
    : connected
      ? s.busy
        ? delivery === "queue"
          ? "Queue another message…"
          : "Steer the agent…"
        : "Ask anything…"
      : s.onboarding.stage === "connecting" || s.onboarding.stage === "loading"
        ? "Connecting to OpenCode…"
        : "Finish the setup above to start chatting";
  boxTools.hidden = !!subView;
  boxEl.classList.toggle("active", s.busy && !subView);
  for (const b of [plusBtn, modeBtn, slashBtn]) b.disabled = !connected;
  clockBtn.hidden = !clockShown(s);
  if (clockShown(s)) {
    const until = cacheUntil(s);
    clockBtn.replaceChildren(
      icon("clock"),
      h("span", { "data-cache-until": String(until) }, cacheLabel(until)),
    );
    clockBtn.dataset.tip = cacheTip(until);
    clockBtn.setAttribute("aria-label", `${cacheTip(until)} Usage and Compact.`);
  }
  modelBtn.disabled = !connected || !(s.models ?? []).length;

  const active = s.subagents.filter((v) => v.status === "running" || v.status === "waiting").length;
  agentsBtn.replaceChildren(
    h("span", { className: "pd" + (active ? " live" : ""), "aria-hidden": "true" }),
    String(active),
    h("span", { className: "pl" }, ` agent${active === 1 ? "" : "s"}`),
  );
  const agentsLabel = `${active} subagent${active === 1 ? "" : "s"} working · ${s.subagents.length} in this session`;
  agentsBtn.dataset.tip = agentsLabel;
  agentsBtn.setAttribute("aria-label", agentsLabel);

  const model = s.models?.find((m) => m.key === s.selectedModel);
  modelBtn.replaceChildren(
    ...nonNull([
      h("span", { className: "mn" }, model?.name ?? modelPlaceholder(s)),
      model && s.selectedVariant ? h("span", { className: "v" }, ` ${s.selectedVariant}`) : null,
    ]),
  );
  const modelLabel = model
    ? `Model: ${model.name}${s.selectedVariant ? ` · variant ${s.selectedVariant}` : ""} · ${model.providerName}`
    : modelPlaceholder(s);
  modelBtn.dataset.tip = modelLabel;
  modelBtn.setAttribute("aria-label", modelLabel);

  const agent = s.agents?.find((a) => a.id === s.selectedAgent);
  modeBtn.replaceChildren(
    icon(agent?.id === "plan" ? "plan" : "mode"),
    h("span", { className: "ml" }, agent?.name ?? "Agent"),
  );
  const modeLabel = `Agent: ${agent?.name ?? "none"} (Shift+Tab to switch)`;
  modeBtn.dataset.tip = modeLabel;
  modeBtn.setAttribute("aria-label", modeLabel);

  // Send ↑ when there is text; ■ stops a running task when the box is empty.
  const empty = !input.value.trim();
  const stopMode = s.busy && empty && !subView;
  sendBtn.dataset.testid = stopMode ? "stop" : "send";
  sendBtn.replaceChildren(icon(stopMode ? "stop" : "up"));
  sendBtn.classList.toggle("idle", !stopMode && empty);
  sendBtn.disabled = stopMode ? s.stopping : !connected || s.stopping;
  const sendLabel = stopMode
    ? s.stopping
      ? "Stopping…"
      : "Stop the running task (Esc)"
    : s.busy
      ? delivery === "queue"
        ? "Queue message until the task finishes"
        : "Steer the running task"
      : "Send message (Enter)";
  sendBtn.dataset.tip = sendLabel;
  sendBtn.setAttribute("aria-label", sendLabel);
}

// ------------------------------------------------------------------ render

let lastAnnounced = "";
let bookmarkSignature = "";
let lastActivity: "detailed" | "grouped" | null = null;
let commandsSignature = "";
let lastBusy: boolean | null = null;
function render() {
  if (!state) return;
  renderHeader(state);
  renderSessions(state);
  renderBookmarks(state);
  renderEmpty(state);
  renderChanges(state);
  renderPending(state);
  renderRevert(state);
  syncSubagentView(state);
  renderSubHeader();
  renderComposer(state);
  renderWorking(state);
  renderDock();
  // A state push rebuilds the header; drop a menu whose <select> is gone.
  if (selectMenu && !selectMenu.select.isConnected) closeSelectMenu();
  // Subagent cards show live progress from the state, not from transcript events.
  const sig = JSON.stringify(state.subagents);
  if (sig !== subagentSignature) {
    subagentSignature = sig;
    // Requests name the subagent that raised them, so they depend on the same state.
    for (const item of shown().items)
      if (
        (item.kind === "tool" && item.category === "agent") ||
        item.kind === "permission" ||
        item.kind === "form"
      )
        scheduleItems([item.id]);
  }
  listEl.classList.toggle("sticky-prompts", state.prefs.stickyPrompt);
  applyRevert();
  // New commands arrived while the / menu is open: rebuild it, keeping the filter text.
  const cmdSig = JSON.stringify(state.commands);
  if (cmdSig !== commandsSignature) {
    commandsSignature = cmdSig;
    if (openMenuState?.anchor === slashBtn) {
      const q = openMenuState.el.querySelector<HTMLInputElement>(".menu-filter")?.value ?? "";
      closeMenu();
      openMenu(slashBtn, commandsMenu(), commandsMenuOptions());
      const f = openMenuState?.el.querySelector<HTMLInputElement>(".menu-filter");
      if (f && q) {
        f.value = q;
        f.dispatchEvent(new Event("input"));
      }
    }
  }
  if (lastActivity !== null && lastActivity !== state.prefs.activity) renderAllItems();
  lastActivity = state.prefs.activity;
  const bmSig = JSON.stringify([
    state.currentSession?.id,
    state.bookmarks.map((b) => [b.sessionID, b.itemId]),
  ]);
  if (bmSig !== bookmarkSignature) {
    bookmarkSignature = bmSig;
    for (const item of transcript.items) if (item.kind === "assistant") scheduleItems([item.id]);
  }
  if (lastBusy !== state.busy) {
    // Copy and rewind buttons and budget/error actions depend on the running state.
    lastBusy = state.busy;
    for (const item of transcript.items)
      if (
        item.kind === "assistant" ||
        item.kind === "budget" ||
        item.kind === "error" ||
        item.kind === "user"
      )
        scheduleItems([item.id]);
  }
  const announce = state.busy
    ? "OpenCode is working"
    : state.connection.kind === "connected"
      ? "OpenCode is idle"
      : "";
  if (announce !== lastAnnounced) {
    statusLive.textContent = announce;
    lastAnnounced = announce;
  }
}

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as HostMessage;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "state":
      state = msg.state;
      document.documentElement.lang = state.locale;
      render();
      break;
    case "transcript":
      transcript.reset(msg.items);
      renderAllItems();
      if (state) renderEmpty(state);
      stickToBottom = true;
      maybeScroll();
      break;
    case "events": {
      const changed = new Set<string>();
      for (const ev of msg.events) for (const id of transcript.apply(ev)) changed.add(id);
      for (const ev of msg.events)
        if (ev.type === "form.resolved" || ev.type === "form.sending") formErrors.delete(ev.formId);
      if (!subView) scheduleItems(changed);
      else {
        // Answering a request in the subagent view updates the card there too.
        for (const id of changed) {
          const item = transcript.get(id);
          if (item && (item.kind === "permission" || item.kind === "form") && subView.transcript.has(id)) {
            subView.transcript.upsert(item);
            scheduleItems([id]);
          }
        }
      }
      // A subagent row says whether it waits for a permission or an answer.
      if (msg.events.some((ev) => /^(permission|form)\./.test(ev.type)))
        scheduleItems(
          shown()
            .items.filter((i) => i.kind === "tool" && i.category === "agent")
            .map((i) => i.id),
        );
      break;
    }
    case "subagentTranscript":
      subView = { id: msg.sessionID, transcript: new Transcript() };
      subView.transcript.reset(msg.items);
      renderAllItems();
      if (state) {
        renderEmpty(state);
        renderSubHeader();
        renderComposer(state);
      }
      stickToBottom = true;
      maybeScroll();
      break;
    case "mentionResults":
      if (mention?.requestId === msg.requestId) {
        mention.items = msg.items;
        mention.active = 0;
        renderMention();
      }
      break;
    case "revealItem": {
      const el = itemEls.get(msg.itemId);
      if (!el) break;
      stickToBottom = false;
      el.scrollIntoView({ block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
      break;
    }
    case "subagentEvents": {
      if (subView?.id !== msg.sessionID) break;
      const changed = new Set<string>();
      for (const ev of msg.events) for (const id of subView.transcript.apply(ev)) changed.add(id);
      scheduleItems(changed);
      break;
    }
    case "focusInput":
      input.focus();
      break;
    case "focusModel":
      modelBtn.focus();
      if (!modelBtn.disabled) openMenu(modelBtn, modelMenu(), modelMenuOptions());
      break;
    case "restoreInput":
      input.value = input.value ? `${msg.text}\n${input.value}` : msg.text;
      draft = input.value;
      persist();
      autosize();
      input.focus();
      break;
    case "formError":
      formErrors.set(msg.formId, msg.error);
      renderDock(true);
      break;
    case "copyResult": {
      const req = copyRequests.get(msg.requestId);
      if (!req) break;
      copyRequests.delete(msg.requestId);
      copyFeedback.set(req.key, msg.ok ? "copied" : "failed");
      const rerender = () => renderItemById(req.itemId);
      rerender();
      setTimeout(() => {
        copyFeedback.delete(req.key);
        rerender();
      }, 1800);
      break;
    }
  }
});

// Elapsed time of running subagents ticks without a state push.
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-elapsed-from]")) {
    const from = Number(el.dataset.elapsedFrom);
    if (Number.isFinite(from)) el.textContent = formatDuration(Date.now() - from);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-cache-until]")) {
    const until = Number(el.dataset.cacheUntil);
    if (!Number.isFinite(until)) continue;
    el.textContent = cacheLabel(until);
    clockBtn.dataset.tip = cacheTip(until);
    if (tipFor === clockBtn && !tipEl.hidden) tipEl.textContent = clockBtn.dataset.tip;
  }
}, 1000);

autosize();
send({ type: "ready" });
