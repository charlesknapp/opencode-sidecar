// Sidebar webview. Renders state pushed by the extension host and sends user
// intents back as typed messages. All text is inserted with textContent; no
// innerHTML, no eval.

import type {
  AgentAction,
  AgentDraft,
  AgentMode,
  AgentRow,
  AgentsView,
  AsideView,
  BudgetLevel,
  CheckState,
  CommandInfo,
  ContextBreakdown,
  CostRow,
  OnboardingStage,
  FileChange,
  FileDiff,
  ReviewCounts,
  RewindPreview,
  FormAnswer,
  FormField,
  ImportPreview,
  InboxDelivery,
  McpBusy,
  McpServerInfo,
  MentionCandidate,
  ModelOption,
  SavedPermission,
  PromptMention,
  ProviderRow,
  ProvidersView,
  QuotaMeter,
  StripStatus,
  SubagentView,
  TodoEntry,
  TranscriptItem,
  UsageStats,
} from "../shared/model";
import {
  APPROVAL_MODES,
  generalizePattern,
  globMatch,
  MODE_LABELS,
  MODE_LINES,
  type ApprovalMode,
  type RuleEffect,
} from "../shared/approval";
import { validateAgentName } from "../shared/agentName";
import { mcpNameError, parseMcpTarget } from "../shared/mcp";
import type { HostMessage, OfficialLink, ViewState, WebviewMessage } from "../shared/protocol";
import { formatRate, ThroughputMeter } from "../shared/throughput";
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
let deliveryMode: InboxDelivery = "steer";
const otherDelivery = (): InboxDelivery => (deliveryMode === "steer" ? "queue" : "steer");
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

/**
 * Large pastes in this draft, shown as chips; `[Pasted text #n]` in the box marks each
 * one's place. A chip whose token was deleted is kept (Ctrl+Z can bring the token
 * back) but neither shown nor sent.
 */
interface Paste {
  n: number;
  text: string;
}
let pastes: Paste[] = [];
/** Texts of pastes sent lately, newest first: a prompt shown again collapses them to chips. */
let pasteMemory: string[] = [];

const persisted = vscode.getState() as
  | {
      draft?: string;
      delivery?: InboxDelivery;
      mentions?: PromptMention[];
      pastes?: Paste[];
      pasteMemory?: string[];
    }
  | undefined;
if (persisted?.draft) draft = persisted.draft;
if (persisted?.delivery === "queue") deliveryMode = "queue";
if (Array.isArray(persisted?.mentions)) mentions = persisted.mentions;
if (Array.isArray(persisted?.pastes)) pastes = persisted.pastes;
if (Array.isArray(persisted?.pasteMemory)) pasteMemory = persisted.pasteMemory;

const t = (key: StringKey) => translate(state?.locale ?? "en", key);

function persist() {
  vscode.setState({ draft, delivery: deliveryMode, mentions, pastes, pasteMemory });
}

// ------------------------------------------------------------------- icons
// 16px line icons drawn with DOM calls (no innerHTML). "F:" marks a filled path.

const ICON_PATHS: Record<string, string[]> = {
  rewind: ["M3 4v3.5h3.5", "M3.4 7.4A5 5 0 1 1 4.5 11.5"],
  bookmark: ["M4.5 2.5h7v11L8 11l-3.5 2.5z"],
  history: ["M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0", "M8 5v3l2 1.3"],
  clock: ["M13.8 8a5.8 5.8 0 1 1-11.6 0a5.8 5.8 0 1 1 11.6 0", "M8 5v3l2 1.3"],
  // The / palette: a slash in a rounded square, on the same grid and stroke as the others.
  slash: [
    "M4.9 2.6h6.2a2.3 2.3 0 0 1 2.3 2.3v6.2a2.3 2.3 0 0 1-2.3 2.3H4.9a2.3 2.3 0 0 1-2.3-2.3V4.9a2.3 2.3 0 0 1 2.3-2.3z",
    "M9.5 5.4L6.5 10.6",
  ],
  newchat: ["M8 2.3a5.7 5.7 0 0 1 5 8.4l.8 2.8-2.8-.8A5.7 5.7 0 1 1 8 2.3z", "M8 5.6v4.8M5.6 8h4.8"],
  pencil: ["M10.5 2.5l3 3L6 13H3v-3z"],
  // Palette rows: compact (arrows meeting a line), model (a chip), shell, MCP servers,
  // always-allowed (a shield with a tick) and settings (two sliders).
  compact: ["M8 1.5v4.5", "M5.5 3.5L8 6l2.5-2.5", "M8 14.5V10", "M5.5 12.5L8 10l2.5 2.5", "M3 8h10"],
  model: [
    "M5 4.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5z",
    "M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14",
  ],
  terminal: [
    "M3 3h10a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-9A.5.5 0 0 1 3 3z",
    "M5 6.5L7 8l-2 1.5",
    "M8.5 10H11",
  ],
  server: ["M3 2.5h10v4.5H3z", "M3 9h10v4.5H3z", "M5.5 4.75h1M5.5 11.25h1"],
  allowed: ["M8 2.5l4.5 2v3.3c0 2.8-1.9 4.9-4.5 5.7-2.6-.8-4.5-2.9-4.5-5.7V4.5z", "M6 8l1.5 1.5L10.2 6.8"],
  settings: ["M2.5 5h11M2.5 11h11", "M10.5 3.2v3.6M5.5 9.2v3.6"],
  plus: ["M8 3v10M3 8h10"],
  copy: [
    "M6.5 5h5A1.5 1.5 0 0 1 13 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 5 11.5v-5A1.5 1.5 0 0 1 6.5 5z",
    "M3 10.5V4a1 1 0 0 1 1-1h6.5",
  ],
  up: ["M8 13V3M4 7l4-4 4 4"],
  down: ["M8 3v10M4 9l4 4 4-4"],
  // Steer: an arrow merging into the line of work. Queue: lines waiting, with a pause.
  steer: ["M2.5 12.5c3.5 0 4.5-6 9-6h2", "M11.5 4.5l2 2-2 2", "M2.5 6.5h4"],
  queue: ["M2.5 4.5h11", "M2.5 8h11", "M2.5 11.5h6", "M11 10v3", "M13.5 10v3"],
  branch: [
    "M5 2.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2z",
    "M5 10.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2z",
    "M11 2.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2z",
    "M5 5.6v4.8",
    "M11 5.6c0 2.6-6 1.8-6 4.8",
  ],
  insert: ["M3 3.5h10", "M3 12.5h10", "M8 5.5v5", "M5.5 8.5l2.5 2 2.5-2"],
  openfile: ["M9 2.5H4.5v11h7V5z", "M9 2.5V5h2.5", "M10 9.5h3.5", "M12 8l1.5 1.5L12 11"],
  export: ["M8 2.5v7.5", "M5 5.5l3-3 3 3", "M3 9.5v3.5h10V9.5"],
  trash: ["M2.5 4.5h11", "M6 4.5V3h4v1.5", "M4 4.5l.7 8.5h6.6l.7-8.5", "M6.7 7v4M9.3 7v4"],
  stop: ["F:M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
  // A limit nearly used up: a warning triangle.
  warn: ["M8 2.5l6 11H2z", "M8 6.5v3", "F:M8.6 11.5a.6.6 0 1 1-1.2 0a.6.6 0 1 1 1.2 0z"],
  // Agents: Build is a hammer, Plan a clipboard with a checklist.
  build: ["M9.3 2.2l4.5 4.5-2.1 2.1-4.5-4.5z", "M9.4 6.6L3 13"],
  plan: [
    "M6 2.5h4v2H6z",
    "M6 3.5H4.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5H10",
    "M6.3 8.2l.8.8 1.4-1.5M9.5 8.5H11M6.3 11.2l.8.8 1.4-1.5M9.5 11.5H11",
  ],
  chev: ["M4 6l4 4 4-4"],
  close: ["M4 4l8 8M12 4l-8 8"],
  // Providers: a plug. The setup check: a tick.
  plug: ["M6 2.5v3M10 2.5v3", "M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z", "M8 11.5v2"],
  check: ["M3 8.5l3.2 3.2L13 4.8"],
  search: ["M11.5 7a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0", "M10.3 10.3L14 14"],
  file: ["M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z", "M9 2.5v3h3"],
  selection: ["M3 4h10M3 8h6M3 12h8", "F:M12 9.5h1.5v4H12z"],
  folder: ["M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"],
  image: [
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5",
    "F:M10.8 5.2a1.1 1.1 0 1 1 0 2.2a1.1 1.1 0 1 1 0-2.2z",
  ],
  // Ask aside: a speech bubble with a question mark.
  aside: [
    "M3.5 3h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M6.6 5.6a1.4 1.4 0 1 1 2 1.3c-.4.2-.6.5-.6.9",
    "F:M8 9.1a.55.55 0 1 1 0 1.1a.55.55 0 1 1 0-1.1z",
  ],
  // Pasted text: a clipboard with lines of text.
  paste: [
    "M6 2.5h4v2H6z",
    "M6 3.5H4.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5H10",
    "M6 7.5h4M6 9.5h4M6 11.5h2.5",
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
/** The session strip: open sessions as small tabs with their status, under the header. */
const stripEl = h("div", {
  className: "strip",
  role: "list",
  "aria-label": "Open sessions",
  "data-testid": "session-strip",
  hidden: true,
});
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
/** The side question (`/btw`) card, above the conversation. */
const asideEl = h("section", {
  className: "aside",
  "aria-label": "Side question",
  "data-testid": "aside",
  hidden: true,
});
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
/** "↓ Jump to latest" ("↓ 3 new"): shown above the box while the chat is scrolled up. */
const jumpEl = h("button", {
  className: "jump",
  hidden: true,
  "data-testid": "jump-latest",
  onclick: () => jumpToLatest(),
});
const bottomEl = h("div", { className: "bottom" }, jumpEl, stripsEl, composerEl);
app.append(
  headerEl,
  stripEl,
  bannerEl,
  bookmarksEl,
  sessionsEl,
  subHeaderEl,
  asideEl,
  scroller,
  bottomEl,
  statusLive,
);
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
  rows: 1,
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
const slashBtn = toolBtn("ico", "Commands", "commands-button", icon("slash"));
const ctxBtn = toolBtn("ico ctx", "Context", "context-ring");
const clockBtn = toolBtn("pill clean", "Prompt cache and usage", "cache-pill");
const quotaBtn = toolBtn("pill quota", "Usage limits", "quota-chip");
const agentsBtn = toolBtn("pill", "Subagents", "agents-pill");
const modelBtn = toolBtn("pill model", "Model", "model-pill");
const modeBtn = toolBtn("mode", "Agent", "mode-button");
const sendBtn = h("button", { className: "sq", "data-testid": "send" });
sendBtn.addEventListener("click", () => {
  if (sendBtn.dataset.testid === "stop") stop();
  else submit();
});
/**
 * While the agent works: does a message steer it (reach it at its next step) or wait in
 * the queue until the task ends? A two-way switch in the footer, icons with tooltips;
 * Alt+Enter sends one message the other way.
 */
const DELIVERY_TIPS: Record<InboxDelivery, string> = {
  steer: "Steer: your message reaches the agent at its next step",
  queue: "Queue: your message is sent when this task ends",
};
const deliveryBtn = (mode: InboxDelivery) =>
  h(
    "button",
    {
      className: `seg ${mode}`,
      "data-testid": `delivery-${mode}`,
      onclick: () => {
        // In a narrow panel only the chosen segment shows, and clicking it flips the mode.
        const compact = deliveryEl.classList.contains("compact");
        if (deliveryMode === mode && !compact) return;
        deliveryMode = deliveryMode === mode ? otherDelivery() : mode;
        persist();
        if (state) renderComposer(state);
      },
    },
    icon(mode),
  );
const deliveryEl = h(
  "div",
  { className: "delivery", "aria-label": "While the agent works", hidden: true },
  deliveryBtn("steer"),
  deliveryBtn("queue"),
);
/** Under this panel width the switch shows only the chosen mode, as one button that flips it. */
const DELIVERY_COMPACT_BELOW = 360;
/**
 * Paints the switch for the panel's width: two radio segments, or (narrow) a single toggle
 * button whose tooltip and label say what a click does.
 */
function paintDelivery(): void {
  const compact = app.clientWidth > 0 && app.clientWidth < DELIVERY_COMPACT_BELOW;
  deliveryEl.classList.toggle("compact", compact);
  deliveryEl.setAttribute("role", compact ? "group" : "radiogroup");
  const other = otherDelivery();
  const otherName = other === "steer" ? "Steer" : "Queue";
  for (const b of deliveryEl.querySelectorAll<HTMLElement>(".seg")) {
    const mode: InboxDelivery = b.classList.contains("steer") ? "steer" : "queue";
    const on = mode === deliveryMode;
    b.classList.toggle("on", on);
    if (compact) {
      b.removeAttribute("role");
      b.removeAttribute("aria-checked");
      const label = `${DELIVERY_TIPS[mode]}. Click to switch to ${otherName}`;
      b.setAttribute("aria-label", label);
      b.dataset.tip = `${label} (Alt+Enter sends one the other way)`;
    } else {
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("aria-label", DELIVERY_TIPS[mode]);
      b.dataset.tip = `${DELIVERY_TIPS[mode]} (Alt+Enter sends one the other way)`;
    }
  }
}
new ResizeObserver(() => paintDelivery()).observe(app);
const boxTools = h(
  "div",
  { className: "box-tools" },
  plusBtn,
  slashBtn,
  ctxBtn,
  clockBtn,
  quotaBtn,
  agentsBtn,
  modelBtn,
  h("span", { className: "grow" }),
  // Breaks the row before the model pill in a narrow panel (CSS orders the two last).
  h("span", { className: "brk", "aria-hidden": "true" }),
  deliveryEl,
  modeBtn,
  sendBtn,
);
/** The pasted text of the chip that was opened, read-only, under the chips. */
const pasteViewEl = h("div", { className: "paste-view", "data-testid": "paste-view", hidden: true });
const boxEl = h("div", { className: "box" }, chipsEl, pasteViewEl, input, boxTools);
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
      item("Fix problems in this file", () => send({ type: "fixProblems", scope: "file" }), {
        icon: "warn",
        testid: "menu-fix-file",
      }),
      item("Fix all problems in the workspace", () => send({ type: "fixProblems", scope: "workspace" }), {
        icon: "warn",
        testid: "menu-fix-workspace",
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
for (const b of [ctxBtn, clockBtn, quotaBtn]) b.addEventListener("click", () => openUsageMenu(b));
modelBtn.addEventListener("click", () => openMenu(modelBtn, modelMenu(), modelMenuOptions()));
modeBtn.addEventListener("click", () =>
  openMenu(modeBtn, modeMenu(), {
    width: 360,
    align: "end",
    title: "Agent",
    keys: ["⇧", "Tab"],
    keysText: "to switch",
    footer: [
      item("Manage agents…", () => openAgents(), {
        icon: "agent",
        testid: "manage-agents",
        disabled: state?.connection.kind !== "connected",
      }),
    ],
  }),
);

// ↑/↓ recall this session's earlier prompts, as in a terminal: from an empty box, or
// while a recalled prompt is shown unedited. Editing it makes it the draft again.
let historyPos = -1;
let historyDraft = "";
let historyDraftPastes: Paste[] = [];
/** The recalled prompt as shown (its pastes collapsed to tokens), to tell it from an edit. */
let historyShown = "";
/** This session's prompts, newest first, without repeats. */
function promptHistory(): string[] {
  const out: string[] = [];
  for (let i = transcript.items.length - 1; i >= 0; i--) {
    const it = transcript.items[i];
    const text = it.kind === "user" ? it.text.trim() : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}
function showHistory(pos: number, hist: string[]): void {
  if (historyPos < 0 && pos >= 0) historyDraftPastes = pastes;
  historyPos = pos;
  if (pos >= 0) {
    // A recalled prompt's large pastes come back as chips, not as a wall of text.
    pastes = [];
    input.value = adoptPastes(...collapsePastes(hist[pos]));
    historyShown = input.value;
  } else {
    input.value = historyDraft;
    pastes = historyDraftPastes;
  }
  draft = input.value;
  persist();
  autosize();
  input.setSelectionRange(input.value.length, input.value.length);
  updateMention();
  if (state) renderComposer(state);
}
/** Handles ↑/↓ for prompt history; true when the key was used. */
function historyKey(e: KeyboardEvent): boolean {
  if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)
    return false;
  if (subView || e.isComposing) return false;
  const hist = promptHistory();
  const browsing = historyPos >= 0 && input.value === historyShown;
  if (!browsing && input.value !== "") return false;
  if (e.key === "ArrowUp") {
    if (historyPos + 1 >= hist.length) return browsing || hist.length > 0;
    if (!browsing) historyDraft = input.value;
    showHistory(browsing ? historyPos + 1 : 0, hist);
  } else {
    if (!browsing) return false;
    showHistory(historyPos - 1, hist);
  }
  return true;
}

input.addEventListener("keydown", (e) => {
  if (mentionKey(e)) return;
  if (historyKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    // Alt+Enter: this one message goes the other way (steer ↔ queue) while the agent works.
    submit(e.altKey && !!state?.busy);
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
  if (files.length) {
    e.preventDefault();
    for (const f of files) void attachImageFile(f);
    return;
  }
  // Large text becomes a chip; small pastes go into the box as usual.
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!isLargePaste(text)) return;
  e.preventDefault();
  addPaste(text);
});

// ------------------------------------------------------------ pasted text
//
// A paste of more than PASTE_LINES lines or PASTE_CHARS characters is held as a chip
// ("Pasted text #1 · 120 lines · ~3.1k tokens") and a `[Pasted text #1]` token in the
// box, which the host replaces with the text on send. Line endings become \n, as the
// box itself does with pasted text; everything else is kept exactly.

const PASTE_LINES = 8;
const PASTE_CHARS = 800;
/** Larger pastes go into the box as text (the host would refuse them as a chip). */
const PASTE_MAX = 500_000;
const PASTE_TOKEN = /\[Pasted text #(\d{1,4})\]/g;
const MEMORY_ENTRIES = 20;
const MEMORY_CHARS = 1_000_000;

const pasteToken = (n: number) => `[Pasted text #${n}]`;
const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");
/** The paste whose text is shown under the chips. */
let pasteOpen: number | null = null;
/** The last message sent with pastes, so one the host hands back gets its chips again. */
let lastSentPastes: { text: string; pastes: Paste[] } | null = null;

function lineCount(text: string): number {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

function isLargePaste(text: string): boolean {
  const clean = normalizeNewlines(text);
  return clean.length <= PASTE_MAX && (clean.length > PASTE_CHARS || lineCount(clean) > PASTE_LINES);
}

/** "120 lines · ~3.1k tokens" (about four characters a token). */
function pasteSummary(text: string): string {
  return `${plural(lineCount(text), "line")} · ~${formatTokens(Math.ceil(text.length / 4))} tokens`;
}

/** Pastes whose token is in the box, in the order they appear. */
function livePastes(value = input.value): Paste[] {
  return pastes
    .filter((p) => value.includes(pasteToken(p.n)))
    .sort((a, b) => value.indexOf(pasteToken(a.n)) - value.indexOf(pasteToken(b.n)));
}

const nextPasteN = () => pastes.reduce((n, p) => Math.max(n, p.n), 0) + 1;

/** Takes pastes numbered for `text` into this draft, renumbered after the draft's own. */
function adoptPastes(text: string, list: readonly Paste[]): string {
  const map = new Map<number, number>();
  let next = nextPasteN();
  for (const p of list) {
    map.set(p.n, next);
    pastes.push({ n: next++, text: p.text });
  }
  return text.replace(PASTE_TOKEN, (tok, d: string) => {
    const n = map.get(Number(d));
    return n === undefined ? tok : pasteToken(n);
  });
}

/**
 * Where a remembered paste is in `text`. The chat shows prompts trimmed,
 * so a paste that began or ended the message may have lost its outer whitespace.
 */
function findPaste(text: string, mem: string): { at: number; len: number } | null {
  for (const core of new Set([mem, mem.trimEnd(), mem.trimStart(), mem.trim()])) {
    if (core.length < PASTE_CHARS / 2 && lineCount(core) <= PASTE_LINES) continue;
    const i = text.indexOf(core);
    if (i >= 0) return { at: i, len: core.length };
  }
  return null;
}

const byLength = () => [...pasteMemory].sort((a, b) => b.length - a.length);

/** Finds pastes sent lately in `text`, longest first, and puts tokens in their place. */
function collapsePastes(text: string): [string, Paste[]] {
  const list: Paste[] = [];
  let out = text;
  for (const mem of byLength()) {
    const f = findPaste(out, mem);
    if (!f) continue;
    list.push({ n: list.length + 1, text: mem });
    out = out.slice(0, f.at) + pasteToken(list.length) + out.slice(f.at + f.len);
  }
  return [out, list];
}

/** The box's text with each live token replaced by its paste (for commands and asides). */
function expandPastes(text: string): string {
  for (const p of livePastes(text)) {
    const tok = pasteToken(p.n);
    const i = text.indexOf(tok);
    text = text.slice(0, i) + p.text + text.slice(i + tok.length);
  }
  return text;
}

/** Remembers sent pastes (newest first), within a bounded size. */
function rememberPastes(texts: readonly string[]): void {
  let total = 0;
  pasteMemory = [...texts, ...pasteMemory.filter((m) => !texts.includes(m))].filter((m, i) => {
    total += m.length;
    return i < MEMORY_ENTRIES && total <= MEMORY_CHARS;
  });
}

/** Holds `text` as a chip and types its token at the caret, keeping Undo working. */
function addPaste(text: string): void {
  const n = nextPasteN();
  pastes.push({ n, text: normalizeNewlines(text) });
  input.focus();
  if (!document.execCommand("insertText", false, pasteToken(n))) {
    input.setRangeText(pasteToken(n), input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input"));
  }
}

/** Replaces a chip's token in the box, with its text (Edit) or with nothing (×). */
function replacePaste(n: number, inline: boolean): void {
  const p = pastes.find((x) => x.n === n);
  const tok = pasteToken(n);
  const i = input.value.indexOf(tok);
  pastes = pastes.filter((x) => x.n !== n);
  if (pasteOpen === n) pasteOpen = null;
  if (p && i >= 0) {
    const text = inline ? p.text : "";
    input.setRangeText(text, i, i + tok.length, "end");
    input.focus();
    input.setSelectionRange(i + text.length, i + text.length);
  }
  input.dispatchEvent(new Event("input"));
}

function pasteChip(p: Paste): HTMLElement {
  const open = pasteOpen === p.n;
  const label = `Pasted text #${p.n}`;
  return h(
    "span",
    { className: "chip paste" + (open ? " open" : ""), "data-testid": "paste-chip" },
    h(
      "button",
      {
        className: "chip-open",
        "aria-expanded": String(open),
        "aria-label": `${open ? "Hide" : "Show"} ${label}, ${pasteSummary(p.text)}`,
        "data-tip": open ? "Hide the pasted text" : "Show the pasted text",
        "data-testid": "paste-open",
        onclick: () => {
          pasteOpen = open ? null : p.n;
          if (state) renderComposer(state);
        },
      },
      icon("paste"),
      h("span", { className: "chip-label" }, label),
      h("span", { className: "chip-detail" }, pasteSummary(p.text)),
    ),
    h(
      "button",
      {
        className: "chip-x",
        "aria-label": `Edit ${label} in the message`,
        "data-tip": "Put the text in the message box to edit it",
        "data-testid": "paste-edit",
        onclick: () => replacePaste(p.n, true),
      },
      icon("pencil"),
    ),
    h(
      "button",
      {
        className: "chip-x",
        "aria-label": `Remove ${label}`,
        "data-testid": "paste-remove",
        onclick: () => replacePaste(p.n, false),
      },
      "×",
    ),
  );
}

function renderPasteView(live: readonly Paste[]): void {
  const p = live.find((x) => x.n === pasteOpen);
  pasteViewEl.hidden = !p || !!subView;
  if (!p) {
    pasteViewEl.replaceChildren();
    return;
  }
  pasteViewEl.replaceChildren(
    h("pre", { className: "paste-text", tabindex: "0", "aria-label": `Pasted text #${p.n}` }, p.text),
  );
}

// ------------------------------------------------------------- ask aside
//
// `/btw <question>` (or Ask aside in the / palette) asks in a copy of the session that
// only this card shows; the main session keeps working undisturbed. The card is built
// once, so a follow-up being typed survives the answer streaming in.

/** The side question from the host; null when none is open. */
let aside: AsideView | null = null;
/** The card is open, also before its first question. */
let asideShown = false;
const asideStatus = h("span", { className: "aside-status", "data-testid": "aside-status" });
const asideBody = h("div", { className: "aside-body", "data-testid": "aside-body" });
const asideInput = h("input", {
  className: "aside-input",
  type: "text",
  dir: "auto",
  "aria-label": "Side question",
  "data-testid": "aside-input",
});
const asideAskBtn = h(
  "button",
  { className: "btn small", "data-testid": "aside-ask", onclick: () => askAside(asideInput.value) },
  "Ask",
);
const asideMainBtn = h(
  "button",
  {
    className: "btn small",
    "data-testid": "aside-to-main",
    "data-tip": "Add this answer to the session as a message (queued while the agent works)",
    onclick: () => send({ type: "asideToMain" }),
  },
  "Send to main",
);
asideEl.append(
  h(
    "div",
    { className: "aside-head" },
    icon("aside"),
    h("span", { className: "aside-title" }, "Ask aside"),
    asideStatus,
    h("span", { className: "grow" }),
    h(
      "button",
      {
        className: "ico",
        "aria-label": "Close the side question",
        "data-tip": "Close (the side thread is deleted)",
        "data-testid": "aside-close",
        onclick: () => closeAside(),
      },
      icon("close"),
    ),
  ),
  asideBody,
  h("div", { className: "aside-foot" }, asideInput, asideAskBtn, asideMainBtn),
);
asideInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    askAside(asideInput.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    input.focus();
  }
});
asideInput.addEventListener("input", () => renderAside());

const asideBusy = () => aside?.status === "starting" || aside?.status === "running";

/** Opens the card; with `focus`, its question field takes the caret. */
function openAside(focus: boolean): void {
  asideShown = true;
  renderAside();
  if (focus) asideInput.focus();
}

/** Asks in the side thread; while it is still answering the question waits in the field. */
function askAside(text: string): void {
  const q = text.trim();
  if (!q || state?.connection.kind !== "connected") return;
  if (asideBusy()) {
    asideInput.value = q;
    openAside(true);
    return;
  }
  send({ type: "askAside", text: q });
  asideInput.value = "";
  openAside(false);
}

function closeAside(): void {
  if (aside) send({ type: "closeAside" });
  aside = null;
  asideShown = false;
  asideInput.value = "";
  renderAside();
  input.focus();
}

function renderAside(): void {
  asideEl.hidden = !asideShown;
  if (!asideShown) return;
  const a = aside;
  const turns = a?.turns ?? [];
  const busy = asideBusy();
  asideStatus.textContent = busy ? "Answering…" : "Not added to this session";
  // State pushes repaint the controls only; the answer is rebuilt when it changed.
  const sig = JSON.stringify(a);
  if (sig !== asideSignature) {
    asideSignature = sig;
    paintAsideBody(a);
  }
  asideInput.placeholder = turns.length ? "Ask a follow-up…" : "Ask a side question…";
  const connected = state?.connection.kind === "connected";
  asideAskBtn.disabled = !connected || busy || !asideInput.value.trim();
  const last = [...turns].reverse().find((tn) => tn.done && tn.answer.trim());
  asideMainBtn.hidden = !last;
  asideMainBtn.disabled = !connected || !!last?.sent;
  asideMainBtn.textContent = last?.sent ? "Sent to main" : "Send to main";
}

let asideSignature = "";

function paintAsideBody(a: AsideView | null): void {
  const turns = a?.turns ?? [];
  const stick = asideBody.scrollHeight - asideBody.scrollTop - asideBody.clientHeight < 24;
  const nodes: Node[] = [];
  if (a?.error) nodes.push(h("div", { className: "aside-err", role: "alert" }, a.error));
  turns.forEach((tn, i) => {
    nodes.push(h("div", { className: "aside-q", dir: "auto" }, tn.question));
    if (tn.answer)
      nodes.push(
        h(
          "div",
          { className: "msg assistant aside-a" + (tn.done ? "" : " streaming") },
          h("div", { className: "msg-body" }, ...renderBlocks(parseMarkdown(tn.answer), `aside:${i}`)),
        ),
      );
    else if (!tn.done && !a?.error)
      nodes.push(h("div", { className: "aside-wait" }, markSpinner(), a?.activity ?? "Thinking…"));
    if (tn.error) nodes.push(h("div", { className: "aside-err", role: "alert" }, tn.error));
  });
  if (!turns.length)
    nodes.push(
      h(
        "div",
        { className: "aside-note" },
        "Ask a quick question about this session. It runs in a copy, so the agent's work and context stay as they are.",
      ),
    );
  asideBody.replaceChildren(...nodes);
  asideBody.hidden = nodes.length === 0;
  if (stick) asideBody.scrollTop = asideBody.scrollHeight;
}
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

/** Sends the box; `flip` (Alt+Enter) sends this one message the other way while the agent works. */
function submit(flip = false) {
  if (!state || state.connection.kind !== "connected") return;
  const delivery = flip ? otherDelivery() : deliveryMode;
  const text = input.value;
  if (!text.trim()) return;
  const live = livePastes(text);
  // Commands and shell lines take the pasted text in place; a prompt sends it beside the
  // text, so the host can put it in after finding the mentions.
  const full = expandPastes(text);
  const cmd = /^\/([\w.:/-]+)(?:\s+([\s\S]*))?$/.exec(full.trim());
  const known = cmd && (state.commands ?? []).some((c) => c.name === cmd[1]);
  // /btw is Sidecar's side question, unless OpenCode has a command of that name.
  if (cmd && cmd[1] === "btw" && !known) {
    if (cmd[2]?.trim()) askAside(cmd[2]);
    else openAside(true);
  } else if (cmd && known)
    send(
      state.busy
        ? { type: "runCommand", name: cmd[1], text: cmd[2] ?? "", delivery }
        : { type: "runCommand", name: cmd[1], text: cmd[2] ?? "" },
    );
  else if (cmd && cmd[1] === "compact" && !cmd[2]) send({ type: "compact" });
  else if (full.startsWith("!") && full.slice(1).trim())
    send({ type: "shellCommand", command: full.slice(1).trim() });
  else {
    const picked = mentions.filter((m) => text.includes(m.text));
    send({
      type: "send",
      text,
      ...(state.busy ? { delivery } : {}),
      ...(picked.length ? { mentions: picked } : {}),
      ...(live.length ? { pastes: live.map((p) => ({ token: pasteToken(p.n), text: p.text })) } : {}),
    });
    lastSentPastes = live.length ? { text, pastes: live } : null;
  }
  if (live.length) rememberPastes(live.map((p) => p.text));
  input.value = "";
  draft = "";
  historyPos = -1;
  mentions = [];
  pastes = [];
  pasteOpen = null;
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
  /** table: rows of cells under a header row; meter: a stat with a bar under it (`share` 0–1). */
  kind: "item" | "heading" | "note" | "stat" | "sep" | "toggle" | "slider" | "table" | "meter";
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
  /** table: the header row, then the rows; a row's `indent` nests it under the one above. */
  columns?: string[];
  rows?: Array<{ cells: string[]; indent?: number; title?: string }>;
  share?: number;
  /** meter: shown in the warning colour. */
  warn?: boolean;
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
    else if (e.kind === "table") into.append(menuTable(e));
    else if (e.kind === "meter")
      into.append(
        h(
          "div",
          { className: "menu-meter" + (e.warn ? " warn" : ""), "data-testid": e.testid },
          h(
            "div",
            { className: "menu-stat" },
            h("span", { dir: "auto" }, e.label ?? ""),
            h("span", {}, e.value ?? ""),
          ),
          h(
            "div",
            {
              className: "bar",
              role: "meter",
              "aria-label": e.label,
              "aria-valuemin": "0",
              "aria-valuemax": "100",
              "aria-valuenow": String(Math.round((e.share ?? 0) * 100)),
            },
            meterFill(e.share ?? 0),
          ),
          e.sub ? h("div", { className: "menu-note" }, e.sub) : null,
        ),
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
        }),
      );
      // The choice the host knows about; a drag shows its steps and commits on release.
      let committed = cur;
      const show = (i: number) => {
        if (i < 0 || i >= opts2.length || i === cur) return;
        cur = i;
        dots.forEach((d, j) => {
          d.classList.toggle("on", j === cur);
          d.setAttribute("aria-checked", String(j === cur));
        });
        valueEl.textContent = `(${opts2[cur].label})`;
      };
      const commit = () => {
        if (cur === committed) return;
        committed = cur;
        e.onSelect?.(opts2[cur].value);
      };
      const pickAt = (i: number) => {
        show(i);
        commit();
      };
      /** The step whose dot is nearest the pointer, anywhere along the track. */
      const nearest = (x: number) => {
        let best = 0;
        let dist = Infinity;
        dots.forEach((d, j) => {
          const r = d.getBoundingClientRect();
          const dd = Math.abs(x - (r.left + r.width / 2));
          if (dd < dist) {
            dist = dd;
            best = j;
          }
        });
        return best;
      };
      // Click anywhere on the track, or press and drag along it.
      const track = h("span", { className: "dots" }, ...dots);
      track.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        track.setPointerCapture(ev.pointerId);
        track.classList.add("dragging");
        show(nearest(ev.clientX));
      });
      track.addEventListener("pointermove", (ev) => {
        if (track.hasPointerCapture(ev.pointerId)) show(nearest(ev.clientX));
      });
      const release = (ev: PointerEvent) => {
        if (!track.hasPointerCapture(ev.pointerId)) return;
        track.releasePointerCapture(ev.pointerId);
        track.classList.remove("dragging");
        commit();
      };
      track.addEventListener("pointerup", release);
      track.addEventListener("pointercancel", release);
      track.addEventListener("click", (ev) => ev.stopPropagation());
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
        track,
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

function confirmDialog(o: {
  title: string;
  body: string;
  choices: DialogChoice[];
  /** More below the body that may fill in while the dialog is open. */
  detail?: HTMLElement;
}): Promise<string | null> {
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
      o.detail ?? null,
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

async function confirmDelete(id: string, title: string): Promise<void> {
  const pick = await confirmDialog({
    title: "Delete this session permanently?",
    body: `“${title}” and its whole history are removed from OpenCode. This can't be undone. Archive it instead to only hide it.`,
    choices: [
      { value: "delete", label: "Delete permanently", danger: true, testid: "delete-confirm" },
      { value: "keep", label: "Keep it", testid: "delete-keep" },
    ],
  });
  if (pick === "delete") send({ type: "deleteSession", id });
}

/** The open rewind dialog's file list, filled in when the host answers `rewindPreview`. */
let rewindPreviewFor: { messageID: string; el: HTMLElement } | null = null;

async function confirmRewind(messageID: string): Promise<void> {
  const detail = h(
    "div",
    { className: "modal-detail", "data-testid": "rewind-preview", "aria-live": "polite" },
    h("p", {}, "Checking which files would revert…"),
  );
  rewindPreviewFor = { messageID, el: detail };
  send({ type: "rewindPreview", messageID });
  const pick = await confirmDialog({
    title: "Rewind to before this prompt?",
    detail,
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
  rewindPreviewFor = null;
  if (pick) send({ type: "rewind", messageID, files: pick === "code" });
}

/** At most this many files are named in the rewind dialog; the rest are counted. */
const REWIND_FILES_SHOWN = 6;

/**
 * Which files "Rewind conversation and code" reverts, and a warning when shell commands
 * ran since: OpenCode's snapshots only cover what they recorded in this folder.
 */
function paintRewindPreview(el: HTMLElement, p: RewindPreview | null): void {
  const parts: Node[] = [];
  if (!p || !p.files) parts.push(h("p", {}, "Sidecar could not tell which files would revert."));
  else if (!p.files.length) parts.push(h("p", {}, "OpenCode recorded no file changes from this prompt on."));
  else {
    const n = p.files.length;
    parts.push(
      h("p", {}, `With code, ${n} file${n === 1 ? "" : "s"} revert${n === 1 ? "s" : ""}:`),
      h(
        "ul",
        { className: "modal-files", "data-testid": "rewind-files" },
        ...p.files
          .slice(0, REWIND_FILES_SHOWN)
          .map((f) =>
            h(
              "li",
              {},
              h("span", { className: "fname" }, f.path),
              FILE_TAG[f.status]
                ? h("span", { className: `ftag ftag-${f.status}` }, FILE_TAG[f.status])
                : null,
            ),
          ),
        n > REWIND_FILES_SHOWN ? h("li", { className: "muted" }, `and ${n - REWIND_FILES_SHOWN} more`) : null,
      ),
    );
  }
  const warn: string[] = [];
  if (p?.agentShell) {
    const n = p.agentShell;
    warn.push(
      `The agent ran ${n} shell command${n === 1 ? "" : "s"} since. Rewind restores only what OpenCode's snapshots of this folder recorded: changes outside the folder or in ignored files stay.`,
    );
  }
  if (p?.shellFiles.length) {
    const named = p.shellFiles.slice(0, 3).join(", ");
    const more = p.shellFiles.length > 3 ? ` and ${p.shellFiles.length - 3} more` : "";
    warn.push(`Changed by a command, not an edit: ${named}${more}.`);
  }
  if (p?.kept.length) {
    const named = p.kept.slice(0, 3).join(", ");
    const more = p.kept.length > 3 ? ` and ${p.kept.length - 3} more` : "";
    warn.push(
      `Changed since, but not by the agent's steps, so ${p.kept.length === 1 ? "it stays" : "they stay"}: ${named}${more}.`,
    );
  }
  if (p?.userShell) {
    const n = p.userShell;
    warn.push(
      `${n} command${n === 1 ? "" : "s"} you ran with ! ${n === 1 ? "is" : "are"} not in OpenCode's snapshots: ${n === 1 ? "its" : "their"} changes stay.`,
    );
  }
  if (warn.length)
    parts.push(h("p", { className: "modal-warn", "data-testid": "rewind-shell-warning" }, warn.join(" ")));
  el.replaceChildren(...parts);
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
  // Ctrl/Cmd+F finds in the conversation (VS Code's own find doesn't reach a side bar view).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && !dialogOpen) {
    e.preventDefault();
    openFind();
  }
});

// -------------------------------------------------------------------- find
//
// A small bar over the top of the chat. Matches are marked with the CSS Custom
// Highlight API, so the conversation's DOM is never changed; text that isn't shown
// (inside a collapsed section) isn't counted.

const findInput = h("input", {
  className: "find-input",
  type: "text",
  placeholder: "Find in conversation",
  "aria-label": "Find in conversation",
  "data-testid": "find-input",
  spellcheck: "false",
}) as HTMLInputElement;
const findCount = h("span", {
  className: "find-count muted small",
  "aria-live": "polite",
  "data-testid": "find-count",
});
const findBtn = (label: string, name: "up" | "down" | "close", testid: string, onclick: () => void) =>
  h(
    "button",
    { className: "ico", "data-tip": label, "aria-label": label, "data-testid": testid, onclick },
    icon(name),
  );
const findEl = h(
  "div",
  { className: "findbar", role: "search", hidden: true, "data-testid": "findbar" },
  findInput,
  findCount,
  findBtn("Previous match (Shift+Enter)", "up", "find-prev", () => stepFind(-1)),
  findBtn("Next match (Enter)", "down", "find-next", () => stepFind(1)),
  findBtn("Close (Esc)", "close", "find-close", () => closeFind()),
);
let findMatches: Range[] = [];
let findIndex = -1;
let findTimer = 0;
const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function findOpen(): boolean {
  return !findEl.hidden;
}
function openFind(): void {
  findEl.hidden = false;
  findInput.focus();
  findInput.select();
  runFind(true);
}
function closeFind(): void {
  findEl.hidden = true;
  findMatches = [];
  findIndex = -1;
  highlights?.delete("sidecar-find");
  highlights?.delete("sidecar-find-current");
  input.focus();
}
function scheduleFind(): void {
  clearTimeout(findTimer);
  findTimer = window.setTimeout(() => runFind(false), 120);
}
/** Finds every visible match; `jump` moves to the first match below the top of the view. */
function runFind(jump: boolean): void {
  const q = findInput.value.trim().toLowerCase();
  const before = findMatches[findIndex];
  findMatches = [];
  if (q) {
    const walker = document.createTreeWalker(listEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        if (r.getClientRects().length) findMatches.push(r);
      }
    }
  }
  if (!findMatches.length) findIndex = -1;
  else if (jump || findIndex < 0) {
    const top = scroller.getBoundingClientRect().top;
    findIndex = Math.max(
      0,
      findMatches.findIndex((r) => r.getBoundingClientRect().bottom > top),
    );
  } else {
    // Keep the place after a redraw: the match nearest where the current one was.
    const y = before?.getBoundingClientRect().top ?? 0;
    let best = 0;
    findMatches.forEach((r, i) => {
      if (
        Math.abs(r.getBoundingClientRect().top - y) <
        Math.abs(findMatches[best].getBoundingClientRect().top - y)
      )
        best = i;
    });
    findIndex = best;
  }
  paintFind(jump);
}
function stepFind(dir: 1 | -1): void {
  if (!findMatches.length) return;
  findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
  paintFind(true);
}
function paintFind(scroll: boolean): void {
  const n = findMatches.length;
  findCount.textContent = findInput.value.trim() ? (n ? `${findIndex + 1} of ${n}` : "No results") : "";
  findEl.classList.toggle("none", !!findInput.value.trim() && !n);
  if (highlights && HighlightCtor) {
    highlights.set("sidecar-find", new HighlightCtor(...findMatches));
    highlights.set("sidecar-find-current", new HighlightCtor(...(n ? [findMatches[findIndex]] : [])));
  }
  if (!scroll || !n) return;
  const rect = findMatches[findIndex].getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  // Bring the match to about a third of the way down, clear of the box at the bottom.
  if (rect.top < view.top + 40 || rect.bottom > view.bottom - (bottomEl.offsetHeight + 20)) {
    stickToBottom = false;
    scroller.scrollTop += rect.top - (view.top + view.height / 3);
  }
}
app.append(findEl);
findInput.addEventListener("input", () => runFind(true));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
});
window.addEventListener("blur", () => hideTip());

/** Subagents of the session: running and waiting first; each opens its conversation. */
// ---------------------------------------------------------------- mentions
//
// Typing `@` opens a list above the message box: files and folders (found by
// OpenCode), subagents and skills. The caret stays in the box; arrows move,
// Enter or Tab picks, Escape closes. A pick inserts its token (`@src/a.ts`) and is
// remembered, so the prompt carries it as an OpenCode mention. A `/` at the start
// of the message opens the same list with OpenCode's commands.

/** A row in that list: something to mention, or a command to run. */
type Suggestion = MentionCandidate | { kind: "command"; value: string; label: string; detail?: string };

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
  items: Suggestion[];
  active: number;
  requestId: string;
  /** The list is OpenCode's commands for a `/command` being typed. */
  slash?: boolean;
} | null = null;
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

const MENTION_ICONS: Record<Suggestion["kind"], keyof typeof ICON_PATHS> = {
  file: "file",
  folder: "folder",
  agent: "agent",
  skill: "skill",
  command: "slash",
};

/** The `@token` the caret is in: where its `@` is and what follows it. */
function mentionAtCaret(): { start: number; query: string } | null {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return null;
  const m = /(^|[\s([{"'`])@([^\s@]*)$/.exec(input.value.slice(0, pos));
  return m ? { start: pos - m[2].length - 1, query: m[2] } : null;
}

/** The `/command` being typed: a slash that starts the message, with the caret still in its name. */
function commandAtCaret(): { query: string } | null {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return null;
  const m = /^\/([\w.:/-]*)$/.exec(input.value.slice(0, pos));
  return m ? { query: m[1] } : null;
}

/** OpenCode's commands (and Compact) matching `query`: names that start with it first. */
function commandSuggestions(query: string): Suggestion[] {
  const q = query.toLowerCase();
  const cmds = (state?.commands ?? []).filter((c) => c.name !== "compact");
  if (state?.currentSession)
    cmds.push({ name: "compact", description: "Summarize the conversation to free context" });
  if (!cmds.some((c) => c.name === "btw"))
    cmds.push({ name: "btw", description: "Ask a side question without adding it to this session" });
  const rank = (c: CommandInfo) => {
    const name = c.name.toLowerCase();
    if (name === q) return -1;
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return c.description?.toLowerCase().includes(q) ? 2 : 3;
  };
  return cmds
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r)
    .map(({ c }) => ({
      kind: "command",
      value: c.name,
      label: `/${c.name}`,
      detail: c.description ?? undefined,
    }));
}

function updateMention(): void {
  if (!state || state.connection.kind !== "connected" || input.disabled) return closeMention();
  const cmd = commandAtCaret();
  if (cmd) {
    // Opening the list asks OpenCode for its commands again, as the / button does.
    if (!mention?.slash) send({ type: "refreshCommands" });
    else if (mention.query === cmd.query) return;
    clearTimeout(mentionTimer);
    mention = {
      start: 0,
      query: cmd.query,
      items: commandSuggestions(cmd.query),
      active: 0,
      requestId: "",
      slash: true,
    };
    return renderMention();
  }
  const at = mentionAtCaret();
  if (!at) return closeMention();
  if (mention && !mention.slash && mention.start === at.start && mention.query === at.query) return;
  const keep = mention && !mention.slash && mention.start === at.start ? mention.items : [];
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
  mentionEl.setAttribute("aria-label", m.slash ? "Commands" : "Mention");
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
  if (c.kind === "command") input.setRangeText(`/${c.value} `, 0, input.selectionStart, "end");
  else {
    const token = `@${c.value}${c.kind === "folder" ? "/" : ""}`;
    input.setRangeText(`${token} `, m.start, input.selectionStart, "end");
    if (!mentions.some((x) => x.text === token)) mentions.push({ kind: c.kind, value: c.value, text: token });
  }
  closeMention();
  input.focus();
  input.dispatchEvent(new Event("input"));
}

/** Keys for the open `@` or `/` list; returns true when the key was used. */
function mentionKey(e: KeyboardEvent): boolean {
  const m = mention;
  if (!m || mentionEl.hidden || e.isComposing) return false;
  // A command typed out in full runs on Enter, as it did before the list existed; Tab still completes.
  if (m.slash && e.key === "Enter" && !e.shiftKey && m.items[m.active]?.value === m.query) {
    closeMention();
    return false;
  }
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
        sub: m.contextLimit ? `${formatTokens(m.contextLimit)} context` : "Context size not reported",
        testid: "model-option",
      }),
    );
  }
  if (!models.length) out.push(note(modelPlaceholder(s)));
  // Usage lives behind the context ring and the clock; without either it stays here.
  const stats = usageStats(s);
  if (stats.length && !ringShown(s) && !clockShown(s)) out.push(sep(), heading("Session"), ...stats);
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
      sub: "Add the file open in the editor to your message",
      disabled: !connected,
    }),
    item("Attach selection", () => send({ type: "addSelection" }), {
      icon: "selection",
      sub: "Add the lines selected in the editor",
      disabled: !connected,
    }),
    item("Search workspace files…", () => send({ type: "searchFiles" }), {
      icon: "search",
      sub: "Find a file in this folder to attach",
      disabled: !connected,
    }),
    item("Fix problems in this file", () => send({ type: "fixProblems", scope: "file" }), {
      icon: "warn",
      sub: "Attach the errors and warnings VS Code reports for the editor's file",
      disabled: !connected,
      testid: "command-fix-file",
    }),
    item("Fix all problems in the workspace", () => send({ type: "fixProblems", scope: "workspace" }), {
      icon: "warn",
      sub: "Attach every error and warning in this folder (up to 50)",
      disabled: !connected,
      testid: "command-fix-workspace",
    }),
    toggle(
      "Follow the editor",
      !!s?.prefs.autoContext,
      () => send({ type: "setPref", key: "autoContext", value: !state?.prefs.autoContext }),
      "pref-auto-context",
    ),
    item(
      "Bookmarks…",
      () => {
        bookmarksOpen = true;
        sessionsOpen = false;
        render();
      },
      { icon: "bookmark", sub: "Answers you saved in this workspace" },
    ),
    item(
      "Session history…",
      () => {
        sessionsOpen = true;
        bookmarksOpen = false;
        send({ type: "refreshSessions" });
        render();
      },
      { icon: "history", sub: "Open, search or restore earlier sessions" },
    ),
    sep(),
    heading("Model"),
    item("Switch model…", () => openMenu(modelBtn, modelMenu(), modelMenuOptions()), {
      icon: "model",
      sub: model?.name ? `Now ${model.name}` : "Choose the model for this session",
      disabled: modelBtn.disabled,
      testid: "command-switch-model",
    }),
    ...modelSliders(),
    sep(),
    heading("Session"),
    item("/compact", () => send({ type: "compact" }), {
      icon: "compact",
      sub: "Summarize the conversation to free context",
      disabled: !s?.currentSession,
      testid: "command-compact",
    }),
    item("Ask aside…", () => openAside(true), {
      icon: "aside",
      sub: "A quick question in a copy of this session (/btw)",
      disabled: !connected,
      testid: "command-aside",
    }),
    item(
      "Rename session…",
      () => {
        if (s?.currentSession) startRename(s.currentSession.title);
      },
      { icon: "pencil", sub: "Give this session a clearer title", disabled: !s?.currentSession },
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
      {
        icon: "archive",
        sub: "Hide it from History; it can be restored",
        disabled: !s?.currentSession,
        testid: "command-archive",
      },
    ),
    item("Export to Markdown", () => send({ type: "exportSession" }), {
      icon: "export",
      sub: "Open this session as a Markdown document",
      disabled: !s?.currentSession,
      testid: "command-export",
    }),
    item(
      "Delete session…",
      () => {
        if (s?.currentSession) void confirmDelete(s.currentSession.id, s.currentSession.title);
      },
      {
        icon: "trash",
        sub: "Remove it from OpenCode for good",
        disabled: !s?.currentSession,
        testid: "command-delete",
      },
    ),
    item("New session", () => send({ type: "newSession" }), {
      icon: "newchat",
      sub: "Start a fresh conversation in this folder",
    }),
    sep(),
    heading("OpenCode commands"),
  ];
  for (const c of cmds.filter((c) => c.name !== "compact"))
    out.push(
      item(`/${c.name}`, () => insertCommand(`/${c.name} `), {
        icon: "slash",
        sub: c.description || "Insert it into the message box",
        testid: "command-option",
      }),
    );
  if (!cmds.some((c) => c.name !== "compact"))
    out.push(note("OpenCode reports no commands for this folder."));
  out.push(
    item("!command", () => insertCommand("!"), {
      icon: "terminal",
      sub: "Run a shell command in the session",
      testid: "command-shell",
    }),
    sep(),
    heading("Display"),
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
    sep(),
    heading("Settings"),
    item("MCP servers…", () => openMcpServers(), {
      icon: "server",
      sub: "Their state; connect, sign in or add one for this OpenCode run",
      testid: "mcp-servers",
      disabled: state?.connection.kind !== "connected",
    }),
    item("Permission rules…", () => openRulesEditor(), {
      icon: "allowed",
      sub: "What the agent may do without asking, here and in this session",
      testid: "permission-rules",
      disabled: state?.connection.kind !== "connected",
    }),
    item("Agents…", () => openAgents(), {
      icon: "agent",
      sub: "Create, edit or import agents with their own prompt, model and permissions",
      testid: "agents",
      disabled: state?.connection.kind !== "connected",
    }),
    item("Providers…", () => openProviders(), {
      icon: "plug",
      sub: "Connect, sign in again or disconnect model providers",
      testid: "providers",
      disabled: state?.connection.kind !== "connected",
    }),
    item("Check OpenCode setup", () => send({ type: "checkSetup" }), {
      icon: "check",
      sub: "The program, service, sign-in, models and providers in one report",
      testid: "check-setup",
    }),
    item("Sidecar settings…", () => send({ type: "openSettings" }), {
      icon: "settings",
      sub: "Open Sidecar's settings in VS Code",
      testid: "open-settings",
    }),
  );
  return out;
}

// ----------------------------------------------------------- MCP servers
//
// The MCP panel: the MCP servers OpenCode has for the open folder, how each is doing, and
// Connect / Disconnect / Retry / Authenticate for this OpenCode run. A server can be added
// for this run only; servers in OpenCode's config are never changed. OpenCode does not
// list a server's tools, so their count and context cost are not shown.

/** undefined while loading; null when OpenCode could not list them. */
let mcpList: McpServerInfo[] | null | undefined;
let mcpError = "";
let mcpBusy: McpBusy | null = null;
let mcpPanel: { paint: () => void; added: (ok: boolean, error?: string) => void } | null = null;

const MCP_STATES: Record<McpServerInfo["status"], string> = {
  connected: "Connected",
  pending: "Connecting…",
  disabled: "Disabled",
  failed: "Failed",
  needs_auth: "Needs sign-in",
};
const MCP_STATE_CLASS: Record<McpServerInfo["status"], string> = {
  connected: "s-connected",
  pending: "s-muted",
  disabled: "s-muted",
  failed: "s-error",
  needs_auth: "s-needs-auth",
};

function openMcpServers(): void {
  if (mcpPanel) {
    send({ type: "loadMcpServers" });
    return;
  }
  closePopovers();
  mcpList = undefined;
  mcpBusy = null;
  send({ type: "loadMcpServers" });
  const before = document.activeElement as HTMLElement | null;
  const status = h("p", { className: "banner info", role: "status", "data-testid": "mcp-busy" });
  const list = h("ul", { className: "rules-list", "data-testid": "mcp-list" });
  const listNote = h("p", { className: "rules-note", "data-testid": "mcp-note" });
  // The add form is built once, so what is typed survives the list being redrawn.
  const nameIn = h("input", {
    className: "rule-in",
    "aria-label": "Server name",
    placeholder: "Name",
    "data-testid": "mcp-add-name",
  }) as HTMLInputElement;
  const targetIn = h("input", {
    className: "rule-in grow",
    "aria-label": "Command or URL",
    placeholder: "npx -y some-server, or https://…",
    "data-testid": "mcp-add-target",
  }) as HTMLInputElement;
  const addError = h("p", { className: "rule-error", "data-testid": "mcp-add-error", role: "alert" });
  addError.hidden = true;
  const showAddError = (text: string) => {
    addError.textContent = text;
    addError.hidden = !text;
  };
  let adding = false;
  const add = () => {
    const name = nameIn.value.trim();
    const parsed = parseMcpTarget(targetIn.value);
    const why =
      mcpNameError(
        name,
        (mcpList ?? []).map((m) => m.name),
      ) ?? (parsed.ok ? null : parsed.error);
    showAddError(why ?? "");
    if (why) return (name && !parsed.ok ? targetIn : nameIn).focus();
    adding = true;
    send({ type: "mcpAdd", name, target: targetIn.value.trim() });
    paint();
  };
  const addBtn = h(
    "button",
    { className: "btn", "data-testid": "mcp-add", onclick: add },
    "Add",
  ) as HTMLButtonElement;
  for (const i of [nameIn, targetIn])
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
  const reloadBtn = h(
    "button",
    {
      className: "btn subtle",
      "data-testid": "mcp-reload",
      "data-tip": "Have OpenCode read its config and skills again (servers added here are dropped)",
      onclick: () => send({ type: "reloadMcp" }),
    },
    "Reload config",
  ) as HTMLButtonElement;
  const close = () => {
    mcpPanel = null;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (before?.isConnected) before.focus();
  };
  const doneBtn = h("button", { className: "btn", "data-testid": "mcp-close", onclick: close }, "Done");
  const dialog = h(
    "div",
    {
      className: "modal rules-editor providers-panel mcp-panel",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "mcp-title",
      "data-testid": "mcp-panel",
      tabindex: "-1",
    },
    h("h2", { id: "mcp-title" }, "MCP servers"),
    h(
      "p",
      { className: "rules-note" },
      "Changes here last for this OpenCode run. OpenCode's config is not changed.",
    ),
    status,
    list,
    listNote,
    h("h3", {}, "Add a server for this OpenCode run"),
    h("div", { className: "rule-form" }, nameIn, targetIn, addBtn),
    addError,
    h("div", { className: "modal-foot providers-foot" }, reloadBtn, doneBtn),
  );
  const backdrop = h(
    "div",
    {
      className: "modal-backdrop",
      onmousedown: (e: Event) => {
        if (e.target === backdrop) close();
      },
    },
    dialog,
  );
  const onKey = (e: KeyboardEvent) => {
    if (dialogOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      const f = Array.from(dialog.querySelectorAll<HTMLElement>("button, input")).filter(
        (x) => !(x as HTMLButtonElement).disabled && !x.hidden,
      );
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);

  async function remove(m: McpServerInfo): Promise<void> {
    const pick = await confirmDialog({
      title: `Remove ${m.title || m.name}?`,
      body: "OpenCode stops the server and leaves it out until it restarts or reloads its config.",
      choices: [{ value: "yes", label: "Remove", danger: true, testid: "mcp-remove-confirm" }],
    });
    if (pick === "yes") send({ type: "mcpRemove", name: m.name });
  }

  /** The row's actions for its state; they all wait while something runs. */
  function actions(m: McpServerInfo, busy: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    const cmd = (label: string, testid: string, type: "mcpConnect" | "mcpDisconnect" | "mcpAuth") =>
      smallBtn(label, testid, () => send({ type, name: m.name }), busy);
    if (m.status === "connected") out.push(cmd("Disconnect", "mcp-disconnect", "mcpDisconnect"));
    else if (m.status === "disabled") out.push(cmd("Connect", "mcp-connect", "mcpConnect"));
    else if (m.status === "failed") out.push(cmd("Retry", "mcp-retry", "mcpConnect"));
    else if (m.status === "needs_auth")
      out.push(
        m.integrationID
          ? cmd("Authenticate", "mcp-auth", "mcpAuth")
          : cmd("Retry", "mcp-retry", "mcpConnect"),
      );
    if (m.runtime) out.push(smallBtn("Remove", "mcp-remove", () => void remove(m), busy));
    return out;
  }

  function paint(): void {
    const v = mcpList;
    // A redrawn row's button had the focus: it goes to the same button of the new row.
    const had = document.activeElement as HTMLElement | null;
    const key =
      had && list.contains(had)
        ? {
            name: had.closest<HTMLElement>("[data-name]")?.dataset.name ?? "",
            testid: had.dataset.testid ?? "",
          }
        : null;
    const busy = mcpBusy;
    status.hidden = !busy;
    status.textContent = busy ? (busy.name ? `${busy.name}: ${busy.text}` : busy.text) : "";
    reloadBtn.disabled = addBtn.disabled = !!busy || adding;
    if (!v) {
      list.replaceChildren();
      listNote.textContent =
        v === undefined ? "Loading…" : `Couldn't load them: ${mcpError || "OpenCode did not answer."}`;
      return;
    }
    list.replaceChildren(
      ...v.map((m) => {
        const acts = actions(m, !!busy);
        const meta = [
          m.title && m.title !== m.name ? m.name : "",
          m.runtime ? "added for this OpenCode run" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return h(
          "li",
          { className: `rule provider mcp s-${m.status}`, "data-testid": "mcp-row", "data-name": m.name },
          h(
            "div",
            { className: "provider-head" },
            h("span", { className: "provider-name", dir: "auto" }, m.title || m.name),
            h(
              "span",
              { className: `provider-state ${MCP_STATE_CLASS[m.status]}`, "data-testid": "mcp-state" },
              busy?.name === m.name ? busy.text : MCP_STATES[m.status],
            ),
          ),
          meta ? h("div", { className: "provider-meta" }, meta) : null,
          m.error
            ? h("div", { className: "provider-error", "data-testid": "mcp-error", dir: "auto" }, m.error)
            : null,
          acts.length ? h("div", { className: "provider-actions" }, ...acts) : null,
        );
      }),
    );
    listNote.textContent = v.length
      ? ""
      : "No MCP servers for this folder. They are set up in OpenCode's config, or added below for this run.";
    if (key)
      queueMicrotask(() => {
        if (had?.isConnected) return;
        const row = dialog.querySelector<HTMLElement>(`[data-name="${CSS.escape(key.name)}"]`);
        const same = row?.querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(key.testid)}"]`);
        (same && !same.disabled ? same : doneBtn).focus();
      });
  }

  document.body.append(backdrop);
  mcpPanel = {
    paint,
    added: (ok, error) => {
      adding = false;
      if (ok) {
        nameIn.value = targetIn.value = "";
        showAddError("");
      } else showAddError(error || "OpenCode could not add it.");
      paint();
    },
  };
  paint();
  doneBtn.focus();
}

// ------------------------------------------------------- approval and rules
//
// The approval badge in the header shows the open session's mode as OpenCode reports it
// and opens a menu to switch. The rules editor lists the session's rules (its mode's,
// read-only, then the user's own) and the folder's "always allow" rules OpenCode saved.

/** undefined while loading; null when OpenCode could not list them. */
let savedPerms: SavedPermission[] | null | undefined;
let savedError = "";
/** Where a mode picked in the menu applies: the open session, or also new ones in the folder. */
let approvalScope: "session" | "folder" = "session";

const approvalBtn = h("button", {
  className: "p-approval",
  "aria-haspopup": "menu",
  "data-testid": "approval-badge",
  onclick: () => openApprovalMenu(),
});

function paintApproval(s: ViewState): void {
  const ap = s.approval;
  approvalBtn.dataset.mode = ap.mode;
  approvalBtn.disabled = s.connection.kind !== "connected";
  approvalBtn.classList.toggle("busy", ap.busy);
  approvalBtn.replaceChildren(icon("allowed"), h("span", { className: "pa-label" }, MODE_LABELS[ap.mode]));
  const what = ap.mode === "default" || ap.mode === "custom" ? "" : ` · ${MODE_LINES[ap.mode]}`;
  const tip = `Approval: ${MODE_LABELS[ap.mode]}${ap.session ? "" : " (next session)"}${what}`;
  approvalBtn.dataset.tip = tip;
  approvalBtn.setAttribute("aria-label", `${tip} Change`);
}

function openApprovalMenu(): void {
  openMenu(approvalBtn, approvalMenu(), {
    width: 340,
    align: "end",
    title: state?.approval.session === false ? "Approval for the next session" : "Approval",
    maxHeight: 360,
    footer: [
      slider(
        "Apply to",
        [
          { value: "session", label: "This session" },
          { value: "folder", label: "This folder" },
        ],
        approvalScope,
        (v) => {
          approvalScope = v === "folder" ? "folder" : "session";
        },
        "approval-scope",
      ),
    ],
  });
}

function approvalMenu(): MenuEntry[] {
  const ap = state?.approval;
  if (!ap) return [];
  const out: MenuEntry[] = [];
  for (const m of [...APPROVAL_MODES, "default" as const])
    out.push(
      item(MODE_LABELS[m], () => void pickMode(m), {
        sub: MODE_LINES[m],
        checked: ap.mode === m,
        detail: ap.folderMode === m ? "folder" : undefined,
        disabled: ap.busy,
        testid: `approval-${m}`,
      }),
    );
  if (ap.mode === "custom")
    out.push(note("This session's rules match no mode. Picking one keeps your own rules after it."));
  out.push(
    note("An agent's own blocks stay: Plan still never edits. This folder: new sessions start in the mode."),
    sep(),
    item("Permission rules…", () => openRulesEditor(), {
      icon: "allowed",
      sub: "The session's rules and the folder's always-allowed ones",
      testid: "approval-rules",
    }),
  );
  return out;
}

async function pickMode(mode: ApprovalMode | "default"): Promise<void> {
  const ap = state?.approval;
  if (!ap) return;
  let dontAskAgain = false;
  if (mode === "auto" && ap.confirmAuto && ap.mode !== "auto") {
    const pick = await confirmDialog({
      title: "Switch to Auto?",
      body: "The agent edits files, runs commands and fetches pages without asking. rm -rf, force pushes and other destructive commands stay blocked, and the Auto badge stays in the header.",
      choices: [
        { value: "always", label: "Switch, and don't ask again", testid: "auto-dont-ask" },
        { value: "auto", label: "Switch to Auto", testid: "auto-confirm" },
      ],
    });
    if (!pick) return;
    dontAskAgain = pick === "always";
  }
  send(
    dontAskAgain
      ? { type: "setApprovalMode", mode, scope: approvalScope, dontAskAgain }
      : { type: "setApprovalMode", mode, scope: approvalScope },
  );
}

const EFFECT_LABELS: Record<RuleEffect, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };

let rulesEditor: { el: HTMLElement; paint: () => void; before: HTMLElement | null } | null = null;
/** The session rule being edited (its index in the session's own rules), or null to add one. */
let ruleEditing: number | null = null;
/** The saved rule being edited, with its fields as typed. */
let savedEditing: { id: string; action: string; resource: string } | null = null;

function ruleRow(
  r: { action: string; resource: string; effect: RuleEffect },
  testid: string,
  tail: Array<Node | null>,
): HTMLElement {
  return h(
    "li",
    { className: "rule", "data-testid": testid },
    h("span", { className: `rule-effect e-${r.effect}` }, EFFECT_LABELS[r.effect]),
    h("code", { className: "rule-action" }, r.action),
    h("code", { className: "rule-pattern", dir: "ltr" }, r.resource),
    ...nonNull(tail),
  );
}

const smallBtn = (label: string, testid: string, onclick: () => void, disabled = false) =>
  h("button", { className: "btn subtle small", "data-testid": testid, disabled, onclick }, label);

function openRulesEditor(): void {
  if (rulesEditor) return;
  closePopovers();
  savedPerms = undefined;
  ruleEditing = null;
  savedEditing = null;
  send({ type: "loadSavedPermissions" });
  const before = document.activeElement as HTMLElement | null;
  // The add/edit form is built once, so typing survives updates of the lists around it.
  const actionIn = h("input", {
    className: "rule-in",
    type: "text",
    list: "rule-actions",
    "aria-label": "Action",
    placeholder: "shell",
    "data-testid": "rule-action",
  }) as HTMLInputElement;
  const actionList = h("datalist", { id: "rule-actions" });
  const patternIn = h("input", {
    className: "rule-in grow",
    type: "text",
    dir: "ltr",
    "aria-label": "Pattern",
    placeholder: "npm test *",
    "data-testid": "rule-pattern",
  }) as HTMLInputElement;
  const effectIn = h(
    "select",
    { className: "rule-in", "aria-label": "Effect", "data-testid": "rule-effect" },
    ...(["allow", "ask", "deny"] as const).map((e) => h("option", { value: e }, EFFECT_LABELS[e])),
  ) as HTMLSelectElement;
  const formError = h("div", { className: "rule-error", role: "alert", "data-testid": "rule-error" });
  const saveBtn = h("button", { className: "btn", "data-testid": "rule-save" }, "Add rule");
  const cancelBtn = h(
    "button",
    { className: "btn subtle", "data-testid": "rule-cancel", hidden: true },
    "Cancel",
  );
  const resetForm = () => {
    ruleEditing = null;
    actionIn.value = "shell";
    patternIn.value = "";
    effectIn.value = "allow";
    formError.textContent = "";
  };
  resetForm();
  const submit = () => {
    const ap = state?.approval;
    if (!ap?.session) return;
    const r = { action: actionIn.value.trim(), resource: patternIn.value.trim(), effect: effectIn.value };
    if (!/^[\w.*?:-]{1,100}$/.test(r.action)) {
      formError.textContent = "Pick an action, such as shell or edit.";
      return actionIn.focus();
    }
    if (!r.resource) {
      formError.textContent = "Type a pattern; * matches anything.";
      return patternIn.focus();
    }
    const rule = r as { action: string; resource: string; effect: RuleEffect };
    const rules = [...ap.rules];
    if (ruleEditing !== null && ruleEditing < rules.length) rules[ruleEditing] = rule;
    else rules.push(rule);
    send({ type: "setSessionRules", rules });
    resetForm();
    paint();
  };
  saveBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => {
    resetForm();
    paint();
  });
  for (const f of [actionIn, patternIn])
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  const form = h(
    "div",
    { className: "rule-form", "data-testid": "rule-form" },
    actionIn,
    actionList,
    patternIn,
    effectIn,
    saveBtn,
    cancelBtn,
  );
  const sessionList = h("ul", { className: "rules-list", "data-testid": "session-rules" });
  const sessionNote = h("p", { className: "rules-note" });
  const savedList = h("ul", { className: "rules-list", "data-testid": "saved-rules" });
  const savedNote = h("p", { className: "rules-note" });
  const close = () => {
    rulesEditor = null;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (before?.isConnected) before.focus();
  };
  const doneBtn = h("button", { className: "btn", "data-testid": "rules-close", onclick: close }, "Done");
  const dialog = h(
    "div",
    {
      className: "modal rules-editor",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "rules-title",
      "data-testid": "rules-editor",
      tabindex: "-1",
    },
    h("h2", { id: "rules-title" }, "Permission rules"),
    h(
      "p",
      { className: "rules-note" },
      "OpenCode checks the agent's rules, then the session's; the last one that matches decides. * matches anything.",
    ),
    h("h3", {}, "This session"),
    sessionList,
    sessionNote,
    form,
    formError,
    h("h3", {}, "This folder: always allowed"),
    savedList,
    savedNote,
    h("div", { className: "modal-foot" }, doneBtn),
  );
  const backdrop = h(
    "div",
    {
      className: "modal-backdrop",
      onmousedown: (e: Event) => {
        if (e.target === backdrop) close();
      },
    },
    dialog,
  );
  // On the document: a list redrawn under the focus must not leave Escape and Tab unheard.
  const onKey = (e: KeyboardEvent) => {
    if (dialogOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (savedEditing || ruleEditing !== null) {
        savedEditing = null;
        resetForm();
        paint();
      } else close();
    } else if (e.key === "Tab") {
      // Focus stays inside while it is open.
      const f = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select")).filter(
        (x) => !(x as HTMLButtonElement).disabled && !x.hidden,
      );
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);

  function paint(): void {
    const ap = state?.approval;
    if (!ap) return;
    // A redrawn row's button had the focus: it goes to the same button of the new row.
    const had = document.activeElement as HTMLElement | null;
    const hadList = had && (sessionList.contains(had) || savedList.contains(had)) ? had : null;
    const hadKey = hadList
      ? [
          hadList.dataset.testid,
          Array.from(dialog.querySelectorAll(`[data-testid="${hadList.dataset.testid}"]`)).indexOf(hadList),
        ]
      : null;
    queueMicrotask(() => {
      const now = document.activeElement;
      if (!hadKey || hadList?.isConnected || (now && now !== document.body && dialog.contains(now))) return;
      const same = dialog.querySelectorAll<HTMLElement>(`[data-testid="${hadKey[0]}"]`)[hadKey[1] as number];
      (same && !(same as HTMLButtonElement).disabled ? same : dialog).focus();
    });
    actionList.replaceChildren(...ap.actions.map((a) => h("option", { value: a })));
    const busy = ap.busy;
    const label = MODE_LABELS[ap.mode];
    const editRow = (i: number) => () => {
      const r = ap.rules[i];
      ruleEditing = i;
      actionIn.value = r.action;
      patternIn.value = r.resource;
      effectIn.value = r.effect;
      formError.textContent = "";
      paint();
      patternIn.focus();
    };
    sessionList.replaceChildren(
      ...ap.modeRules.map((r) =>
        ruleRow(r, "mode-rule", [h("span", { className: "rule-from" }, `from ${label}`)]),
      ),
      ...ap.rules.map((r, i) =>
        ruleRow(r, "session-rule", [
          smallBtn("Edit", "rule-edit", editRow(i), busy || !ap.session),
          smallBtn(
            "Delete",
            "rule-delete",
            () => {
              if (ruleEditing === i) resetForm();
              send({ type: "setSessionRules", rules: ap.rules.filter((_, j) => j !== i) });
            },
            busy || !ap.session,
          ),
        ]),
      ),
    );
    sessionNote.textContent = !ap.session
      ? "Start or open a session to give it rules of its own; the next session starts with these."
      : ap.rules.length
        ? ""
        : "No rules of your own yet. Add one below; it applies after the mode's.";
    form.hidden = !ap.session;
    saveBtn.textContent = ruleEditing === null ? "Add rule" : "Save rule";
    cancelBtn.hidden = ruleEditing === null;
    saveBtn.disabled = busy;
    if (savedPerms === undefined) {
      savedList.replaceChildren();
      savedNote.textContent = "Loading…";
    } else if (savedPerms === null) {
      savedList.replaceChildren();
      savedNote.textContent = `Couldn't load them: ${savedError || "OpenCode did not answer."}`;
    } else {
      const list = savedPerms;
      savedList.replaceChildren(
        ...list.map((r) => {
          if (savedEditing?.id === r.id) {
            const ed = savedEditing;
            const a = h("input", {
              className: "rule-in",
              type: "text",
              list: "rule-actions",
              "aria-label": "Action",
              "data-testid": "saved-action",
            }) as HTMLInputElement;
            const p = h("input", {
              className: "rule-in grow",
              type: "text",
              dir: "ltr",
              "aria-label": "Pattern",
              "data-testid": "saved-pattern",
            }) as HTMLInputElement;
            a.value = ed.action;
            p.value = ed.resource;
            a.addEventListener("input", () => (ed.action = a.value));
            p.addEventListener("input", () => (ed.resource = p.value));
            const save = () => {
              const action = a.value.trim();
              const resource = p.value.trim();
              if (!/^[\w.*?:-]{1,100}$/.test(action) || !resource) return;
              savedEditing = null;
              savedPerms = undefined;
              send({ type: "updateSavedPermission", id: r.id, action, resource });
              paint();
            };
            p.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            });
            return h(
              "li",
              { className: "rule editing", "data-testid": "saved-permission" },
              h("span", { className: "rule-effect e-allow" }, "Allow"),
              a,
              p,
              smallBtn("Save", "saved-save", save),
              smallBtn("Cancel", "saved-cancel", () => {
                savedEditing = null;
                paint();
              }),
            );
          }
          return ruleRow({ ...r, effect: "allow" }, "saved-permission", [
            r.created ? h("span", { className: "rule-from" }, relativeTime(r.created)) : null,
            smallBtn("Edit", "saved-edit", () => {
              savedEditing = { id: r.id, action: r.action, resource: r.resource };
              paint();
              savedList.querySelector<HTMLInputElement>('[data-testid="saved-pattern"]')?.focus();
            }),
            smallBtn("Remove", "saved-remove", () => {
              savedPerms = undefined;
              send({ type: "removeSavedPermission", id: r.id });
              paint();
            }),
          ]);
        }),
      );
      savedNote.textContent = list.length
        ? "OpenCode allows matching requests in this folder without asking. Removing one makes it ask again."
        : "Nothing is always allowed here. Yes, always allow on a request adds a rule here.";
    }
  }

  document.body.append(backdrop);
  rulesEditor = { el: backdrop, paint, before };
  paint();
  (form.hidden ? doneBtn : patternIn).focus();
}

// -------------------------------------------------------------- providers
//
// The Providers panel: the providers OpenCode is connected to and how each is doing, and
// a search over every provider OpenCode can connect. Connect, Re-authenticate and
// Disconnect are run by the host through OpenCode's own sign-in; nothing secret reaches
// the webview.

/** undefined while loading; null when OpenCode could not list them. */
let providersView: ProvidersView | null | undefined;
let providersError = "";
let providersPanel: { el: HTMLElement; paint: () => void } | null = null;
/** At most this many search results are drawn (OpenCode knows hundreds of providers). */
const PROVIDER_RESULTS = 40;

const PROVIDER_STATES: Record<ProviderRow["state"], string> = {
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  error: "Error",
};

function openProviders(): void {
  if (providersPanel) {
    send({ type: "loadProviders" });
    return;
  }
  closePopovers();
  providersView = undefined;
  send({ type: "loadProviders" });
  const before = document.activeElement as HTMLElement | null;
  // Built once, so what is typed survives the list being redrawn.
  const search = h("input", {
    className: "rule-in grow",
    type: "search",
    "aria-label": "Search providers",
    placeholder: "Search providers",
    "data-testid": "providers-search",
  }) as HTMLInputElement;
  search.addEventListener("input", () => paint());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      availableList.querySelector<HTMLButtonElement>("button:not(:disabled)")?.click();
    }
  });
  const status = h("p", { className: "banner info", role: "status", "data-testid": "providers-busy" });
  const connectedList = h("ul", { className: "rules-list", "data-testid": "providers-connected" });
  const connectedNote = h("p", { className: "rules-note" });
  const availableList = h("ul", { className: "rules-list", "data-testid": "providers-available" });
  const availableNote = h("p", { className: "rules-note", "data-testid": "providers-more" });
  const close = () => {
    providersPanel = null;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (before?.isConnected) before.focus();
  };
  const reloadBtn = h(
    "button",
    {
      className: "btn subtle",
      "data-testid": "providers-reload",
      "data-tip": "Have OpenCode read its config again (after editing opencode.json)",
      onclick: () => send({ type: "reloadProviders" }),
    },
    "Reload config",
  );
  const checkBtn = h(
    "button",
    {
      className: "btn subtle",
      "data-testid": "providers-check",
      onclick: () => send({ type: "checkSetup" }),
    },
    "Check setup",
  );
  const doneBtn = h("button", { className: "btn", "data-testid": "providers-close", onclick: close }, "Done");
  const dialog = h(
    "div",
    {
      className: "modal rules-editor providers-panel",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "providers-title",
      "data-testid": "providers-panel",
      tabindex: "-1",
    },
    h("h2", { id: "providers-title" }, "Providers"),
    h(
      "p",
      { className: "rules-note" },
      "OpenCode signs in and stores the keys. Sidecar never sees or keeps them.",
    ),
    status,
    h("h3", {}, "Connected"),
    connectedList,
    connectedNote,
    h("h3", {}, "Connect a provider"),
    h("div", { className: "rule-form" }, search),
    availableList,
    availableNote,
    h("div", { className: "modal-foot providers-foot" }, reloadBtn, checkBtn, doneBtn),
  );
  const backdrop = h(
    "div",
    {
      className: "modal-backdrop",
      onmousedown: (e: Event) => {
        if (e.target === backdrop) close();
      },
    },
    dialog,
  );
  const onKey = (e: KeyboardEvent) => {
    if (dialogOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (search.value && document.activeElement === search) {
        search.value = "";
        paint();
      } else close();
    } else if (e.key === "Tab") {
      const f = Array.from(dialog.querySelectorAll<HTMLElement>("button, input")).filter(
        (x) => !(x as HTMLButtonElement).disabled && !x.hidden,
      );
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);

  async function disconnect(r: ProviderRow): Promise<void> {
    const pick = await confirmDialog({
      title: `Disconnect ${r.name}?`,
      body: "OpenCode removes the key or sign-in it stored for this provider. Its models stop working until you connect it again.",
      choices: [{ value: "yes", label: "Disconnect", danger: true, testid: "provider-disconnect-confirm" }],
    });
    if (pick === "yes") send({ type: "providerDisconnect", id: r.id });
  }

  function paint(): void {
    const v = providersView;
    // A redrawn row's button had the focus: it goes to the same button of the new row.
    const had = document.activeElement as HTMLElement | null;
    const key =
      had && (connectedList.contains(had) || availableList.contains(had))
        ? `${had.closest<HTMLElement>("[data-id]")?.dataset.id ?? ""} ${had.dataset.testid ?? ""}`
        : null;
    const busy = v?.busy ?? null;
    status.hidden = !busy;
    status.textContent = busy?.text ?? "";
    reloadBtn.disabled = checkBtn.disabled = !!busy && busy.id === "";
    if (v === undefined) {
      connectedList.replaceChildren();
      availableList.replaceChildren();
      connectedNote.textContent = "Loading…";
      availableNote.textContent = "";
      return;
    }
    if (v === null) {
      connectedList.replaceChildren();
      availableList.replaceChildren();
      connectedNote.textContent = `Couldn't load them: ${providersError || "OpenCode did not answer."}`;
      availableNote.textContent = "";
      return;
    }
    connectedList.replaceChildren(
      ...v.connected.map((r) =>
        h(
          "li",
          { className: `rule provider s-${r.state}`, "data-testid": "provider-row", "data-id": r.id },
          h(
            "div",
            { className: "provider-head" },
            h("span", { className: "provider-name", dir: "auto" }, r.name),
            h(
              "span",
              { className: `provider-state s-${r.state}`, "data-testid": "provider-state" },
              PROVIDER_STATES[r.state],
            ),
          ),
          h(
            "div",
            { className: "provider-meta" },
            [r.via, `${r.models} model${r.models === 1 ? "" : "s"}`, r.local ? "on this machine" : ""]
              .filter(Boolean)
              .join(" · "),
          ),
          r.error
            ? h("div", { className: "provider-error", "data-testid": "provider-error", dir: "auto" }, r.error)
            : null,
          r.canReauth || r.canDisconnect
            ? h(
                "div",
                { className: "provider-actions" },
                r.canReauth
                  ? smallBtn(
                      r.state === "needs-auth" ? "Sign in again" : "Re-authenticate",
                      "provider-reauth",
                      () => send({ type: "providerReauth", id: r.id }),
                      !!busy,
                    )
                  : null,
                r.canDisconnect
                  ? smallBtn("Disconnect", "provider-disconnect", () => void disconnect(r), !!busy)
                  : null,
              )
            : null,
        ),
      ),
    );
    connectedNote.textContent = v.connected.length
      ? ""
      : "No provider is connected yet. Connect one below, or use OpenCode's free models.";
    const q = search.value.trim().toLowerCase();
    const matches = q
      ? v.available.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      : v.available.filter((c) => c.popular);
    availableList.replaceChildren(
      ...matches.slice(0, PROVIDER_RESULTS).map((c) =>
        h(
          "li",
          { className: "rule provider choice", "data-testid": "provider-choice", "data-id": c.id },
          h(
            "div",
            { className: "provider-head" },
            h("span", { className: "provider-name", dir: "auto" }, c.name),
            h("span", { className: "provider-meta" }, c.methods),
          ),
          smallBtn("Connect", "provider-connect", () => send({ type: "providerConnect", id: c.id }), !!busy),
        ),
      ),
    );
    availableNote.textContent = !q
      ? `Popular providers. Search all ${v.available.length}.`
      : !matches.length
        ? `No provider matches “${search.value.trim()}”.`
        : matches.length > PROVIDER_RESULTS
          ? `${matches.length - PROVIDER_RESULTS} more match. Keep typing to narrow them down.`
          : "";
    if (key)
      queueMicrotask(() => {
        if (had?.isConnected) return;
        const [id, testid] = key.split(" ");
        const row = dialog.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        const same = row?.querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(testid)}"]`);
        (same && !same.disabled ? same : search).focus();
      });
  }

  document.body.append(backdrop);
  providersPanel = { el: backdrop, paint };
  paint();
  search.focus();
}

// ----------------------------------------------------------------- agents
//
// The Agents panel: OpenCode's agents for the folder (built-in ones read-only), a form
// that creates or edits a custom agent's Markdown file, and the import of Roo Code and
// Kilo Code modes. The host reads and writes the files and asks before it replaces one
// or writes outside the folder; the webview only sends the form's fields.

/** undefined while loading; null when OpenCode could not list them. */
let agentsView: AgentsView | null | undefined;
let agentsError = "";
let agentsPanel: {
  paint: () => void;
  result: (r: { ok: boolean; error?: string }) => void;
  preview: (p: ImportPreview | null, error?: string) => void;
  showImport: () => void;
} | null = null;

const AGENT_MODES: Record<AgentMode, string> = {
  primary: "Primary",
  subagent: "Subagent",
  all: "Primary and subagent",
};
const AGENT_SOURCES: Record<AgentRow["source"], string> = {
  "built-in": "Built-in",
  project: "This project",
  global: "Global",
  config: "Config file",
};
const AGENT_SWITCHES: Array<[AgentAction, string]> = [
  ["read", "Read files"],
  ["edit", "Edit files"],
  ["shell", "Run commands"],
  ["webfetch", "Fetch web pages"],
  ["websearch", "Search the web"],
  ["subagent", "Start subagents"],
  ["skill", "Use skills"],
];

function blankDraft(): AgentDraft {
  return {
    name: "",
    description: "",
    mode: "primary",
    model: null,
    variant: null,
    temperature: null,
    permissions: {},
    prompt: "",
    scope: "project",
  };
}

function openAgents(o: { import?: boolean } = {}): void {
  if (agentsPanel) {
    send({ type: "loadAgents" });
    if (o.import) agentsPanel.showImport();
    return;
  }
  closePopovers();
  agentsView = undefined;
  send({ type: "loadAgents" });
  const before = document.activeElement as HTMLElement | null;
  let page: "list" | "form" | "import" = "list";
  let saving = false;
  const title = h("h2", { id: "agents-title" }, "Agents");
  const body = h("div", { className: "agents-body" });
  const foot = h("div", { className: "modal-foot providers-foot" });
  const close = () => {
    agentsPanel = null;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (before?.isConnected) before.focus();
  };
  const dialog = h(
    "div",
    {
      className: "modal rules-editor agents-panel",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "agents-title",
      "data-testid": "agents-panel",
      tabindex: "-1",
    },
    title,
    body,
    foot,
  );
  const backdrop = h(
    "div",
    {
      className: "modal-backdrop",
      onmousedown: (e: Event) => {
        if (e.target === backdrop && page === "list") close();
      },
    },
    dialog,
  );
  const onKey = (e: KeyboardEvent) => {
    if (dialogOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (page !== "list" && !saving) showList();
      else if (page === "list") close();
    } else if (e.key === "Tab") {
      const f = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea")).filter(
        (x) => !(x as HTMLButtonElement).disabled && !x.hidden && x.offsetParent !== null,
      );
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);

  // ------------------------------------------------------------ the list

  async function remove(a: AgentRow): Promise<void> {
    const pick = await confirmDialog({
      title: `Delete ${a.name}?`,
      body: `${a.file ?? "Its file"} is deleted, and OpenCode stops offering this agent. This can't be undone.`,
      choices: [{ value: "yes", label: "Delete", danger: true, testid: "agent-delete-confirm" }],
    });
    if (pick === "yes") send({ type: "deleteAgent", id: a.id });
  }

  function agentRow(a: AgentRow): HTMLElement {
    const busy = !!agentsView?.busy;
    const custom = a.source === "project" || a.source === "global";
    const meta = [
      a.model ? agentModelName(a.model) : "",
      a.file ?? (a.source === "built-in" ? "Built into OpenCode" : ""),
    ].filter(Boolean);
    return h(
      "li",
      {
        className: `rule provider agent-row${a.problem ? " s-error" : ""}`,
        "data-testid": "agent-row",
        "data-id": a.id,
      },
      h(
        "div",
        { className: "provider-head" },
        h("span", { className: "provider-name", dir: "auto" }, a.name),
        h("span", { className: "agent-badge", "data-testid": "agent-mode" }, AGENT_MODES[a.mode]),
        h(
          "span",
          { className: `agent-badge src-${a.source}`, "data-testid": "agent-source" },
          AGENT_SOURCES[a.source] + (custom ? "" : " · read-only"),
        ),
      ),
      a.description ? h("div", { className: "agent-desc", dir: "auto" }, a.description) : null,
      meta.length
        ? h("div", { className: "provider-meta", "data-testid": "agent-meta" }, meta.join(" · "))
        : null,
      a.problem
        ? h("div", { className: "provider-error", "data-testid": "agent-problem", dir: "auto" }, a.problem)
        : null,
      a.editable || a.file
        ? h(
            "div",
            { className: "provider-actions" },
            a.editable ? smallBtn("Edit", "agent-edit", () => showForm(a), busy) : null,
            a.file
              ? smallBtn("Open file", "agent-open", () => send({ type: "openAgentFile", id: a.id }))
              : null,
            custom ? smallBtn("Delete", "agent-delete", () => void remove(a), busy) : null,
          )
        : null,
    );
  }

  function showList(): void {
    page = "list";
    title.textContent = "Agents";
    paint();
    dialog.focus();
  }

  function paint(): void {
    if (page !== "list") {
      const status = dialog.querySelector<HTMLElement>("[data-testid=agents-busy]");
      if (status) status.textContent = agentsView?.busy ?? "";
      return;
    }
    const v = agentsView;
    const had = document.activeElement as HTMLElement | null;
    const key =
      had && body.contains(had)
        ? `${had.closest<HTMLElement>("[data-id]")?.dataset.id ?? ""} ${had.dataset.testid ?? ""}`
        : null;
    const list = h("ul", { className: "rules-list", "data-testid": "agents-list" });
    const note = h("p", { className: "rules-note", "data-testid": "agents-note" });
    const parts: Node[] = [
      h(
        "p",
        { className: "rules-note" },
        "Custom agents are Markdown files: the frontmatter sets the mode, model and permissions, the text is the system prompt.",
      ),
    ];
    if (v?.busy)
      parts.push(h("p", { className: "banner info", role: "status", "data-testid": "agents-busy" }, v.busy));
    if (v?.importable) {
      const n = v.importable.count;
      parts.push(
        h(
          "div",
          { className: "banner info agents-import", "data-testid": "agents-import-banner" },
          h(
            "span",
            {},
            `Found ${n} Roo Code mode${n === 1 ? "" : "s"} in ${v.importable.sources.join(", ")}.`,
          ),
          smallBtn(
            `Import ${n} mode${n === 1 ? "" : "s"} as agents…`,
            "agents-import-open",
            () => showImport(),
            !!v.busy,
          ),
        ),
      );
    }
    if (v === undefined) note.textContent = "Loading…";
    else if (v === null)
      note.textContent = `Couldn't load them: ${agentsError || "OpenCode did not answer."}`;
    else {
      list.append(...v.agents.map(agentRow));
      if (!v.agents.length) note.textContent = "OpenCode reports no agents for this folder.";
    }
    parts.push(list, note);
    body.replaceChildren(...parts);
    foot.replaceChildren(
      h(
        "button",
        {
          className: "btn primary",
          "data-testid": "agents-new",
          disabled: !v || !!v.busy,
          onclick: () => showForm(null),
        },
        "New agent",
      ),
      h(
        "button",
        {
          className: "btn subtle",
          "data-testid": "agents-import",
          disabled: !v || !!v.busy,
          onclick: () => showImport(),
        },
        "Import modes…",
      ),
      h("button", { className: "btn", "data-testid": "agents-close", onclick: close }, "Done"),
    );
    if (key)
      queueMicrotask(() => {
        const [id, testid] = key.split(" ");
        const row = dialog.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        const same = row?.querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(testid)}"]`);
        (same && !same.disabled ? same : dialog).focus();
      });
  }

  // ------------------------------------------------------------ the form

  function showForm(a: AgentRow | null): void {
    page = "form";
    saving = false;
    const d: AgentDraft = a?.draft ? structuredClone(a.draft) : blankDraft();
    title.textContent = a ? `Edit ${a.name}` : "New agent";
    const field = (label: string, input: HTMLElement, hint?: string) =>
      h(
        "label",
        { className: "agent-field" },
        h("span", { className: "agent-label" }, label),
        input,
        hint ? h("span", { className: "agent-hint" }, hint) : null,
      );
    const nameIn = h("input", {
      className: "rule-in grow",
      type: "text",
      dir: "ltr",
      spellcheck: "false",
      maxlength: "64",
      placeholder: "docs-writer",
      "data-testid": "agent-name",
      disabled: !!a,
    }) as HTMLInputElement;
    nameIn.value = a ? a.id : d.name;
    const descIn = h("input", {
      className: "rule-in grow",
      type: "text",
      maxlength: "500",
      placeholder: "What it does, and when to use it",
      "data-testid": "agent-description",
    }) as HTMLInputElement;
    descIn.value = d.description;
    const modeIn = h(
      "select",
      { className: "rule-in grow", "data-testid": "agent-mode-select" },
      h("option", { value: "primary" }, "Primary: you pick it for a session"),
      h("option", { value: "subagent" }, "Subagent: other agents start it"),
      h("option", { value: "all" }, "Both"),
    ) as HTMLSelectElement;
    modeIn.value = d.mode;
    const models = state?.models ?? [];
    const byProvider = new Map<string, ModelOption[]>();
    for (const m of models) byProvider.set(m.providerName, [...(byProvider.get(m.providerName) ?? []), m]);
    const modelIn = h(
      "select",
      { className: "rule-in grow", "data-testid": "agent-model" },
      h("option", { value: "" }, "The session's model"),
      ...[...byProvider].map(([provider, list]) =>
        h("optgroup", { label: provider }, ...list.map((m) => h("option", { value: m.key }, m.name))),
      ),
    ) as HTMLSelectElement;
    if (d.model && !models.some((m) => m.key === d.model))
      modelIn.append(h("option", { value: d.model }, `${d.model} (not offered now)`));
    modelIn.value = d.model ?? "";
    const variantIn = h("select", {
      className: "rule-in",
      "data-testid": "agent-variant",
    }) as HTMLSelectElement;
    const paintVariants = () => {
      const m = models.find((x) => x.key === modelIn.value);
      const list = m?.variants ?? [];
      variantIn.replaceChildren(
        h("option", { value: "" }, "Default"),
        ...list.map((x) => h("option", { value: x }, x)),
      );
      if (d.variant && !list.includes(d.variant) && modelIn.value === d.model)
        variantIn.append(h("option", { value: d.variant }, d.variant));
      variantIn.value = modelIn.value === d.model ? (d.variant ?? "") : "";
      variantField.hidden = variantIn.options.length < 2;
    };
    const tempIn = h("input", {
      className: "rule-in",
      type: "number",
      min: "0",
      max: "2",
      step: "0.1",
      placeholder: "Default",
      "data-testid": "agent-temperature",
    }) as HTMLInputElement;
    tempIn.value = d.temperature === null ? "" : String(d.temperature);
    const switches = AGENT_SWITCHES.map(([action, label]) => {
      const sel = h(
        "select",
        { className: "rule-in", "aria-label": label, "data-testid": `agent-perm-${action}` },
        h("option", { value: "" }, "Inherit"),
        h("option", { value: "allow" }, "Allow"),
        h("option", { value: "ask" }, "Ask"),
        h("option", { value: "deny" }, "Deny"),
      ) as HTMLSelectElement;
      sel.value = d.permissions[action] ?? "";
      return { action, sel, row: h("div", { className: "agent-perm" }, h("span", {}, label), sel) };
    });
    const promptIn = h("textarea", {
      className: "rule-in agent-prompt",
      rows: "8",
      placeholder: "You are a careful technical writer. …",
      "data-testid": "agent-prompt",
    }) as HTMLTextAreaElement;
    promptIn.value = d.prompt;
    const scopeIn = h(
      "select",
      { className: "rule-in grow", "data-testid": "agent-scope" },
      h("option", { value: "project" }, `This project (${agentsView?.projectDir ?? ".opencode/agents"})`),
      agentsView?.globalDir ? h("option", { value: "global" }, `Global (${agentsView.globalDir})`) : null,
    ) as HTMLSelectElement;
    scopeIn.value = d.scope;
    const error = h("div", { className: "rule-error", role: "alert", "data-testid": "agent-error" });
    const status = h("p", { className: "rules-note", role: "status", "data-testid": "agents-busy" });
    const variantField = field("Variant", variantIn);
    modelIn.addEventListener("change", paintVariants);
    const taken = (agentsView?.agents ?? []).map((x) => x.id);

    const collect = (): AgentDraft | null => {
      error.textContent = "";
      const name = nameIn.value.trim();
      const problem = a ? null : validateAgentName(name, taken);
      if (problem) {
        error.textContent = problem;
        nameIn.focus();
        return null;
      }
      const t = tempIn.value.trim();
      const temperature = t === "" ? null : Number(t);
      if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        error.textContent = "Temperature is a number from 0 to 2, or empty for the model's default.";
        tempIn.focus();
        return null;
      }
      const permissions: AgentDraft["permissions"] = {};
      for (const s of switches)
        if (s.sel.value) permissions[s.action] = s.sel.value as "allow" | "ask" | "deny";
      return {
        name: a ? a.id : name,
        description: descIn.value.trim(),
        mode: modeIn.value as AgentMode,
        model: modelIn.value || null,
        variant: modelIn.value ? variantIn.value || null : null,
        temperature,
        permissions,
        prompt: promptIn.value,
        scope: a ? d.scope : (scopeIn.value as AgentDraft["scope"]),
      };
    };
    const save = (open: boolean) => {
      const draft = collect();
      if (!draft) return;
      saving = true;
      saveBtn.disabled = openBtn.disabled = true;
      status.textContent = "Saving…";
      send({ type: "saveAgent", draft, editing: a ? a.id : null, ...(open ? { open: true } : {}) });
    };
    const saveBtn = h(
      "button",
      { className: "btn primary", "data-testid": "agent-save", onclick: () => save(false) },
      "Save",
    );
    const openBtn = h(
      "button",
      {
        className: "btn subtle",
        "data-testid": "agent-open-editor",
        "data-tip": "Save, then edit the Markdown file itself",
        onclick: () => save(true),
      },
      "Save and open in editor",
    );
    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save(false);
      }
    });
    body.replaceChildren(
      ...nonNull([
        field(
          "Name",
          nameIn,
          a
            ? "The file name; it can't be changed here."
            : "Letters, digits, - and _. It is the file name and how you @mention it.",
        ),
        field("Description", descIn, "OpenCode shows it, and agents read it to pick a subagent."),
        field("Mode", modeIn),
        field("Model", modelIn),
        variantField,
        field(
          "Temperature",
          tempIn,
          "Stored in the agent's request settings; OpenCode 2.4 does not send it to the model yet.",
        ),
        h(
          "fieldset",
          { className: "agent-perms", "data-testid": "agent-perms" },
          h("legend", {}, "Permissions"),
          h("p", { className: "rules-note" }, "Inherit keeps OpenCode's default, which allows most things."),
          ...switches.map((s) => s.row),
          a?.otherRules
            ? h(
                "p",
                { className: "rules-note", "data-testid": "agent-other-rules" },
                `${a.otherRules} more rule${a.otherRules === 1 ? "" : "s"} in the file ${a.otherRules === 1 ? "is" : "are"} kept as ${a.otherRules === 1 ? "it is" : "they are"}.`,
              )
            : null,
        ),
        a?.legacy
          ? h(
              "p",
              { className: "banner info", "data-testid": "agent-legacy" },
              "This file uses OpenCode 1's tools, permission and temperature fields. Changing a permission or the temperature rewrites them as OpenCode 2's permissions and request.",
            )
          : null,
        field("System prompt", promptIn),
        a ? null : field("Save in", scopeIn),
        error,
        status,
      ]),
    );
    foot.replaceChildren(
      h(
        "button",
        { className: "btn subtle", "data-testid": "agent-cancel", onclick: () => showList() },
        "Cancel",
      ),
      openBtn,
      saveBtn,
    );
    paintVariants();
    (a ? descIn : nameIn).focus();
    formResult = (r) => {
      saving = false;
      saveBtn.disabled = openBtn.disabled = false;
      status.textContent = "";
      if (r.ok) showList();
      else error.textContent = r.error ?? "Not saved.";
    };
  }

  let formResult: ((r: { ok: boolean; error?: string }) => void) | null = null;

  // ------------------------------------------------------------ import

  let preview: ImportPreview | null | undefined;
  let previewError = "";
  let importScope: AgentDraft["scope"] = "project";
  const checked = new Set<string>();

  function showImport(): void {
    page = "import";
    saving = false;
    preview = undefined;
    previewError = "";
    title.textContent = "Import Roo Code modes";
    send({ type: "previewImport" });
    paintImport();
    dialog.focus();
  }

  function paintImport(): void {
    if (page !== "import") return;
    const list = h("ul", { className: "rules-list", "data-testid": "import-list" });
    const note = h("p", { className: "rules-note", "data-testid": "import-note" });
    const error = h(
      "div",
      { className: "rule-error", role: "alert", "data-testid": "import-error" },
      previewError,
    );
    const items = preview?.items ?? [];
    if (preview === undefined)
      note.textContent = "Looking for .roomodes, .kilocodemodes and global custom modes…";
    else if (preview === null) note.textContent = previewError || "No modes found.";
    else
      list.append(
        ...items.map((it) => {
          const box = h("input", { type: "checkbox", "data-testid": "import-check" }) as HTMLInputElement;
          box.checked = checked.has(it.key);
          box.addEventListener("change", () => {
            if (box.checked) checked.add(it.key);
            else checked.delete(it.key);
            runBtn.disabled = !checked.size || saving;
            runBtn.textContent = runLabel();
          });
          return h(
            "li",
            { className: "rule provider import-row", "data-testid": "import-row", "data-id": it.key },
            h(
              "label",
              { className: "provider-head" },
              box,
              h("span", { className: "provider-name", dir: "auto" }, it.name),
              h("span", { className: "agent-badge" }, AGENT_MODES[it.mode]),
              h("span", { className: "provider-meta" }, `${it.label} · ${it.source}`),
            ),
            it.description ? h("div", { className: "agent-desc", dir: "auto" }, it.description) : null,
            it.conflict
              ? h("div", { className: "import-conflict", "data-testid": "import-conflict" }, it.conflict)
              : null,
            it.notes.length
              ? h(
                  "ul",
                  { className: "import-notes", "data-testid": "import-notes" },
                  ...it.notes.map((n) => h("li", {}, n)),
                )
              : null,
          );
        }),
      );
    const scopeIn = h(
      "select",
      { className: "rule-in grow", "data-testid": "import-scope" },
      h("option", { value: "project" }, `This project (${agentsView?.projectDir ?? ".opencode/agents"})`),
      agentsView?.globalDir ? h("option", { value: "global" }, `Global (${agentsView.globalDir})`) : null,
    ) as HTMLSelectElement;
    scopeIn.value = importScope;
    scopeIn.addEventListener("change", () => (importScope = scopeIn.value as AgentDraft["scope"]));
    const runLabel = () => `Import ${checked.size} mode${checked.size === 1 ? "" : "s"}`;
    const runBtn = h(
      "button",
      {
        className: "btn primary",
        "data-testid": "import-run",
        disabled: !checked.size || saving,
        onclick: () => {
          if (!checked.size) return;
          saving = true;
          runBtn.disabled = true;
          status.textContent = "Importing…";
          send({
            type: "importModes",
            keys: items.filter((i) => checked.has(i.key)).map((i) => i.key),
            scope: importScope,
          });
        },
      },
      runLabel(),
    );
    const status = h("p", { className: "rules-note", role: "status", "data-testid": "agents-busy" });
    body.replaceChildren(
      ...nonNull([
        h(
          "p",
          { className: "rules-note" },
          "Each mode becomes an agent file. Its role and instructions become the prompt, its tool groups permissions. An orchestrator becomes a primary agent that can start the others as subagents.",
        ),
        list,
        note,
        preview
          ? h(
              "label",
              { className: "agent-field" },
              h("span", { className: "agent-label" }, "Save in"),
              scopeIn,
            )
          : null,
        error,
        status,
      ]),
    );
    foot.replaceChildren(
      ...nonNull([
        h(
          "button",
          { className: "btn subtle", "data-testid": "import-back", onclick: () => showList() },
          "Back",
        ),
        preview ? runBtn : null,
      ]),
    );
    importResult = (r) => {
      saving = false;
      status.textContent = "";
      runBtn.disabled = !checked.size;
      if (r.ok) showList();
      else {
        previewError = r.error ?? "Not imported.";
        error.textContent = previewError;
      }
    };
  }

  let importResult: ((r: { ok: boolean; error?: string }) => void) | null = null;

  document.body.append(backdrop);
  agentsPanel = {
    paint,
    result: (r) => {
      if (page === "form") formResult?.(r);
      else if (page === "import") importResult?.(r);
      else if (!r.ok && r.error) {
        const note = dialog.querySelector<HTMLElement>("[data-testid=agents-note]");
        if (note) note.textContent = r.error;
      }
    },
    preview: (p, err) => {
      preview = p;
      previewError = err ?? "";
      checked.clear();
      for (const it of p?.items ?? []) if (it.checked) checked.add(it.key);
      paintImport();
    },
    showImport,
  };
  if (o.import) showImport();
  else paint();
  dialog.focus();
}

/** A model's name from the catalog, with its variant (`provider/model#variant`), for an agent's row. */
function agentModelName(key: string): string {
  const [base, variant] = key.split("#");
  const m = state?.models?.find((x) => x.key === base);
  return `${m?.name ?? base}${variant ? ` (${variant})` : ""}`;
}

function modelMenuOptions(): MenuOptions {
  return {
    width: "box",
    title: "Select a model",
    maxHeight: 320,
    footer: [
      ...modelSliders(),
      item("Manage providers…", () => openProviders(), {
        icon: "plug",
        testid: "manage-providers",
        disabled: state?.connection.kind !== "connected",
      }),
    ],
  };
}

/**
 * The clock shows once a step has finished with prompt-cache tokens reported (the model
 * caches), unless `cacheWarmMinutes` is 0. A model without a prompt cache, such as most
 * local ones, never shows it.
 */
function clockShown(s: ViewState): boolean {
  return s.prefs.cacheWarmMinutes > 0 && !!s.usage?.lastStepAt && s.usage.cached === true;
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

/** The share of the context window in use (0–1), when OpenCode reported it and the model's limit is known. */
function contextShare(s: ViewState): number | null {
  const u = s.usage;
  if (u?.contextTokens == null || !u.contextLimit) return null;
  return Math.min(1, Math.max(0, u.contextTokens / u.contextLimit));
}

/** The context ring shows once OpenCode has reported how full the context window is. */
function ringShown(s: ViewState): boolean {
  return contextShare(s) !== null;
}

/** A ring that fills with the context in use: a faint track and an arc from the top. */
function contextRing(share: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "i i-ring");
  const circle = (cls: string) => {
    const c = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries({ class: cls, cx: "8", cy: "8", r: "5.6", pathLength: "100" }))
      c.setAttribute(k, v);
    return c;
  };
  const arc = circle("arc");
  // At least a sliver, so a fresh session still shows where the ring starts.
  arc.setAttribute("stroke-dasharray", `${Math.max(2, share * 100)} 100`);
  svg.append(circle("track"), arc);
  return svg;
}

/** Opens the usage menu and asks the host for what fills the context and today's usage. */
function openUsageMenu(anchor: HTMLElement): void {
  const wasOpen = openMenuState?.anchor === anchor;
  openMenu(anchor, usageMenu(), { width: "box", title: "Context and usage" });
  if (wasOpen || !openMenuState) return;
  openMenuState.el.dataset.view = "usage";
  usageDetails = undefined;
  send({ type: "loadUsageDetails" });
}

/** Repaints the open usage menu (new figures arrived) without moving focus to another button. */
function refreshUsageMenu(): void {
  const m = openMenuState;
  if (m?.el.dataset.view !== "usage") return;
  const anchor = m.anchor;
  const list = m.el.querySelector(".menu-list");
  const top = list?.scrollTop ?? 0;
  closeMenu();
  openMenu(anchor, usageMenu(), { width: "box", title: "Context and usage" });
  if (!openMenuState) return;
  openMenuState.el.dataset.view = "usage";
  const next = openMenuState.el.querySelector(".menu-list");
  if (next) next.scrollTop = top;
}

/** What the host sent for the open usage menu; undefined while it loads. */
let usageDetails: { context: ContextBreakdown | null; today: UsageStats | null } | undefined;

/**
 * The session's usage (context first, then what fills it), its costs by model and agent,
 * the provider's limits when OpenCode reports them, the prompt-cache estimate for models
 * that cache, and Compact.
 */
function usageMenu(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const out: MenuEntry[] = [];
  const stats = usageStats(s);
  if (stats.length) out.push(heading("Session"), ...stats);
  const ctx = contextEntries();
  if (ctx.length) out.push(sep(), heading("What fills the context"), ...ctx);
  const costs = costEntries(s);
  if (costs.length) out.push(sep(), ...costs);
  const quota = quotaEntries(s);
  if (quota.length) out.push(sep(), ...quota);
  if (clockShown(s)) {
    const left = cacheUntil(s) - Date.now();
    if (out.length) out.push(sep());
    out.push(
      heading("Prompt cache"),
      stat("Warm for", left > 0 ? `~${Math.ceil(left / 60_000)} min` : "cold (estimate)"),
    );
    if (s.usage?.cacheHit != null)
      out.push(stat("Cache hit", `${Math.round(s.usage.cacheHit * 100)}% of input`));
    out.push(
      note(
        `Estimated from the last step and your ${s.prefs.cacheWarmMinutes}-minute cache setting. OpenCode reports cache tokens, not the timer.`,
      ),
    );
  }
  out.push(
    sep(),
    item("Compact conversation", () => send({ type: "compact" }), {
      icon: "compact",
      sub: "Summarize the conversation to free context",
      disabled: !s.currentSession,
      testid: "compact",
    }),
  );
  return out;
}

const CONTEXT_PARTS: Record<ContextBreakdown["parts"][number]["key"], string> = {
  prompts: "Your messages",
  instructions: "Instructions in the conversation",
  replies: "Replies and thinking",
  tools: "Tool calls and results",
  files: "Attached files",
  summary: "Summary of earlier messages",
  rest: "System prompt, tools and instructions",
};

/** What fills the context: the parts OpenCode's context messages show, and the rest as one figure. */
function contextEntries(): MenuEntry[] {
  if (!state?.currentSession) return [];
  if (usageDetails === undefined) return [note("Loading…")];
  const c = usageDetails.context;
  if (!c || !c.parts.length) return [];
  const sum = c.total ?? c.parts.reduce((n, p) => n + p.tokens, 0);
  const out: MenuEntry[] = c.parts.map((p) => ({
    kind: "meter",
    label: CONTEXT_PARTS[p.key],
    value: `${p.key === "rest" ? "" : "~"}${formatTokens(p.tokens)}`,
    share: sum ? p.tokens / sum : 0,
    testid: `context-part-${p.key}`,
  }));
  const notes = [
    "Estimated from the text, about 4 characters a token.",
    c.total !== null
      ? "The system prompt, tool definitions (MCP included) and instructions are what is left of OpenCode's total: it does not list them."
      : "OpenCode has not reported the total yet, so what it adds (system prompt, tools, instructions) is not shown.",
  ];
  if (c.images) notes.push(`${c.images} image${c.images === 1 ? "" : "s"} not counted.`);
  out.push(note(notes.join(" ")));
  return out;
}

/** "$0.12", "$0.00", or "—" when OpenCode reported no cost. */
function costCell(c: number | null | undefined): string {
  return c === null || c === undefined ? "—" : formatCost(c);
}

function modelName(key: string): string {
  if (!key) return "Unknown model";
  return state?.models?.find((m) => m.key === key)?.name ?? key.slice(key.indexOf("/") + 1);
}

/** Cost by model and by agent (subagents nested under the session, with their own subagents' costs). */
function costEntries(s: ViewState): MenuEntry[] {
  const c = s.costs;
  if (!c || (!c.byModel.length && !c.byAgent.length)) return [];
  const out: MenuEntry[] = [];
  const row = (r: CostRow, label: string) => ({
    cells: [label, r.steps === null ? "—" : String(r.steps), formatTokens(r.tokens), costCell(r.cost)],
  });
  if (c.byModel.length) {
    out.push(heading("Cost by model"), {
      kind: "table",
      testid: "cost-by-model",
      columns: ["Model", "Steps", "Out", "Cost"],
      rows: c.byModel.map((r) => row(r, modelName(r.key))),
    });
  }
  if (c.byAgent.length) {
    out.push(heading("Cost by agent"), {
      kind: "table",
      testid: "cost-by-agent",
      // No token column here: the names need the room, nested subagents most.
      columns: ["Agent", "Steps", "Cost"],
      rows: c.byAgent.map((r) => {
        const sub = r.depth !== undefined;
        const r2 = row(r, sub ? r.label : agentName(r.key));
        r2.cells.splice(2, 1);
        // A subagent with subagents of its own shows its cost, then the total with theirs.
        if (r.total !== undefined && r.total !== r.cost)
          r2.cells[2] = `${costCell(r.cost)} (${costCell(r.total)})`;
        return {
          ...r2,
          indent: r.depth,
          title: sub
            ? `Subagent${r.total !== undefined ? `; with its subagents ${costCell(r.total)}` : ""}`
            : undefined,
        };
      }),
    });
  }
  const totals: string[] = [];
  if (c.other !== null) totals.push(`${formatCost(c.other)} for titles and compaction`);
  if (c.total !== null && c.session !== null && c.total !== c.session)
    totals.push(`with subagents ${formatCost(c.total)}`);
  if (totals.length) out.push(note(`Session ${costCell(c.session)}: ${totals.join(", ")}.`));
  if (c.byAgent.some((r) => r.total !== undefined && r.total !== r.cost))
    out.push(note("(…): with the subagents it started."));
  if ([...c.byModel, ...c.byAgent].some((r) => r.cost === null))
    out.push(note("— : OpenCode reported no cost for these steps."));
  const today = usageDetails?.today;
  if (today && today.steps > 0)
    out.push(
      stat(
        "Today in this project",
        `${formatCost(today.cost)} · ${today.sessions} session${today.sessions === 1 ? "" : "s"}`,
      ),
    );
  return out;
}

function agentName(id: string): string {
  if (!id) return "Unknown agent";
  return state?.agents?.find((a) => a.id === id)?.name ?? id;
}

/** "resets in 3 h", "resets in 12 min", "resets on 4 Dec". */
function resetsIn(at: number | null): string {
  if (at === null) return "";
  const left = at - Date.now();
  if (left <= 0) return "resets now";
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `resets in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `resets in ${hr} h`;
  return `resets on ${new Date(at).toLocaleDateString(state?.locale ?? "en", { day: "numeric", month: "short" })}`;
}

/** A limit counts as nearly used up from 80%. */
const QUOTA_WARN = 80;

function quotaHigh(m: QuotaMeter): boolean {
  return m.limited || m.percent >= QUOTA_WARN;
}

/** OpenCode Go windows and Console budgets, as OpenCode reports them; nothing when it reports none. */
function quotaEntries(s: ViewState): MenuEntry[] {
  const q = s.quota;
  if (!q || !q.meters.length) return [];
  const out: MenuEntry[] = [heading(q.workspace ? `Limits · ${q.workspace}` : "Limits")];
  for (const m of q.meters)
    out.push({
      kind: "meter",
      label: m.label,
      value: `${m.used ? `${m.used} · ` : ""}${Math.round(m.percent)}%`,
      share: m.percent / 100,
      warn: quotaHigh(m),
      sub: [m.limited ? "Limit reached" : "", resetsIn(m.resetsAt)].filter(Boolean).join(" · ") || undefined,
      testid: "quota-meter",
    });
  return out;
}

/** A meter bar's fill, sized through the DOM (the page's CSP allows no inline style attributes). */
function meterFill(share: number): HTMLElement {
  const fill = h("span");
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
  return fill;
}

/** Rows of cells; the first column takes the room left, figures line up on the right. */
function menuTable(e: MenuEntry): HTMLElement {
  const cols = e.columns ?? [];
  return h(
    "table",
    { className: "menu-table", "data-testid": e.testid },
    h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", { scope: "col" }, c)))),
    h(
      "tbody",
      {},
      ...(e.rows ?? []).map((r) =>
        h(
          "tr",
          { title: r.title },
          ...r.cells.map((c, i) =>
            h(
              "td",
              i === 0 ? { className: r.indent ? `ind${Math.min(3, r.indent)}` : undefined, dir: "auto" } : {},
              i === 0 && r.indent ? `↳ ${c}` : c,
            ),
          ),
        ),
      ),
    ),
  );
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

/** A hammer for Build, a clipboard for Plan, a person for any other agent. */
function agentIcon(id: string | undefined): keyof typeof ICON_PATHS {
  return id === "plan" ? "plan" : id === "build" || id === undefined ? "build" : "agent";
}

/** The agent (Build, Plan, …) with OpenCode's descriptions. */
function modeMenu(): MenuEntry[] {
  const s = state;
  if (!s) return [];
  const out: MenuEntry[] = [];
  for (const a of s.agents ?? [])
    out.push(
      item(a.name, () => send({ type: "selectAgent", id: a.id }), {
        checked: a.id === s.selectedAgent,
        icon: agentIcon(a.id),
        sub: a.description || "Defined in your OpenCode config",
        testid: "agent-option",
      }),
    );
  if (!(s.agents ?? []).length) out.push(note("No agents available."));
  return out;
}

// --------------------------------------------------------------- scrolling

let stickToBottom = true;
/** How many steps the chat had when the reader scrolled away from its end. */
let itemsWhenLeft = 0;
scroller.addEventListener("scroll", () => {
  const was = stickToBottom;
  stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  if (was && !stickToBottom) itemsWhenLeft = shown().items.length;
  renderJump();
});
function maybeScroll() {
  if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
  renderJump();
}
function renderJump(): void {
  const away = !stickToBottom && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 48;
  jumpEl.hidden = !away;
  if (!away) return;
  const fresh = Math.max(0, shown().items.length - itemsWhenLeft);
  const label = fresh ? `${fresh} new` : "Jump to latest";
  if (jumpEl.dataset.label === label) return;
  jumpEl.dataset.label = label;
  jumpEl.setAttribute("aria-label", fresh ? `Jump to latest, ${fresh} new` : "Jump to latest");
  jumpEl.replaceChildren(icon("down"), label);
}
function jumpToLatest(): void {
  stickToBottom = true;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  jumpEl.hidden = true;
  input.focus();
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
  // The Git branch (or detached commit) the agent works on, from VS Code's Git.
  const ws = s.workspace;
  const branch = ws.branch ?? (ws.detachedAt ? `detached at ${ws.detachedAt}` : null);
  const branchEl = branch
    ? h(
        "span",
        {
          className: "p-branch",
          "data-tip": ws.branch ? `Git branch: ${ws.branch}` : `Detached HEAD at ${ws.detachedAt}`,
          "data-testid": "branch",
        },
        icon("branch"),
        h("span", {}, branch),
      )
    : null;
  paintApproval(s);
  headerEl.replaceChildren(
    titleEl,
    branchEl ?? "",
    h("span", { className: "grow" }),
    approvalBtn,
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

// ---------------------------------------------------------- session strip
//
// The sessions opened lately in this folder, and any that work or wait, as small tabs
// under the header, each with its status. Click one to switch; × only takes it off the
// strip. It shows once two or more sessions are on it.

const STRIP_STATUS: Record<StripStatus, { label: string; tip: string } | null> = {
  waiting: { label: "waiting for you", tip: "Waiting for your answer" },
  running: { label: "working", tip: "OpenCode is working" },
  done: { label: "finished", tip: "Finished since you last looked" },
  failed: { label: "failed", tip: "Failed since you last looked" },
  idle: null,
};
let stripSignature = "";
let stripCurrent: string | null = null;

/** Moves the focus between the strip's tabs (←/→, Home, End); Delete takes one off. */
stripEl.addEventListener("keydown", (e) => {
  const tabs = Array.from(stripEl.querySelectorAll<HTMLButtonElement>(".strip-open"));
  const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const rtl = getComputedStyle(stripEl).direction === "rtl";
  let next: number;
  if (e.key === "ArrowRight") next = rtl ? at - 1 : at + 1;
  else if (e.key === "ArrowLeft") next = rtl ? at + 1 : at - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabs.length - 1;
  else if (e.key === "Delete") {
    const close = tabs[at].parentElement?.querySelector<HTMLButtonElement>(".strip-close");
    if (close) {
      e.preventDefault();
      close.click();
    }
    return;
  } else return;
  e.preventDefault();
  tabs[Math.max(0, Math.min(tabs.length - 1, next))]?.focus();
});

function renderStrip(s: ViewState): void {
  const tabs = s.strip ?? [];
  const show = s.prefs.sessionStrip !== false && tabs.length > 1 && s.connection.kind === "connected";
  stripEl.hidden = !show;
  if (!show) {
    stripSignature = "";
    return;
  }
  const sig = JSON.stringify(tabs);
  if (sig === stripSignature) return;
  stripSignature = sig;
  // A rebuild keeps the focus on the same tab (or the one after a tab taken off).
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".strip-tab");
  const focusId = focused && stripEl.contains(focused) ? focused.dataset.id : undefined;
  const focusAt = focused ? Array.from(stripEl.children).indexOf(focused) : -1;
  stripEl.replaceChildren(
    ...tabs.map((t) => {
      const status = STRIP_STATUS[t.status];
      const label = `${t.title}${status ? `, ${status.label}` : ""}${t.current ? " (open)" : ""}`;
      return h(
        "div",
        {
          className: `strip-tab st-${t.status}${t.current ? " current" : ""}`,
          role: "listitem",
          "data-id": t.id,
        },
        h(
          "button",
          {
            className: "strip-open",
            "aria-label": label,
            "aria-current": t.current ? "page" : undefined,
            "data-tip": status ? `${t.title} — ${status.tip}` : t.title,
            "data-testid": "strip-tab",
            "data-status": t.status,
            onclick: () => {
              if (t.current) return;
              sessionsOpen = false;
              bookmarksOpen = false;
              send({ type: "selectSession", id: t.id });
              render();
            },
          },
          h("span", { className: "strip-dot", "aria-hidden": "true" }),
          h("span", { className: "strip-title", dir: "auto" }, t.title),
        ),
        t.current
          ? null
          : h(
              "button",
              {
                className: "strip-close",
                tabindex: "-1",
                "aria-label": `Remove ${t.title} from the strip`,
                "data-tip": "Remove from the strip (it stays in History)",
                "data-testid": "strip-close",
                onclick: () => {
                  const row = stripEl.querySelector<HTMLElement>(`.strip-tab[data-id="${CSS.escape(t.id)}"]`);
                  const rows = Array.from(stripEl.children);
                  const after = row ? (rows[rows.indexOf(row) + 1] ?? rows[rows.indexOf(row) - 1]) : null;
                  after?.querySelector<HTMLElement>(".strip-open")?.focus();
                  send({ type: "closeStripTab", id: t.id });
                },
              },
              icon("close"),
            ),
      );
    }),
  );
  if (focusId !== undefined) {
    const rows = Array.from(stripEl.querySelectorAll<HTMLElement>(".strip-tab"));
    const again = rows.find((r) => r.dataset.id === focusId) ?? rows[Math.min(focusAt, rows.length - 1)];
    again?.querySelector<HTMLElement>(".strip-open")?.focus();
  }
  // The open session's tab is scrolled into view when it changes.
  const current = tabs.find((t) => t.current)?.id ?? null;
  if (current !== stripCurrent) {
    stripCurrent = current;
    stripEl.querySelector(".strip-tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
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
          sess.running
            ? h("span", {
                className: "session-run",
                role: "img",
                "aria-label": "Working",
                "data-tip": "OpenCode is working in this session",
                "data-testid": "session-running",
              })
            : null,
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
      // Archived sessions can also be deleted for good (after a confirmation).
      historyArchived
        ? h(
            "button",
            {
              className: "session-act",
              "data-tip": "Delete permanently",
              "aria-label": `Delete ${sess.title} permanently`,
              "data-testid": "session-delete",
              onclick: () => void confirmDelete(sess.id, sess.title),
            },
            icon("trash"),
          )
        : null,
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
 * Words for the Working line: Sidecar riding along while the agent drives. A run starts
 * on one and moves to another every WORD_EVERY ms. Sidecar's own list, on its own theme.
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
/** When the current word was picked. */
let wordSince = 0;
const WORD_EVERY = 8000;

/** Any word but the current one. */
function nextStatusWord(): string {
  const others = STATUS_WORDS.filter((w) => w !== statusWord);
  return others[Math.floor(Math.random() * others.length)];
}

/** Moves the Working line to a new word once the current one has had its turn. */
function rotateStatusWord(): void {
  if (workingEl.hidden || state?.stopping || state?.prefs.statusWords === false) return;
  if (Date.now() - wordSince < WORD_EVERY) return;
  const from = statusWord;
  statusWord = nextStatusWord();
  wordSince = Date.now();
  stopSweep();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    sweep = { from, to: statusWord, at: 0 };
    const steps = Math.max(from.length, statusWord.length);
    sweepTimer = window.setInterval(
      () => {
        if (sweep && ++sweep.at >= steps) stopSweep();
        paintWord();
      },
      Math.round(SWEEP_MS / steps),
    );
  }
  paintWord();
}

// When the word changes, a block cursor sweeps across it: letters behind it are already the
// new word's, letters ahead still the old one's. Between changes the word is plain text.
/** The whole sweep, whatever the length of the words. */
const SWEEP_MS = 1300;
let sweep: { from: string; to: string; at: number } | null = null;
let sweepTimer: number | undefined;

function stopSweep(): void {
  if (sweepTimer !== undefined) window.clearInterval(sweepTimer);
  sweepTimer = undefined;
  sweep = null;
}

/** The word, then "…": mid-sweep, one span per letter with the cursor on one of them. */
function wordNodes(word: string): Node[] {
  if (!sweep) return [document.createTextNode(`${word}…`)];
  const { from, to, at } = sweep;
  const out: Node[] = [];
  for (let k = 0; k < Math.max(from.length, to.length); k++) {
    const ch = k < at ? to[k] : k === at ? (to[k] ?? from[k]) : from[k];
    if (ch === undefined) continue;
    out.push(h("span", k === at ? { className: "cur" } : {}, ch));
  }
  out.push(document.createTextNode("…"));
  return out;
}

function paintWord(): void {
  if (state?.stopping || state?.prefs.statusWords === false) return stopSweep();
  const b = workingEl.querySelector<HTMLElement>('[data-testid="status-word"].typing');
  if (b) b.replaceChildren(...wordNodes(statusWord));
}

/** Live generation speed of the open session's streaming reply (an estimate from its text). */
const meter = new ThroughputMeter();
const rateEl = h("span", { "data-testid": "tok-rate" });

/** " · ~38 tok/s" while a reply streams; nothing between replies, while tools run. */
function paintRate(): void {
  const rate = meter.rate(Date.now());
  const text = rate === null ? "" : ` · ~${formatRate(rate)}`;
  if (rateEl.textContent !== text) rateEl.textContent = text;
  rateEl.title = rate === null ? "" : "Estimated from the streamed text (about 4 characters a token)";
}

/** "Riding along… 2:14 · Esc to stop" under the timeline while the agent runs. */
function renderWorking(s: ViewState) {
  const show = s.busy && !subView;
  workingEl.hidden = !show;
  if (!show) {
    busySince = null;
    stopSweep();
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
    wordSince = Date.now();
    // Time the run from its prompt when that is recent; a resumed session starts now.
    const last = [...transcript.items].reverse().find((i) => i.kind === "user");
    const at = last?.kind === "user" ? last.time : undefined;
    busySince = at !== undefined && Date.now() - at < 6 * 3600_000 ? at : Date.now();
  }
  const word = s.stopping ? "Stopping" : s.prefs.statusWords === false ? "Working" : statusWord;
  label.replaceChildren(
    h(
      "b",
      {
        className: s.stopping ? undefined : "typing",
        "data-testid": "status-word",
        title: "OpenCode is working",
      },
      ...(s.stopping ? [`${word}…`] : wordNodes(word)),
    ),
    h(
      "span",
      { className: "muted" },
      h("span", { "data-elapsed-from": String(busySince) }, formatDuration(Date.now() - busySince)),
      rateEl,
      s.stopping ? "" : " · Esc to stop",
    ),
  );
  paintRate();
  if (word !== statusWord) stopSweep();
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

/** An onboarding button that opens the Providers panel. */
function panelBtn(label: string, primary: boolean, testid: string): HTMLElement {
  return h(
    "button",
    { className: primary ? "btn primary" : "btn", "data-testid": testid, onclick: () => openProviders() },
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
        actionBtn("Check setup", { type: "checkSetup" }, false, "onb-check-setup"),
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
      actions = [...signInButtons(true), panelBtn("Connect another provider", false, "onb-provider")];
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
        panelBtn("Connect a provider", true, "onb-provider"),
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
        actionBtn("Check setup", { type: "checkSetup" }, false, "onb-check-setup"),
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
            // Finished blocks can also go into the editor: at the cursor, or as a new file.
            b.closed
              ? h(
                  "span",
                  { className: "code-acts" },
                  h(
                    "button",
                    {
                      className: "ico code-act",
                      "data-tip": "Insert at cursor",
                      "aria-label": "Insert at the cursor in the editor",
                      "data-testid": "insert-code",
                      onclick: () => send({ type: "insertCode", text }),
                    },
                    icon("insert"),
                  ),
                  h(
                    "button",
                    {
                      className: "ico code-act",
                      "data-tip": "Open in editor",
                      "aria-label": "Open in a new editor",
                      "data-testid": "open-code",
                      onclick: () => send({ type: "openCode", text, lang: b.lang.slice(0, 40) }),
                    },
                    icon("openfile"),
                  ),
                )
              : null,
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

const FILE_TAG: Record<string, string> = { added: "new", deleted: "deleted" };

/**
 * Changed files, one row each: the name, its folder muted, the counts that aren't zero
 * and a "new"/"deleted" tag. The row opens the file's diff; the icon at the end opens
 * the file itself.
 */
function fileList(
  files: FileChange[],
  diffAction: "openAgentDiff" | null,
  review?: Record<string, ReviewCounts>,
): HTMLElement {
  return h(
    "ul",
    { className: "file-list" },
    ...files.map((f) => {
      const slash = Math.max(f.path.lastIndexOf("/"), f.path.lastIndexOf("\\"));
      const name = f.path.slice(slash + 1);
      const dir = slash > 0 ? f.path.slice(0, slash) : null;
      const tag = FILE_TAG[f.status];
      const r = review?.[f.path];
      const body = [
        h("span", { className: "fname" }, name),
        dir ? h("span", { className: "fdir" }, dir) : null,
        h(
          "span",
          { className: "fcounts" },
          f.additions ? h("span", { className: "adds" }, `+${f.additions}`) : null,
          f.deletions ? h("span", { className: "dels" }, `−${f.deletions}`) : null,
        ),
        tag ? h("span", { className: `ftag ftag-${f.status}` }, tag) : null,
        r ? reviewTag(r) : null,
      ];
      const open = () => send({ type: "openFile", path: f.path });
      return h(
        "li",
        {},
        h(
          "button",
          {
            className: "file-row",
            "aria-label": diffAction ? `View the diff of ${f.path}` : `Open ${f.path}`,
            "data-tip": diffAction ? "View the diff" : "Open the file",
            "data-testid": diffAction ? "file-diff" : "file-open-row",
            onclick: diffAction ? () => send({ type: diffAction, path: f.path }) : open,
          },
          ...body,
        ),
        diffAction
          ? h(
              "button",
              {
                className: "file-open",
                "aria-label": `Open ${f.path}`,
                "data-tip": "Open the file",
                "data-testid": "file-open",
                onclick: open,
              },
              icon("openfile"),
            )
          : null,
      );
    }),
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
  todowrite: "Todos",
  todoread: "Todos",
  generate_image: "Image",
  experimental_image_generate: "Image",
  image_generate: "Image",
  generate_video: "Video",
  experimental_video_generate: "Video",
};

const TODO_MARK: Record<TodoEntry["status"], string> = {
  completed: "✓",
  in_progress: "●",
  pending: "○",
  cancelled: "✕",
};
const TODO_STATUS: Record<TodoEntry["status"], string> = {
  completed: "done",
  in_progress: "in progress",
  pending: "to do",
  cancelled: "cancelled",
};

/** The agent's todo list as it last wrote it, one line per task. */
function todoList(todos: TodoEntry[]): HTMLElement {
  return h(
    "ul",
    { className: "todos", "data-testid": "todo-list" },
    ...todos.map((t) =>
      h(
        "li",
        {
          className: `todo todo-${t.status.replace("_", "-")}`,
          "aria-label": `${t.content}: ${TODO_STATUS[t.status]}`,
        },
        h("span", { className: "todo-mark", "aria-hidden": "true" }, TODO_MARK[t.status]),
        h("span", { className: "todo-text", dir: "auto" }, t.content),
      ),
    ),
  );
}

const MEDIA_STATE: Record<string, string> = {
  started: "Generating in the background",
  completed: "Saved",
  error: "Failed",
  cancelled: "Cancelled",
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
  const { additions: a, deletions: d } = f;
  if (a && d) return a === d ? `Changed ${plural(a, "line")}` : `Added ${a}, removed ${plural(d, "line")}`;
  if (a) return `Added ${plural(a, "line")}`;
  if (d) return `Removed ${plural(d, "line")}`;
  return "Modified";
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

type SplitCell = { t: "ctx" | "del" | "add" | "empty" | "gap"; text: string };

/**
 * Rows for an old | new view: context on both sides, and each run of removed lines
 * beside the added lines that replace it (an empty cell where one side is shorter).
 */
function splitRows(lines: FileDiff["lines"]): Array<[SplitCell, SplitCell]> {
  const rows: Array<[SplitCell, SplitCell]> = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++)
      rows.push([
        i < dels.length ? { t: "del", text: dels[i] } : { t: "empty", text: "" },
        i < adds.length ? { t: "add", text: adds[i] } : { t: "empty", text: "" },
      ]);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.t === "del") dels.push(l.text);
    else if (l.t === "add") adds.push(l.text);
    else {
      flush();
      rows.push(
        l.t === "gap"
          ? [
              { t: "gap", text: "" },
              { t: "gap", text: "" },
            ]
          : ([l, l] as [SplitCell, SplitCell]),
      );
    }
  }
  flush();
  return rows;
}

/** Width of the old column in side-by-side diffs (percent); one value for every diff. */
let splitLeft = 50;

function setSplitLeft(percent: number) {
  splitLeft = Math.round(Math.min(80, Math.max(20, percent)));
  for (const el of document.querySelectorAll<HTMLElement>(".diff-split")) {
    el.style.setProperty("--ds-left", `${splitLeft}%`);
    el.querySelector(".ds-divider")?.setAttribute("aria-valuenow", String(splitLeft));
  }
}

/**
 * The line between old and new: drag it (or use ←/→, Home) to share the width
 * differently. It keeps its pointer and keys to itself, so it never opens the diff.
 */
function splitDivider(): HTMLElement {
  const el = h("div", {
    className: "ds-divider",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Width of the old and new columns",
    "aria-valuemin": "20",
    "aria-valuemax": "80",
    "aria-valuenow": String(splitLeft),
    "data-tip": "Drag to resize",
    "data-testid": "diff-divider",
  });
  el.addEventListener("click", (e) => e.stopPropagation());
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const split = el.parentElement!;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const r = split.getBoundingClientRect();
      setSplitLeft(((ev.clientX - r.left) / r.width) * 100);
    };
    const stop = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
  });
  el.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    if (step !== undefined) setSplitLeft(splitLeft + step);
    else if (e.key === "Home") setSplitLeft(50);
  });
  return el;
}

function diffBox(diff: FileDiff): HTMLElement {
  const long = diff.lines.length > DIFF_VISIBLE || diff.more > 0;
  const grammar = grammarFor(diff.path);
  const cell = (c: SplitCell) =>
    h(
      "div",
      { className: `ds-cell ds-${c.t}` },
      ...(c.t === "gap" ? ["⋯"] : c.t === "empty" ? [] : highlightLine(c.text || " ", grammar)),
    );
  return clickable(
    {
      className: "diff" + (long ? " long" : ""),
      "aria-label": `Open the change to ${diff.path} in the diff editor`,
      "data-testid": "tool-diff",
    },
    () => send({ type: "openAgentDiff", path: diff.path }),
    // Stacked in a narrow panel; old beside new once the panel is wide (CSS container query).
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
    h(
      "div",
      { className: "diff-split", style: `--ds-left: ${splitLeft}%` },
      ...splitRows(diff.lines).map(([a, b]) =>
        h("div", { className: "ds-row", "aria-hidden": "true" }, cell(a), cell(b)),
      ),
      splitDivider(),
    ),
    h("span", { className: "diff-hint", "aria-hidden": "true" }, "Click to open in the diff editor"),
  );
}

function writtenBox(path: string, w: { lines: string[]; total: number }): HTMLElement {
  const grammar = grammarFor(path);
  return clickable(
    {
      className:
        "diff written" + (w.lines.length > WRITTEN_VISIBLE || w.total > w.lines.length ? " long" : ""),
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
    h("span", { className: "diff-hint", "aria-hidden": "true" }, "Click to open the file"),
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
    case "todo":
      head.append(desc(item.title));
      if (d.todos?.length) parts.push(todoList(d.todos));
      break;
    case "media": {
      if (d.description) head.append(desc(d.description));
      const stateText = d.media?.state ? (MEDIA_STATE[d.media.state] ?? capitalize(d.media.state)) : null;
      if (stateText || d.path)
        parts.push(
          h(
            "div",
            { className: "tool-sub", "data-testid": "media-file" },
            stateText ? `${stateText}${d.path ? " · " : ""}` : "",
            d.path ? pathLink(d.path, "media-path") : null,
          ),
        );
      break;
    }
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

/** "Always allow … like this" per request, while open: the patterns as typed and where they apply. */
const dockLike = new Map<string, { patterns: string[]; scope: "session" | "folder" }>();

/**
 * "Always allow commands like this…": a pattern made from the request (`npm test *` for
 * `npm test -- --grep foo`) to edit before saving, for this session or the folder, so
 * near-identical requests stop asking. The request itself is allowed once.
 */
function likeEditor(r: PermItem["request"], sending: boolean): HTMLElement {
  const shell = /(bash|shell|command|exec)/i.test(r.action);
  const open = dockLike.get(r.id);
  const toggle = h(
    "button",
    {
      className: "like-link",
      "data-key": "perm:like",
      "data-testid": "perm-like",
      "aria-expanded": String(!!open),
      disabled: sending,
      onclick: () => {
        if (open) dockLike.delete(r.id);
        else
          dockLike.set(r.id, {
            patterns: [...new Set(r.resources.slice(0, 5).map((x) => generalizePattern(r.action, x)))],
            scope: "session",
          });
        renderDock(true);
        if (!open) dockEl.querySelector<HTMLElement>('[data-testid="perm-like-pattern"]')?.focus();
      },
    },
    shell ? "Always allow commands like this…" : "Always allow requests like this…",
  );
  if (!open) return h("div", { className: "like" }, toggle);
  const save = () => {
    const patterns = open.patterns.map((p) => p.trim()).filter(Boolean);
    if (!patterns.length || sending) return;
    dockLike.delete(r.id);
    send({ type: "allowLike", requestId: r.id, patterns, scope: open.scope });
  };
  const match = h("div", { className: "like-match", "data-testid": "perm-like-match" });
  const paintMatch = () => {
    const covers = r.resources.every((x) => open.patterns.some((p) => p.trim() && globMatch(x, p.trim())));
    match.textContent = covers
      ? "Covers this request and others like it."
      : "Doesn't cover this request; it is still allowed once.";
    match.classList.toggle("warn", !covers);
  };
  const inputs = open.patterns.map((p, i) => {
    const field = h("input", {
      className: "tell like-in",
      type: "text",
      dir: "ltr",
      "aria-label": "Pattern to always allow (* matches anything)",
      "data-key": `perm:like:${i}`,
      "data-testid": "perm-like-pattern",
      disabled: sending,
    }) as HTMLInputElement;
    field.value = p;
    field.addEventListener("input", () => {
      open.patterns[i] = field.value;
      paintMatch();
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    return field;
  });
  paintMatch();
  const scopeBtn = (scope: "session" | "folder", label: string, tip: string, disabled = false) =>
    h(
      "button",
      {
        className: "seg-btn" + (open.scope === scope ? " on" : ""),
        "aria-pressed": String(open.scope === scope),
        "data-key": `perm:like:${scope}`,
        "data-testid": `perm-like-${scope}`,
        "data-tip": tip,
        disabled: disabled || sending,
        onclick: () => {
          open.scope = scope;
          renderDock(true);
        },
      },
      label,
    );
  return h(
    "div",
    { className: "like open", "data-testid": "perm-like-editor" },
    toggle,
    ...inputs,
    match,
    h(
      "div",
      { className: "like-row" },
      h(
        "span",
        { className: "seg-group", role: "group", "aria-label": "Allow it for" },
        scopeBtn("session", "This session", "Until this session ends; its new subagents too"),
        scopeBtn(
          "folder",
          "This folder",
          r.canAlways
            ? "Saved by OpenCode for the folder, like Yes, always allow"
            : "OpenCode offers no folder rule for this request",
          !r.canAlways,
        ),
      ),
      h("span", { className: "grow" }),
      h(
        "button",
        { className: "btn subtle small", "data-testid": "perm-like-cancel", onclick: () => toggle.click() },
        "Cancel",
      ),
      h(
        "button",
        {
          className: "btn small",
          "data-key": "perm:like:save",
          "data-testid": "perm-like-save",
          onclick: save,
        },
        "Allow",
      ),
    ),
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
    parts.push(likeEditor(r, sending));
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
      // The pattern editor's own buttons: Escape closes it, digits are not answers there.
      if (e.target instanceof HTMLElement && e.target.closest(".like.open")) {
        if (e.key === "Escape") {
          e.preventDefault();
          dockLike.delete(r.id);
          renderDock(true);
          dockEl.querySelector<HTMLElement>('[data-testid="perm-like"]')?.focus();
        }
        return;
      }
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
/**
 * A new permission request or question needs the user first: menus, the @ list,
 * Bookmarks, History and tooltips close so nothing covers it. A confirm dialog the
 * user opened stays, on top, and is answered first.
 */
function closePopovers(): void {
  closeMenu();
  closeMention();
  hideTip();
  if (bookmarksOpen) {
    bookmarksOpen = false;
    bookmarksEl.hidden = true;
  }
  if (sessionsOpen) {
    sessionsOpen = false;
    sessionsEl.hidden = true;
  }
}

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
      : [!!dockLike.get(req?.id ?? ""), dockLike.get(req?.id ?? "")?.scope],
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
  if (fresh) {
    dockCollapsed = false;
    closePopovers();
  }
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
    case "background":
      return renderBackground(item);
    case "turn-meta":
      return renderTurnMeta(item);
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
                a === "reauth"
                  ? item.provider
                    ? h(
                        "button",
                        {
                          className: "btn",
                          "data-testid": "error-reauth",
                          onclick: () => send({ type: "providerReauth", id: item.provider!.id }),
                        },
                        `${t("reauth")} ${item.provider.name}`,
                      )
                    : null
                  : a === "changeModel"
                    ? h(
                        "button",
                        {
                          className: "btn",
                          "data-testid": "error-change-model",
                          onclick: () => send({ type: "focusModelPicker" }),
                        },
                        // Beside a sign-in, the other way out: a model from another provider.
                        t(item.actions.includes("reauth") ? "chooseModel" : "changeModel"),
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
    h("div", { className: "btxt", dir: "auto" }, ...promptText(item)),
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

/**
 * A prompt's text, with the large pastes it was sent with (as far as this view remembers
 * them) folded into chips that open in place.
 */
function promptText(item: Extract<TranscriptItem, { kind: "user" }>): Array<Node | string> {
  const found: Array<{ start: number; end: number; text: string }> = [];
  for (const mem of byLength()) {
    const f = findPaste(item.text, mem);
    if (!f || found.some((x) => f.at < x.end && f.at + f.len > x.start)) continue;
    found.push({ start: f.at, end: f.at + f.len, text: item.text.slice(f.at, f.at + f.len) });
  }
  if (!found.length) return [item.text];
  found.sort((a, b) => a.start - b.start);
  const out: Array<Node | string> = [];
  let last = 0;
  found.forEach((f, k) => {
    const key = `${item.id}:paste:${k}`;
    const open = openDetails.has(key);
    if (f.start > last) out.push(item.text.slice(last, f.start));
    out.push(
      h(
        "button",
        {
          className: "chip paste-ref" + (open ? " open" : ""),
          "aria-expanded": String(open),
          "aria-label": `${open ? "Hide" : "Show"} the pasted text, ${pasteSummary(f.text)}`,
          "data-testid": "prompt-paste",
          onclick: () => {
            if (open) openDetails.delete(key);
            else {
              openDetails.add(key);
              // The bubble opens with it, so the text is not cut to two lines.
              openDetails.add(`${item.id}:open`);
            }
            renderItemById(item.id);
          },
        },
        icon("paste"),
        h("span", { className: "chip-label" }, "Pasted text"),
        h("span", { className: "chip-detail" }, pasteSummary(f.text)),
      ),
    );
    if (open) out.push(h("pre", { className: "paste-text", tabindex: "0" }, f.text));
    last = f.end;
  });
  if (last < item.text.length) out.push(item.text.slice(last));
  return out;
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

/** "Big Pickle · 3 steps · 1.2k tokens · 42 tok/s · $0.01" under a turn; costs of 0 are left out. */
function renderTurnMeta(item: Extract<TranscriptItem, { kind: "turn-meta" }>): HTMLElement {
  const parts = [
    item.models.map(modelName).join(", ") || "Unknown model",
    `${item.steps} step${item.steps === 1 ? "" : "s"}`,
    `${formatTokens(item.tokens)} tokens`,
  ];
  if (item.rate !== null) parts.push(formatRate(item.rate));
  if (item.cost) parts.push(formatCost(item.cost));
  return h(
    "div",
    {
      className: "turn-meta muted small",
      "data-testid": "turn-meta",
      title:
        "Tokens generated (output and thinking) and the speed while the model streamed, as OpenCode reported them",
    },
    parts.join(" · "),
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
    case "turn-meta":
    case "handback":
      return "none";
    case "background":
      return item.state === "error" || item.state === "failed"
        ? "err"
        : item.state === "completed"
          ? "ok"
          : "idle";
  }
}

/** Assistant text shows its time when it starts a block of text (after a prompt, tool or thought). */
function showsTime(
  item: TranscriptItem,
  tr: Transcript,
): item is Extract<TranscriptItem, { kind: "assistant" }> {
  if (item.kind !== "assistant" || item.time === undefined) return false;
  const prev = tr.items[tr.indexOf(item.id) - 1];
  return prev?.kind !== "assistant" || !prev.text.trim();
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
  // Some models send a reply part with only whitespace before a tool call: no dot for it.
  // It stays in the list (hidden) so text streamed into it later still shows.
  if (item.kind === "assistant" && !item.text.trim())
    return h("div", { className: "tl-item", "data-id": item.id, hidden: true });
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
    // Redrawn items drop their old highlights; an open find bar searches again.
    if (ids.length && findOpen()) scheduleFind();
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
  const cost = subagentCost(v);
  if (cost) add(h("span", { title: cost.title, "data-testid": "subagent-cost" }, cost.text));
  return h("div", { className: "subagent-meta muted small", "data-testid": "subagent-meta" }, ...parts);
}

/**
 * "$0.02", or "$0.02 · $0.05 with subagents" for one that started its own: each row shows
 * its own cost, and a parent the total with its subagents rolled in. Free (0) or
 * unreported costs show nothing.
 */
function subagentCost(v: SubagentView): { text: string; title: string } | null {
  const total = v.totalCost ?? null;
  if (total !== null && total !== v.cost && total > 0)
    return {
      text: `${v.cost ? formatCost(v.cost) : "$0.00"} · ${formatCost(total)} with subagents`,
      title: `Its own cost ${costCell(v.cost)}; with its subagents ${formatCost(total)}`,
    };
  return v.cost ? { text: formatCost(v.cost), title: `Cost ${formatCost(v.cost)}` } : null;
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
  // The row keeps its cost in the tooltip; one with subagents adds theirs there too.
  const cost = v ? subagentCost(v) : null;
  const metaEl =
    v && (meta.length || v.started !== null)
      ? h(
          "span",
          { "data-testid": "subagent-meta", title: cost?.title },
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

const BACKGROUND_LABEL: Record<string, string> = {
  goal: "Goal",
  shell: "Background command",
  generate_image: "Image",
  generate_video: "Video",
  codemode: "Code mode",
};

/**
 * Something OpenCode posted on its own: a goal's progress, a background shell's
 * result, a finished image or video. One line, with the full text folded under it.
 */
function renderBackground(item: Extract<TranscriptItem, { kind: "background" }>): HTMLElement {
  const label = BACKGROUND_LABEL[item.source] ?? capitalize(item.source.replace(/[_-]+/g, " "));
  const first = (item.text.split("\n").find((l) => l.trim()) ?? "").trim();
  const line = [label, item.command, item.state].filter(Boolean).join(" · ") + (first ? `: ${first}` : "");
  const path = item.path;
  const body: Node[] = [];
  if (item.text.trim()) body.push(h("div", { className: "bg-text", dir: "auto" }, item.text.trim()));
  if (path) body.push(h("div", { className: "tool-sub" }, pathLink(path, "background-path")));
  const summary = [h("span", { className: "hb-line", dir: "auto", "data-testid": "background" }, line)];
  return item.text.trim()
    ? details(item.id, summary, body, "handback")
    : h("div", { className: "handback-plain" }, ...summary, ...body);
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

/** A file's review state on its row: what is left to review, or that it is reviewed. */
function reviewTag(r: ReviewCounts): HTMLElement {
  const done = r.undecided === 0;
  const tip = [
    r.undecided ? `${r.undecided} to review` : "Reviewed",
    r.kept ? `${r.kept} kept` : "",
    r.undone ? `${r.undone} undone` : "",
    r.changed ? `${r.changed} edited since` : "",
    r.fileOnly ? "reviewed as a whole file" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return h(
    "span",
    {
      className: "freview" + (done ? " done" : ""),
      "data-testid": "file-review",
      "data-tip": tip,
      "aria-label": tip,
    },
    done ? "✓" : String(r.undecided),
  );
}

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
        c.add ? h("span", { className: "adds" }, `+${c.add}`) : null,
        c.del ? h("span", { className: "dels" }, `−${c.del}`) : null,
        h(
          "button",
          {
            className: "link-btn changes-action",
            "data-testid": "view-agent-changes",
            onclick: () => send({ type: "reviewChanges" }),
            "data-tip":
              "Keep or undo each change the agent made, in the editor, file by file (from OpenCode's snapshots)",
          },
          !s.review
            ? t("reviewAll")
            : s.review.undecided
              ? `${t("reviewAll")} · ${s.review.undecided}`
              : "Reviewed",
        ),
        s.workspace.repoRoot
          ? h(
              "button",
              {
                className: "link-btn changes-action",
                "data-testid": "write-commit-message",
                onclick: () => send({ type: "writeCommitMessage" }),
                "data-tip":
                  "Write a commit message with OpenCode for the staged changes (or the agent's changes when nothing is staged) into the Source Control commit box. Nothing is committed.",
              },
              "Commit message",
            )
          : null,
      ),
      changesOpen ? fileList(ac.files, "openAgentDiff", s.review?.files) : null,
    );
  }
  if (showWs && ws) {
    const label = `${t("workspaceChanges")}: ${ws.count} file${ws.count === 1 ? "" : "s"}`;
    const why = ac.status === "unavailable" ? `\n${t("agentDiffUnavailable")}: ${ac.reason}` : "";
    parts.push(
      h(
        "div",
        { className: "row small ws-row" },
        h(
          "span",
          {
            className: "muted",
            "data-testid": "workspace-changes",
            title: `${label} (HEAD ↔ working tree)${why}`,
          },
          label,
        ),
        h(
          "button",
          {
            className: "link-btn changes-action",
            "data-tip": "Everything that differs from your last commit, in VS Code's diff editor",
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
            className: "btn subtle small pending-switch",
            "data-tip":
              p.delivery === "queue"
                ? "Send it at the agent's next step instead"
                : "Send it when this task ends instead",
            "aria-label": `${p.delivery === "queue" ? "Steer" : "Queue"}: ${p.text.slice(0, 40)}`,
            "data-testid": "pending-switch",
            onclick: () =>
              send({ type: "setDelivery", id: p.id, delivery: p.delivery === "queue" ? "steer" : "queue" }),
          },
          icon(p.delivery === "queue" ? "steer" : "queue"),
        ),
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
  const live = livePastes();
  chipsEl.replaceChildren(
    ...s.attachments.map((a) =>
      h(
        "span",
        {
          className:
            "chip" +
            (a.kind === "image" ? " img" : "") +
            (a.kind === "problems" ? " problems" : "") +
            (a.auto ? " auto" : ""),
          "data-tip": a.auto
            ? `${a.detail}\nFollows the editor. Sent with your message while it is here.`
            : a.detail,
          "data-testid": a.auto ? "auto-chip" : a.kind === "problems" ? "problems-chip" : undefined,
        },
        a.thumb
          ? h("img", { className: "chip-thumb", src: a.thumb, alt: "" })
          : icon(
              a.kind === "image"
                ? "image"
                : a.kind === "problems"
                  ? "warn"
                  : /:\d/.test(a.label)
                    ? "selection"
                    : "file",
            ),
        h("span", { className: "chip-label" }, a.label),
        a.kind === "image" ? h("span", { className: "chip-detail" }, a.detail.split(" · ")[0]) : null,
        a.auto ? h("span", { className: "chip-detail" }, "editor") : null,
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
    ...live.map(pasteChip),
  );
  chipsEl.hidden = (s.attachments.length === 0 && live.length === 0) || !!subView;
  renderPasteView(live);
  // The message box works only when the chat is usable (connected, folder open, models available).
  // A subagent's conversation is read-only: messages always go to the main chat.
  const connected = s.connection.kind === "connected" && s.onboarding.stage === "ready" && !subView;
  input.disabled = !connected;
  input.placeholder = subView
    ? t("subagentReadOnly")
    : connected
      ? s.busy
        ? deliveryMode === "queue"
          ? "Queue a message for after this task…"
          : "Steer the agent…"
        : "Ask anything…"
      : s.onboarding.stage === "connecting" || s.onboarding.stage === "loading"
        ? "Connecting to OpenCode…"
        : "Finish the setup above to start chatting";
  boxTools.hidden = !!subView;
  boxEl.classList.toggle("active", s.busy && !subView);
  // Steer or queue: only meaningful while the agent works.
  const working = s.busy && !subView && connected;
  deliveryEl.hidden = !working;
  boxEl.classList.toggle("queueing", working && deliveryMode === "queue");
  paintDelivery();
  for (const b of [plusBtn, modeBtn, slashBtn]) b.disabled = !connected;
  const share = contextShare(s);
  ctxBtn.hidden = share === null;
  if (share !== null && s.usage) {
    const pct = Math.round(share * 100);
    ctxBtn.replaceChildren(contextRing(share));
    ctxBtn.classList.toggle("warn", pct >= 70 && pct < 90);
    ctxBtn.classList.toggle("high", pct >= 90);
    const tip = `Context ${formatTokens(s.usage.contextTokens!)} / ${formatTokens(s.usage.contextLimit!)} (${pct}%)`;
    ctxBtn.dataset.tip = tip;
    ctxBtn.setAttribute("aria-label", `${tip}. Usage and Compact.`);
  }
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
  // The limits chip shows only when a limit OpenCode reports is nearly used up.
  const high = (s.quota?.meters ?? []).filter(quotaHigh).sort((a, b) => b.percent - a.percent);
  quotaBtn.hidden = !high.length;
  if (high.length) {
    const top = high[0];
    quotaBtn.replaceChildren(icon("warn"), h("span", {}, `${Math.round(top.percent)}%`));
    const tip = `${top.label}: ${top.limited ? "limit reached" : `${Math.round(top.percent)}% used`}${top.resetsAt ? `, ${resetsIn(top.resetsAt)}` : ""}`;
    quotaBtn.dataset.tip = tip;
    quotaBtn.setAttribute("aria-label", `${tip}. Usage and limits.`);
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
  modeBtn.replaceChildren(icon(agentIcon(agent?.id)), h("span", { className: "ml" }, agent?.name ?? "Agent"));
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
      ? deliveryMode === "queue"
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
  rulesEditor?.paint();
  renderStrip(state);
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
  renderAside();
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
    // The same for the list under a `/command` being typed.
    if (mention?.slash) {
      mention.items = commandSuggestions(mention.query);
      mention.active = Math.min(mention.active, Math.max(0, mention.items.length - 1));
      renderMention();
    }
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
      const now = Date.now();
      for (const ev of msg.events) {
        if (ev.type === "step.started") meter.reset();
        else if (ev.type === "assistant.delta" || ev.type === "reasoning.delta") meter.add(ev.delta, now);
        else if (ev.type === "session.idle" || ev.type === "usage.step") meter.reset();
      }
      paintRate();
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
    case "usageDetails":
      usageDetails = { context: msg.context, today: msg.today };
      refreshUsageMenu();
      break;
    case "mcpServers":
      mcpList = msg.items;
      mcpError = msg.error ?? "";
      mcpBusy = msg.busy ?? null;
      mcpPanel?.paint();
      break;
    case "mcpAddResult":
      mcpPanel?.added(msg.ok, msg.error);
      break;
    case "savedPermissions":
      savedPerms = msg.items;
      savedError = msg.error ?? "";
      rulesEditor?.paint();
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
    case "aside":
      // Closed by the host (another folder, a reconnect): the card goes too.
      if (msg.aside) asideShown = true;
      else if (aside) asideShown = false;
      aside = msg.aside;
      renderAside();
      break;
    case "showProviders":
      openProviders();
      break;
    case "showAgents":
      openAgents({ import: msg.import });
      break;
    case "agents":
      agentsView = msg.view;
      agentsError = msg.error ?? "";
      agentsPanel?.paint();
      break;
    case "agentResult":
      agentsPanel?.result(msg);
      break;
    case "agentImport":
      agentsPanel?.preview(msg.preview, msg.error);
      break;
    case "providers":
      providersView = msg.view;
      providersError = msg.error ?? "";
      providersPanel?.paint();
      break;
    case "showHistory":
      if (!sessionsOpen) {
        sessionsOpen = true;
        bookmarksOpen = false;
        sessionQuery = "";
        send({ type: "refreshSessions" });
        render();
      }
      sessionsEl.querySelector<HTMLElement>("input")?.focus();
      break;
    case "focusModel":
      modelBtn.focus();
      if (!modelBtn.disabled) openMenu(modelBtn, modelMenu(), modelMenuOptions());
      break;
    case "suggestInput":
      // Only an empty box takes the suggestion: what the user typed stays.
      if (!input.value.trim()) {
        input.value = msg.text;
        draft = input.value;
        persist();
        autosize();
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      break;
    case "rewindPreview":
      if (rewindPreviewFor?.messageID === msg.messageID) paintRewindPreview(rewindPreviewFor.el, msg.preview);
      break;
    case "restoreInput": {
      // A message the host handed back keeps its chips; text from the chat (a rewound or
      // pending prompt) gets chips for the pastes it was sent with.
      const back =
        lastSentPastes?.text === msg.text
          ? adoptPastes(msg.text, lastSentPastes.pastes)
          : adoptPastes(...collapsePastes(msg.text));
      lastSentPastes = null;
      input.value = input.value ? `${back}\n${input.value}` : back;
      draft = input.value;
      persist();
      autosize();
      input.focus();
      if (state) renderComposer(state);
      break;
    }
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
  rotateStatusWord();
  paintRate();
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
