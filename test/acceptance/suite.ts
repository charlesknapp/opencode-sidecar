// Runs inside a VS Code Extension Development Host launched by runAcceptance.ts.
// Drives the real extension (same message handlers the webview uses) against
// the real local OpenCode service. Scenario is selected by ACCEPT_SCENARIO.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { summarizeTask } from "../../src/core/currentTask";
import { statusBarText } from "../../src/core/onboarding";
import { opencodeDirectory, sameDirectory } from "../../src/opencode/client";
import { serviceFilePath } from "../../src/opencode/service";
import type { OnboardingStage, TranscriptItem, UiEvent } from "../../src/shared/model";
import type { WebviewMessage } from "../../src/shared/protocol";

interface TestApi {
  controller(): import("../../src/core/sessionController").SessionController | undefined;
  connection(): { kind: string };
  workspace(): import("../../src/shared/model").WorkspaceInfo;
  attachments(): import("../../src/shared/model").ContextAttachment[];
  viewState(): import("../../src/shared/protocol").ViewState;
  handle(msg: WebviewMessage): Promise<void>;
  ensureStarted(): Promise<void>;
  tap(fn: (events: UiEvent[]) => void): { dispose(): void };
  setNotifier(
    fn: (severity: string, message: string, actions: string[]) => Thenable<string | undefined>,
  ): void;
  viewVisible(): boolean;
  statusBar(): { text: string; tooltip: string; command: unknown };
  signInState(): string;
  focusPending(): boolean;
  setupReport(): Promise<{ markdown: string; level: string }>;
  importItems(): import("../../src/shared/model").ImportItem[];
  instructions(): import("../../src/host/instructions").InstructionsHost;
  review(): import("../../src/host/review").AgentReview["testApi"];
}

/**
 * The model the scenarios run on: ACCEPT_MODEL when set (and then it must be offered),
 * otherwise the first of these the service offers. `opencode/big-pickle` is free and
 * offered without a subscription, so every machine with OpenCode has at least that.
 */
const PREFERRED_MODELS = ["opencode-go/kimi-k2.7-code", "opencode/big-pickle"];
let MODEL = process.env.ACCEPT_MODEL || PREFERRED_MODELS[0];
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const events: UiEvent[] = [];
/** Every OpenCode session this run created or used (for the read-only proof). */
const touchedSessions = new Set<string>();

function check(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function items(api: TestApi): TranscriptItem[] {
  return api.controller()?.transcript.items ?? [];
}

async function sendAndWait(
  api: TestApi,
  text: string,
  timeoutMs = 240_000,
): Promise<{ outcome: string; since: number }> {
  const since = events.length;
  await api.handle({ type: "send", text });
  const idle = await waitFor(
    "session idle",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    timeoutMs,
  );
  return { outcome: idle.outcome, since };
}

function toolsSince(api: TestApi, sinceItems: number) {
  return items(api)
    .slice(sinceItems)
    .filter((i): i is Extract<TranscriptItem, { kind: "tool" }> => i.kind === "tool");
}

function lastAssistantText(api: TestApi): string {
  const a = [...items(api)].reverse().find((i) => i.kind === "assistant");
  return a?.kind === "assistant" ? a.text : "";
}

async function common(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand("opencodeSidecar.focusChat");
  await api.ensureStarted();
  await waitFor("connection", () => api.connection().kind === "connected", 30_000);
  check("OpenCode connection", true, JSON.stringify(api.viewState().connection));
  await waitFor("models", () => (api.controller()?.models?.length ?? 0) > 0, 30_000);
  const st = api.viewState();
  check(
    "Models load dynamically",
    (st.models?.length ?? 0) > 0,
    `${st.models?.length} models, e.g. ${st.models
      ?.slice(0, 3)
      .map((m) => m.key)
      .join(", ")}`,
  );
  check(
    "Agents load dynamically",
    (st.agents?.length ?? 0) > 0,
    (st.agents ?? []).map((a) => a.id).join(", "),
  );
  if (!process.env.ACCEPT_MODEL) {
    const offered = new Set((st.models ?? []).map((m) => m.key));
    MODEL = PREFERRED_MODELS.find((k) => offered.has(k)) ?? MODEL;
    console.log(`model: ${MODEL} (set ACCEPT_MODEL to choose another)`);
  }
  await api.handle({ type: "selectModel", key: MODEL });
  // OpenCode's provider catalog can change briefly (e.g. while it refreshes models.dev);
  // if the requested model is not offered yet, reload the catalog and try again.
  for (let attempt = 0; attempt < 3 && api.viewState().selectedModel !== MODEL; attempt++) {
    console.log(
      `model ${MODEL} not offered yet (${(api.viewState().models ?? []).length} models); reloading catalog`,
    );
    await new Promise((r) => setTimeout(r, 5000));
    await api.handle({ type: "retry" });
    await waitFor("connection", () => api.connection().kind === "connected", 30_000);
    await waitFor("models", () => (api.controller()?.models?.length ?? 0) > 0, 30_000);
    await api.handle({ type: "selectModel", key: MODEL });
  }
  check("Model selection", api.viewState().selectedModel === MODEL, String(api.viewState().selectedModel));
}

// ----------------------------------------------------------- real repository (read-only)

async function realRepo(api: TestApi): Promise<void> {
  await common(api);
  const ws = api.workspace();
  check(
    "Workspace name",
    !!ws.active && ws.active.name === process.env.ACCEPT_EXPECT_NAME,
    String(ws.active?.name),
  );
  const expectedBranch = process.env.ACCEPT_EXPECT_BRANCH;
  check("Git branch", !!ws.branch && ws.branch === expectedBranch, `${ws.branch} (git: ${expectedBranch})`);
  check("Repository type", ws.repoKind === "local", ws.repoKind);

  // Read-only safety: Plan agent denies all edits in OpenCode's own permission rules.
  await api.handle({ type: "selectAgent", id: "plan" });
  check("Agent selection (plan, edit-denied)", api.viewState().selectedAgent === "plan");

  await api.handle({ type: "newSession" });
  let mark = items(api).length;
  const r1 = await sendAndWait(api, "Run `git --no-optional-locks status` only. Do not modify anything.");
  const sid = api.controller()?.current?.id;
  check("New session created", !!sid, String(sid));
  const deltas = events.slice(r1.since).filter((e) => e.type === "assistant.delta").length;
  check(
    "Streamed answer",
    deltas > 0 && lastAssistantText(api).length > 0,
    `${deltas} deltas; answer: ${lastAssistantText(api).slice(0, 160).replace(/\n/g, " ")}`,
  );
  const shells = toolsSince(api, mark).filter((t) => t.category === "shell");
  const gitStatus = shells.find((t) => /git\b.*\bstatus/.test(t.detail.command ?? ""));
  check(
    "Shell activity rendered",
    !!gitStatus,
    shells.map((s) => `${s.status}: ${s.detail.command} (cwd ${s.detail.cwd})`).join(" | "),
  );
  check(
    "Shell ran in the correct workspace",
    // OpenCode reports the folder with its own drive-letter case ("C:" where VS Code says "c:").
    !!gitStatus &&
      (gitStatus.detail.cwd === null || (!!ws.active && sameDirectory(gitStatus.detail.cwd, ws.active.path))),
    `${gitStatus?.detail.cwd} (workspace ${ws.active?.path})`,
  );
  check(
    "Shell output mentions the branch",
    !!expectedBranch && !!gitStatus?.detail.output?.includes(expectedBranch),
    (gitStatus?.detail.output ?? "").split("\n")[0],
  );
  const nonReadOnly = toolsSince(api, mark).filter((t) => t.category === "edit");
  check("No edit tools used", nonReadOnly.length === 0, nonReadOnly.map((t) => t.title).join(", "));

  // Context: current file + selection.
  const relFile = process.env.ACCEPT_REAL_FILE;
  if (!relFile) throw new Error("ACCEPT_REAL_FILE is required for the real-repo scenario");
  const fileBase = path.basename(relFile);
  const doc = await vscode.workspace.openTextDocument(path.join(ws.active!.path, relFile));
  const editor = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("opencodeSidecar.addCurrentFile");
  const [startLine, endLine] = (process.env.ACCEPT_REAL_LINES ?? "20-27").split("-").map(Number);
  editor.selection = new vscode.Selection(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
  await vscode.commands.executeCommand("opencodeSidecar.addSelection");
  const chips = api.viewState().attachments.map((a) => a.label);
  check(
    "Context chips (current file + selection)",
    chips.includes(fileBase) && chips.includes(`${fileBase}:${startLine}-${endLine}`),
    chips.join(", "),
  );
  mark = items(api).length;
  await sendAndWait(
    api,
    "Explain only the selected code in two or three sentences. Do not run tools and do not modify anything.",
  );
  const user = items(api)
    .slice(mark)
    .find((i) => i.kind === "user");
  check(
    "Context sent with the prompt",
    user?.kind === "user" &&
      user.attachments.includes(fileBase) &&
      user.attachments.includes(`${fileBase}:${startLine}-${endLine}`),
    user?.kind === "user" ? `text="${user.text}" attachments=${user.attachments.join(", ")}` : "no user item",
  );
  check("Attachments cleared after send", api.viewState().attachments.length === 0);
  check(
    "Explanation streamed",
    lastAssistantText(api).length > 40,
    lastAssistantText(api).slice(0, 200).replace(/\n/g, " "),
  );

  // Harmless permission: reading a file outside the workspace. OpenCode 2.4 allows that by
  // default, so the session is switched to Ask first, whose external_directory rule asks (the
  // Plan agent keeps edits denied).
  await api.handle({ type: "setApprovalMode", mode: "ask", scope: "session" });
  const outside = path.resolve(__dirname, "../../../package.json");
  const since = events.length;
  await api.handle({
    type: "send",
    text: `Read the file ${outside} and reply with only the value of its "name" field. Do not modify anything.`,
  });
  const asked = await waitFor(
    "permission request",
    () =>
      events
        .slice(since)
        .find(
          (e): e is Extract<UiEvent, { type: "permission.requested" }> => e.type === "permission.requested",
        ),
    180_000,
  );
  check(
    "Permission request rendered",
    true,
    `${asked.request.action}: ${asked.request.resources.join(", ")} (always offered: ${asked.request.canAlways})`,
  );
  await api.handle({ type: "respondPermission", requestId: asked.request.id, decision: "once" });
  const perm = items(api).find((i) => i.id === `perm:${asked.request.id}`);
  check(
    "Permission approved once from the sidebar",
    perm?.kind === "permission" && perm.status === "once",
    perm?.kind === "permission" ? perm.status : "missing",
  );
  await waitFor(
    "idle after permission",
    () => events.slice(since).some((e) => e.type === "session.idle"),
    180_000,
  );
  check(
    "Answer after approval",
    lastAssistantText(api).includes("opencode-sidecar"),
    lastAssistantText(api).slice(0, 120),
  );
  await api.handle({ type: "setApprovalMode", mode: "default", scope: "session" });

  // Session continuation: reload from OpenCode's own history.
  await api.handle({ type: "refreshSessions" });
  const listed = api.viewState().sessions.find((s) => s.id === sid);
  check(
    "Session listed for this workspace",
    !!listed,
    listed ? `${listed.title} · ${listed.modelKey} · ${listed.agent}` : "",
  );
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const users = items(api).filter((i) => i.kind === "user").length;
  check(
    "Existing session continuation (history replay)",
    api.controller()?.current?.id === sid && users >= 3,
    `${users} user messages restored`,
  );
  const usage = api.viewState().usage;
  check("Usage display", !!usage?.contextTokens, JSON.stringify(usage));
  await v02RealRepo(api);
}

// ----------------------------------------------------------- fixture (edits/diff/stop)

async function fixture(api: TestApi): Promise<void> {
  await common(api);
  const ws = api.workspace();
  check(
    "Fixture workspace detected",
    ws.repoKind === "local" && ws.branch === "main",
    `${ws.repoKind} ${ws.branch}`,
  );
  await api.handle({ type: "selectAgent", id: "build" });
  await api.handle({ type: "newSession" });

  const mark = items(api).length;
  const r = await sendAndWait(
    api,
    "Append a new line containing exactly the word world to the file a.txt using your edit tool. Do nothing else.",
  );
  check("Edit task finished", r.outcome === "succeeded", r.outcome);
  const summary = items(api)
    .slice(mark)
    .find((i) => i.kind === "turn-summary");
  check(
    "Edited-files summary",
    summary?.kind === "turn-summary" && summary.files.some((f) => f.path === "a.txt" && f.additions >= 1),
    JSON.stringify(summary?.kind === "turn-summary" ? summary.files : null),
  );
  const agentFiles = () => {
    const ac = api.viewState().agentChanges;
    return ac.status === "ok" ? ac.files : [];
  };
  await waitFor("changes panel", () => agentFiles().length > 0, 10_000);
  check(
    "Changed-files panel",
    agentFiles().some((c) => c.path === "a.txt"),
    JSON.stringify(api.viewState().agentChanges),
  );
  await api.handle({ type: "openAgentDiff", path: "a.txt" });
  await new Promise((r) => setTimeout(r, 800));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  check(
    "Native diff editor opened",
    tab?.input instanceof vscode.TabInputTextDiff,
    `${tab?.label} (${tab?.input?.constructor.name})`,
  );
  await api.handle({ type: "openAgentDiffAll" });
  await new Promise((r) => setTimeout(r, 800));
  const tab2 = vscode.window.tabGroups.activeTabGroup.activeTab;
  check(
    "Multi-file native diff (View Diff)",
    !!tab2 && tab2.label.includes("OpenCode agent changes"),
    `${tab2?.label}`,
  );

  // Sensitive permission + deny.
  let since = events.length;
  await api.handle({
    type: "send",
    text: "Read the file .env in this directory and tell me how many lines it has. Do not modify anything.",
  });
  const asked = await waitFor(
    "permission",
    () =>
      events
        .slice(since)
        .find(
          (e): e is Extract<UiEvent, { type: "permission.requested" }> => e.type === "permission.requested",
        ),
    180_000,
  );
  check("Sensitive-path warning on permission card", asked.sensitive.length > 0, asked.sensitive.join("; "));
  await api.handle({ type: "respondPermission", requestId: asked.request.id, decision: "reject" });
  await waitFor("idle after deny", () => events.slice(since).some((e) => e.type === "session.idle"), 180_000);
  const denied = items(api).find((i) => i.id === `perm:${asked.request.id}`);
  check("Permission denied from the sidebar", denied?.kind === "permission" && denied.status === "reject");

  // Stop must cancel the real work.
  const long = waitCommand(120, "finished");
  ({ since } = await sendShell(
    api,
    `Run the shell command \`${long.command}\` exactly as written and wait for it to complete. Do not do anything else.`,
    long.pattern,
    (t) => !!t.detail.cwd,
  ));
  await new Promise((r) => setTimeout(r, 1500));
  const running = psHas(long.pattern);
  const t0 = Date.now();
  await api.handle({ type: "stop" });
  const idle = await waitFor(
    "interrupted",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    30_000,
  );
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  check(
    "Stop cancels via OpenCode interrupt",
    idle.outcome === "interrupted" && elapsed < 15_000,
    `outcome=${idle.outcome} after ${elapsed}ms`,
  );
  check(
    "Cancelled process is gone",
    running && !psHas(long.pattern),
    `before=${running} after=${psHas(long.pattern)}`,
  );
  check("UI no longer busy after stop", api.viewState().busy === false && api.viewState().stopping === false);
  await v02Fixture(api);
  await pastedText(api);
}

// ============================================================ pasted text

/** A large paste sent as a chip reaches OpenCode exactly, where its token was. */
async function pastedText(api: TestApi): Promise<void> {
  await api.handle({ type: "newSession" });
  const paste = Array.from({ length: 12 }, (_, i) => `\tline ${i + 1} ✓  `).join("\n") + "\n";
  const since = events.length;
  await api.handle({
    type: "send",
    text: "How many lines does this text have? Reply with the number only. [Pasted text #1]",
    pastes: [{ token: "[Pasted text #1]", text: paste }],
  });
  await waitIdle(api, since);
  const sid = api.controller()?.current?.id;
  const stored = sid ? await storedMessages(sid) : [];
  const user = stored.find((m) => m.type === "user");
  check(
    "Pasted text reaches OpenCode exactly, in its place",
    user?.text === `How many lines does this text have? Reply with the number only. ${paste}`,
    JSON.stringify(user?.text).slice(0, 120),
  );
  check("The model read the pasted text", /\b12\b/.test(lastAssistantText(api)), lastAssistantText(api));
  await askAside(api);
  await backgroundSessions(api);
  await approvalModes(api);
  await usageAndCosts(api);
  await providerSetup(api);
  await customAgents(api);
  await mcpServers(api);
  await projectInstructions(api);
  await goalHeader(api);
  await stuckCheck(api);
  await longHistory(api);
  await problemsAndCommit(api);
  await agentReview(api);
}

// ============================================================ long sessions

/**
 * A session with 450 more stored messages (synthetic notes held back, then delivered by
 * one run) opens with its newest 400 and **Load earlier messages**, which loads the rest.
 */
async function longHistory(api: TestApi): Promise<void> {
  await api.handle({ type: "newSession" });
  await sendAndWait(api, "Reply with the word ok.");
  const sid = api.controller()?.current?.id;
  if (!sid) return check("History: a session to grow", false);
  const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8"));
  const post = (body: unknown) =>
    fetch(new URL(`/api/session/${sid}/synthetic`, svc.url), {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  for (let i = 0; i < 450; i += 25)
    await Promise.all(
      Array.from({ length: 25 }, (_, k) =>
        post({ text: `Note ${i + k}`, metadata: { source: "shell", state: "completed" }, resume: false }),
      ),
    );
  const since = events.length;
  await post({ text: "Reply with the word ok.", resume: true });
  await waitIdle(api, since);
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid });
  await waitFor("the session", () => api.viewState().history?.more || undefined, 30_000);
  const first = items(api).length;
  await api.handle({ type: "loadEarlier" });
  await waitFor("earlier messages", () => (items(api).length > first ? true : undefined), 30_000);
  check(
    "History: Load earlier messages loads the rest",
    api.viewState().history?.more === false && items(api).some((i) => i.kind === "user"),
    `${first} → ${items(api).length}`,
  );
}

// ============================================================ the agent seems stuck

/**
 * Three identical reads in a row bring up the stuck card in the timeline, which only
 * suggests (the run ends by itself), and Dismiss hides it. A model that does not repeat
 * the read as asked gets no card, which is checked too.
 */
async function stuckCheck(api: TestApi): Promise<void> {
  await api.handle({ type: "newSession" });
  const since = events.length;
  await api.handle({
    type: "send",
    text: "Use the read tool on a.txt three times in a row, one call after another, without anything in between. Then reply with the word done.",
  });
  await waitIdle(api, since);
  const reads = toolsSince(api, 0).filter((t) => t.category === "read");
  const card = items(api).find((i) => i.kind === "stuck");
  if (reads.length >= 3) {
    check("Stuck: three identical reads show the card", card?.kind === "stuck", String(reads.length));
    check(
      "Stuck: the card names the call and the run was not stopped for the user",
      card?.kind === "stuck" &&
        /a\.txt/.test(card.stuck.calls[0] ?? "") &&
        !items(api).some((i) => i.kind === "notice" && i.text === "Stopped."),
      JSON.stringify(card),
    );
    if (card?.kind === "stuck") {
      await api.handle({ type: "stuckAction", sessionID: card.sessionID, action: "dismiss" });
      const after = api.controller()!.transcript.get(card.id);
      check(
        "Stuck: Dismiss hides it",
        after?.kind === "stuck" && (after.resolved === "dismissed" || after.resolved === "moved-on"),
      );
    }
  } else check("Stuck: no card without a loop", !card, `${reads.length} read(s)`);
}

// ===================================================== problems and commit messages

/**
 * "Fix with OpenCode" on a TypeScript error sends the diagnostic to OpenCode, and "Write
 * Commit Message with OpenCode" fills the Git commit box without adding to the session.
 */
async function problemsAndCommit(api: TestApi): Promise<void> {
  const root = api.workspace().active!.path;
  const file = path.join(root, "broken.ts");
  fs.writeFileSync(file, 'export const total: number = "zero";\n');
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const diag = await waitFor(
    "TypeScript diagnostic",
    () => vscode.languages.getDiagnostics(uri).find((d) => d.severity === vscode.DiagnosticSeverity.Error),
    90_000,
  );
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    diag.range,
  );
  const fix = actions?.find((a) => a.title === "Fix with OpenCode");
  check(
    "Light bulb offers Fix with OpenCode",
    !!fix?.command,
    (actions ?? []).map((a) => a.title).join(", "),
  );
  await vscode.commands.executeCommand(
    fix?.command?.command ?? "opencodeSidecar.fixWithOpenCode",
    ...(fix?.command?.arguments ?? [uri, diag.range]),
  );
  const chip = api.viewState().attachments.find((a) => a.kind === "problems");
  check("Problems chip in the message box", !!chip, chip?.label ?? "none");
  await api.handle({ type: "newSession" });
  const since = events.length;
  await api.handle({ type: "send", text: "Fix these problems. Change only broken.ts." });
  await waitIdle(api, since);
  const sid = api.controller()?.current?.id;
  const stored = sid ? await storedMessages(sid) : [];
  const user = String(stored.find((m) => m.type === "user")?.text ?? "");
  check(
    "The diagnostic reached OpenCode (file, line, ts(2322), message, code)",
    /Problems from VS Code \(1 error in broken\.ts\)/.test(user) &&
      /line 1:\d+, error ts\(2322\): Type 'string' is not assignable to type 'number'/.test(user) &&
      user.includes('> 1 | export const total: number = "zero";'),
    user.slice(0, 300),
  );
  check("The chip is cleared after sending", !api.attachments().some((a) => a.kind === "problems"));

  // Commit message: stage the file and ask; the commit box is filled, nothing is committed.
  execFileSync("git", ["add", "broken.ts"], { cwd: root });
  const git = vscode.extensions.getExtension("vscode.git")!.exports.getAPI(1);
  const repo = git.getRepository(uri);
  repo.inputBox.value = "";
  const before = sid ? (await storedMessages(sid)).length : 0;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  await vscode.commands.executeCommand("opencodeSidecar.writeCommitMessage", repo);
  const message = String(repo.inputBox.value);
  check("Commit message written into the Git commit box", message.trim().length > 0, message.slice(0, 120));
  check("No code fences in the commit message", !message.includes("```"));
  check(
    "Nothing committed, nothing added to the session",
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim() === head &&
      (sid ? (await storedMessages(sid)).length : 0) === before,
  );
  execFileSync("git", ["reset", "-q", "broken.ts"], { cwd: root });
}

// ============================================================ Keep / Undo review

/**
 * The agent edits two hunks of a fixture file; Undo one through the command, Keep the
 * other: the file holds only the kept hunk, the decisions survive a reload of the review
 * state and a session switch, and "Stage kept changes" stages exactly the kept hunk.
 */
async function agentReview(api: TestApi, edits: "agent" | "between-turns" = "agent"): Promise<void> {
  const root = api.workspace().active!.path;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  const rel = "review.txt";
  const file = path.join(root, rel);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  git("add", rel);
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "review fixture");
  await api.handle({ type: "newSession" });
  if (edits === "agent") {
    await api.handle({ type: "selectAgent", id: "build" });
    const since = events.length;
    await api.handle({
      type: "send",
      text: "In review.txt, replace the line `line 3` with `agent 3` and the line `line 16` with `agent 16`, using your edit tool. Do not touch any other file.",
    });
    await waitIdle(api, since);
  } else {
    // Without the model editing: OpenCode snapshots each step, so edits made between two
    // tiny prompts show as the session's changes (also at the free daily limit).
    await api.handle({ type: "selectAgent", id: "plan" });
    const turn = async () => {
      const since = events.length;
      await api.handle({ type: "send", text: "Reply with the single word OK. Do not use any tools." });
      await waitIdle(api, since);
    };
    await turn();
    const edited = [...lines];
    edited[2] = "agent 3";
    edited[15] = "agent 16";
    fs.writeFileSync(file, edited.join("\n") + "\n");
    await turn();
    await api.controller()?.refreshChanges();
  }
  await waitFor(
    "review entries",
    () => {
      api.review().sync();
      return api
        .review()
        .entries()
        .find((e) => e.file === rel && e.hunks.length === 2);
    },
    20_000,
  ).catch(() => undefined);
  await api.review().refresh();
  const entry = api
    .review()
    .entries()
    .find((e) => e.file === rel);
  check("The agent's two hunks are listed for review", entry?.hunks.length === 2, JSON.stringify(entry));
  if (!entry || entry.hunks.length !== 2) return;
  const doc = await vscode.workspace.openTextDocument(entry.uri);
  await vscode.window.showTextDocument(doc);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    doc.uri,
  );
  check(
    "CodeLens offers Keep and Undo on each hunk, and the file",
    ["Keep file", "Undo file", "Keep", "Undo"].every((t) => lenses?.some((l) => l.command?.title === t)),
    (lenses ?? []).map((l) => l.command?.title).join(" | "),
  );
  const [first, second] = entry.hunks;
  await vscode.commands.executeCommand("opencodeSidecar.undoAgentChange", entry.uri, second);
  await vscode.commands.executeCommand("opencodeSidecar.keepAgentChange", entry.uri, first);
  const want = [...lines];
  want[2] = "agent 3";
  check(
    "Undo puts back exactly that hunk",
    doc.getText() === want.join("\n") + "\n",
    JSON.stringify(doc.getText()),
  );
  await doc.save();
  const counts = () =>
    api
      .review()
      .entries()
      .find((e) => e.file === rel)?.counts;
  check("One kept, one undone", counts()?.kept === 1 && counts()?.undone === 1, JSON.stringify(counts()));
  api.review().reload();
  await api.review().refresh();
  check(
    "Review state survives a reload",
    counts()?.kept === 1 && counts()?.undone === 1 && counts()?.undecided === 0,
    JSON.stringify(counts()),
  );
  const sid = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  await waitFor(
    "changes after reopen",
    () => api.viewState().agentChanges.status === "ok" || undefined,
    15_000,
  );
  await waitFor("review after reopen", () => api.viewState().review?.files[rel] ?? undefined, 15_000).catch(
    () => undefined,
  );
  const view = api.viewState().review?.files[rel];
  check(
    "Review state survives a session switch",
    view?.kept === 1 && view.undone === 1,
    JSON.stringify(view),
  );
  await vscode.commands.executeCommand("opencodeSidecar.stageKeptChanges");
  const cached = git("diff", "--cached", "--", rel);
  check(
    "Stage kept changes stages exactly the kept hunk",
    /^\+agent 3$/m.test(cached) && !/agent 16/.test(cached) && /^-line 3$/m.test(cached),
    cached,
  );
  git("reset", "-q", rel);
}

// ============================================================ providers and setup check

/**
 * Read-only: the Providers panel lists the scenario model's provider with its models, a run
 * that fails on a model OpenCode does not have gets Choose another model and Sign in again,
 * and the setup check reaches the service. Nothing is connected, changed or removed.
 */
async function providerSetup(api: TestApi): Promise<void> {
  const c = api.controller()!;
  const view = await c.providersView();
  const provider = MODEL.split("/")[0];
  const row = view.connected.find((r) => r.id === provider || r.name.toLowerCase().includes(provider));
  check(
    "Providers panel: the model's provider is connected, with its models",
    !!row && row.state !== "needs-auth" && row.models > 0,
    JSON.stringify(row),
  );
  check(
    "Providers panel: every other provider can be searched",
    view.available.length > 50,
    String(view.available.length),
  );
  check("Providers panel: no settings or keys", !/apiKey|"key"/.test(JSON.stringify(view)));
  await api.handle({ type: "loadProviders" });
  // The payload OpenCode 2.4.2 sends for a model it does not have (no model is called).
  const sid = c.current?.id;
  if (sid) {
    const mark = items(api).length;
    c.handleRawEvent({
      id: "evt_acceptance",
      created: Date.now(),
      type: "session.execution.failed",
      data: { sessionID: sid, error: { type: "provider.no-route", message: `Model unavailable: ${MODEL}` } },
    });
    const card = items(api)
      .slice(mark)
      .find((i): i is Extract<TranscriptItem, { kind: "error" }> => i.kind === "error");
    check(
      "Error card: Choose another model and Sign in again to the provider",
      !!card && card.actions.includes("changeModel") && card.actions.includes("reauth") && !!card.provider,
      JSON.stringify(card),
    );
  }
  const report = await api.setupReport();
  const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8")) as { password?: string };
  check("Setup check reaches the service", /Reachable: OpenCode/.test(report.markdown), report.level);
  check("Setup check holds no password", !svc.password || !report.markdown.includes(svc.password));
}

// ============================================================ MCP servers

/**
 * A tiny stdio MCP server (outside the folder, run with VS Code's Node) is added for this
 * OpenCode run through the panel's handlers, disconnected, connected again, and the model
 * is asked to call its tool; then it is removed. OpenCode's config is never written.
 */
async function mcpServers(api: TestApi): Promise<void> {
  const c = api.controller()!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-accept-mcp-"));
  const js = path.join(tmp, "tiny-mcp.js");
  fs.writeFileSync(
    js,
    [
      'const rl = require("readline").createInterface({ input: process.stdin });',
      'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
      'rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id === undefined) return;',
      '  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tiny", version: "1" } } });',
      '  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "shout", description: "Returns the text in capitals", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });',
      '  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(m.params.arguments.text).toUpperCase() + "!" }] } });',
      '  else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }); });',
    ].join("\n"),
  );
  const state = async () => (await c.mcpServers()).find((m) => m.name === "accept-tiny");
  try {
    await api.handle({ type: "mcpAdd", name: "accept-tiny", target: `"${process.execPath}" "${js}"` });
    const added = await state();
    check(
      "MCP: a server added for this run connects and is marked as such",
      added?.status === "connected" && added.runtime === true,
      JSON.stringify(added),
    );
    await api.handle({ type: "mcpDisconnect", name: "accept-tiny" });
    check("MCP: Disconnect", (await state())?.status === "disabled");
    await api.handle({ type: "mcpConnect", name: "accept-tiny" });
    check("MCP: Connect again", (await state())?.status === "connected");
    await api.handle({ type: "newSession" });
    const mark = items(api).length;
    await sendAndWait(api, 'Call the shout tool with the text "sidecar" and tell me what it returned.');
    const tool = toolsSince(api, mark).find((i) => /shout/.test(JSON.stringify(i)));
    check("MCP: the model can call the server's tool", !!tool, JSON.stringify(tool)?.slice(0, 200));
  } finally {
    await api.handle({ type: "mcpRemove", name: "accept-tiny" });
    check("MCP: Remove", (await state()) === undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================ goals

/**
 * A small `/goal` runs to its end: the header follows OpenCode's goal plugin (in progress,
 * then achieved or stopped with a reason), the goal's notices are in the conversation, and
 * End goal clears it. The file it asks for is removed afterwards.
 */
async function goalHeader(api: TestApi): Promise<void> {
  const c = api.controller()!;
  const root = api.workspace().active!.path;
  const file = path.join(root, "goal.txt");
  try {
    await api.handle({ type: "newSession" });
    await api.handle({
      type: "runCommand",
      name: "goal",
      text: "Create a file named goal.txt containing the word done, then show its contents with a shell command.",
    });
    await waitFor("the goal header", () => api.viewState().goal ?? undefined, 30_000);
    check("Goal: the header shows the objective", /goal\.txt/.test(api.viewState().goal?.objective ?? ""));
    const end = await waitFor(
      "the goal to end",
      () => (api.viewState().goal?.status !== "active" ? api.viewState().goal : undefined),
      360_000,
    );
    check(
      "Goal: achieved, or stopped with OpenCode's reason",
      end?.status === "complete" || (end?.status === "paused" && !!end.reason),
      JSON.stringify(end),
    );
    const rows = items(api).filter((i) => i.kind === "background" && i.source === "goal");
    check("Goal: its notices are in the conversation", rows.length >= 1, String(rows.length));
    await api.handle({ type: "goalAction", action: "clear" });
    await waitFor("the goal to clear", () => (api.viewState().goal === null ? true : undefined), 15_000);
    check("Goal: End goal clears the header", api.viewState().goal === null && !c.goalView());
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ============================================================ project instructions

/**
 * The fixture has a CLAUDE.md; the panel's Create warns that OpenCode would stop reading
 * it and makes AGENTS.md from a copy of it, then "Remember this" adds a rule (the input
 * box and the questions answered here); a new session follows it, which shows OpenCode
 * read the file. Both files are removed afterwards.
 */
async function projectInstructions(api: TestApi): Promise<void> {
  const root = api.workspace().active!.path;
  const file = path.join(root, "AGENTS.md");
  const claude = path.join(root, "CLAUDE.md");
  const host = api.instructions();
  const asked: string[] = [];
  // The first choice: "Create AGENTS.md and copy CLAUDE.md into it", "Add", "Create".
  host.confirm = async (message, _detail, ...actions) => (asked.push(message), actions[0]);
  host.ask = async (_title, value) => value;
  fs.writeFileSync(claude, "# Claude rules\n\n- Answer in English.\n");
  try {
    await api.handle({ type: "createInstructions", scope: "project" });
    check(
      "Instructions: Create asks, then writes AGENTS.md from a copy of CLAUDE.md",
      asked[0] === "Create AGENTS.md?" &&
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8") === fs.readFileSync(claude, "utf8"),
      JSON.stringify(asked),
    );
    await api.handle({ type: "remember", text: "End every reply with the word MANGO." });
    const text = fs.readFileSync(file, "utf8");
    check(
      "Instructions: Remember this adds one line after asking",
      text.endsWith("- End every reply with the word MANGO.\n") && asked.some((a) => a.startsWith("Add")),
      JSON.stringify(asked),
    );
    // OpenCode notices the file by itself.
    await sleep(3000);
    await api.handle({ type: "newSession" });
    await sendAndWait(api, "Say hello in three words.");
    check(
      "Instructions: a new session follows AGENTS.md",
      /MANGO/i.test(lastAssistantText(api)),
      lastAssistantText(api),
    );
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(claude, { force: true });
  }
}

// ============================================================ custom agents

/**
 * A fixture .roomodes is imported as OpenCode agents through the panel's handlers, the
 * imported agent is picked and a tiny prompt runs on it: OpenCode records that agent on
 * the reply. A mode named plan overrides the built-in Plan agent only when the import says
 * it was confirmed, and Remove override brings the built-in back. The mode file and the
 * agent files are removed afterwards.
 */
async function customAgents(api: TestApi): Promise<void> {
  const root = api.workspace().active!.path;
  const modes = path.join(root, ".roomodes");
  const agentsDir = path.join(root, ".opencode");
  const hadConfig = fs.existsSync(agentsDir);
  fs.writeFileSync(
    modes,
    JSON.stringify({
      customModes: [
        {
          slug: "accept-terse",
          name: "✂️ Terse",
          roleDefinition: "You answer in as few words as possible.",
          whenToUse: "Short answers",
          groups: ["read"],
        },
        {
          slug: "accept-orchestrator",
          name: "Orchestrator",
          roleDefinition: "You coordinate complex work by delegating it with new_task.",
          groups: [],
        },
        {
          slug: "plan",
          name: "Plan",
          roleDefinition: "You plan before anyone builds.",
          whenToUse: "Acceptance plan override",
          groups: ["read"],
        },
      ],
    }),
  );
  const c = () => api.controller()!;
  const planFile = path.join(agentsDir, "agents", "plan.md");
  try {
    await api.handle({ type: "previewImport" });
    const all = api.importItems().filter((i) => i.source === ".roomodes");
    const plan = all.find((i) => i.name === "plan");
    const items = all.filter((i) => i !== plan);
    check(
      "Agents: the import preview lists the fixture's modes",
      items.length === 2 &&
        items.find((i) => i.name === "accept-terse")?.mode === "all" &&
        items.find((i) => i.name === "accept-orchestrator")?.mode === "primary",
      JSON.stringify(items),
    );
    check(
      "Agents: a mode named after a built-in agent is an unchecked override",
      !!plan?.overrides && !plan.checked && /built-in/.test(plan.conflict ?? ""),
      JSON.stringify(plan),
    );
    await api.handle({ type: "importModes", keys: items.map((i) => i.key), scope: "project" });
    check(
      "Agents: the modes are written as agent files",
      fs.existsSync(path.join(agentsDir, "agents", "accept-terse.md")) &&
        fs.existsSync(path.join(agentsDir, "agents", "accept-orchestrator.md")),
    );
    await waitFor("imported agents", () => c().agents?.some((a) => a.id === "accept-terse"), 20_000);
    check(
      "Agents: the agent picker offers them without a restart",
      !!c().agents?.some((a) => a.id === "accept-orchestrator"),
      (c().agents ?? []).map((a) => a.id).join(", "),
    );
    await api.handle({ type: "selectAgent", id: "accept-terse" });
    await api.handle({ type: "newSession" });
    const r = await sendAndWait(api, "Reply with the single word OK. Do not use any tools.");
    const sid = c().current?.id;
    const stored = sid ? await storedMessages(sid) : [];
    const reply = stored.find((m) => m.type === "assistant");
    check(
      "Agents: OpenCode records the imported agent on the reply",
      reply?.agent === "accept-terse",
      `${r.outcome}; agent ${String(reply?.agent)}`,
    );
    if (plan) {
      const builtIn = (await c().agentDetails()).find((a) => a.id === "plan");
      await api.handle({ type: "importModes", keys: [plan.key], scope: "project" });
      check("Agents: an override is not written unconfirmed", !fs.existsSync(planFile));
      await api.handle({ type: "importModes", keys: [plan.key], scope: "project", override: true });
      await c().awaitAgents((l) =>
        l.some((a) => a.id === "plan" && a.description === "Acceptance plan override"),
      );
      const over = (await c().agentDetails()).find((a) => a.id === "plan");
      check(
        "Agents: OpenCode applies the file on top of the built-in plan agent",
        fs.existsSync(planFile) &&
          over?.description === "Acceptance plan override" &&
          over.name === builtIn?.name &&
          /plan before anyone builds/.test(over.system),
        JSON.stringify(over),
      );
      await api.handle({ type: "deleteAgent", id: "plan" });
      const back = (await c().agentDetails()).find((a) => a.id === "plan");
      check(
        "Agents: Remove override brings the built-in back",
        !fs.existsSync(planFile) && JSON.stringify(back) === JSON.stringify(builtIn),
        JSON.stringify(back),
      );
    }
  } finally {
    fs.rmSync(modes, { force: true });
    fs.rmSync(planFile, { force: true });
    for (const n of ["accept-terse", "accept-orchestrator"])
      fs.rmSync(path.join(agentsDir, "agents", `${n}.md`), { force: true });
    if (!hadConfig) fs.rmSync(agentsDir, { recursive: true, force: true });
    await c().awaitAgents((l) => !l.some((a) => a.id.startsWith("accept-")));
    await api.handle({ type: "selectAgent", id: "build" });
  }
}

// ============================================================ usage and costs

/**
 * A reply's turn footer names the model it ran on, the cost tables count its step, and
 * the context breakdown splits OpenCode's reported total into the parts the messages show
 * and an honest rest.
 */
async function usageAndCosts(api: TestApi): Promise<void> {
  await api.handle({ type: "newSession" });
  const mark = items(api).length;
  const r = await sendAndWait(api, "Reply with the single word OK. Do not use any tools.");
  check("Usage: reply finished", r.outcome === "succeeded", r.outcome);
  const meta = items(api)
    .slice(mark)
    .find((i): i is Extract<TranscriptItem, { kind: "turn-meta" }> => i.kind === "turn-meta");
  check(
    "Turn footer names the model and counts the step",
    !!meta && meta.models.includes(MODEL) && meta.steps >= 1 && meta.tokens > 0,
    JSON.stringify(meta),
  );
  check(
    "Turn footer speed is measured (OpenCode timed the stream)",
    meta?.rate != null && meta.rate > 0,
    String(meta?.rate),
  );
  const costs = api.viewState().costs;
  const row = costs?.byModel.find((m) => m.key === MODEL);
  check(
    "Cost by model has the model's steps",
    !!row && (row.steps ?? 0) >= 1 && (row.cost === null || row.cost >= 0),
    JSON.stringify(costs),
  );
  const ctx = await api.controller()?.contextBreakdown();
  check(
    "Context breakdown: the messages' parts and the rest add up to OpenCode's total",
    !!ctx &&
      ctx.total !== null &&
      ctx.parts.some((p) => p.key === "prompts") &&
      ctx.parts.reduce((n, p) => n + p.tokens, 0) === ctx.total,
    JSON.stringify(ctx),
  );
}

// ============================================================ approval modes

/**
 * A mode changes whether a real shell tool call asks: in Ask the command waits in the
 * dock ("Always allow commands like this" adds a session rule and lets it run); in Auto
 * the same kind of command runs without asking. The session's rules are read back from
 * OpenCode each time; the folder's mode and OpenCode's config are never touched.
 */
async function approvalModes(api: TestApi): Promise<void> {
  const c = () => api.controller()!;
  await api.handle({ type: "selectAgent", id: "build" });
  await api.handle({ type: "newSession" });
  await api.handle({ type: "setApprovalMode", mode: "ask", scope: "session" });
  check("Ask is set for the next session", api.viewState().approval.mode === "ask");
  let since = events.length;
  const mark = items(api).length;
  await api.handle({
    type: "send",
    text: "Run the shell command `node --version` exactly as written, then reply with its output.",
  });
  const asked = await waitFor(
    "the shell command to ask",
    () =>
      events
        .slice(since)
        .find(
          (e): e is Extract<UiEvent, { type: "permission.requested" }> => e.type === "permission.requested",
        ) ?? (events.slice(since).some((e) => e.type === "session.idle") ? ("idle" as const) : undefined),
    180_000,
  );
  if (asked === "idle") return check("Ask: a shell command waits for an answer", false, "it ran no command");
  check(
    "Ask: a shell command waits for an answer",
    /shell|bash/.test(asked.request.action) && asked.request.resources.some((r) => /node --version/.test(r)),
    `${asked.request.action}: ${asked.request.resources.join(", ")}`,
  );
  const sid = c().current!.id;
  check("The session was created in Ask", api.viewState().approval.mode === "ask");
  await api.handle({
    type: "allowLike",
    requestId: asked.request.id,
    patterns: ["node --version *"],
    scope: "session",
  });
  await waitIdle(api, since);
  check(
    "Always allow commands like this adds the rule and lets it run",
    api.viewState().approval.rules.some((r) => r.resource === "node --version *" && r.effect === "allow") &&
      toolsSince(api, mark).some((t) => t.category === "shell" && t.status === "completed"),
    JSON.stringify(api.viewState().approval.rules),
  );

  await api.handle({ type: "setApprovalMode", mode: "auto", scope: "session" });
  check(
    "Auto is read back from OpenCode",
    api.viewState().approval.mode === "auto" &&
      (c().current?.permissions ?? []).some((r) => r.effect === "deny" && r.resource === "rm -rf *"),
    JSON.stringify(c().current?.permissions),
  );
  since = events.length;
  const mark2 = items(api).length;
  await api.handle({
    type: "send",
    text: 'Run the shell command `node -e "console.log(6*7)"` exactly as written, then reply with its output.',
  });
  await waitIdle(api, since);
  check(
    "Auto: the shell command runs without asking",
    !events.slice(since).some((e) => e.type === "permission.requested") &&
      toolsSince(api, mark2).some((t) => t.category === "shell" && t.status === "completed"),
    toolsSince(api, mark2)
      .map((t) => `${t.title} ${t.status}`)
      .join(" | "),
  );
  await api.handle({ type: "setApprovalMode", mode: "default", scope: "session" });
  check(
    "Default clears the mode's rules and keeps the user's",
    api.viewState().approval.mode === "custom" && c().current?.id === sid,
    api.viewState().approval.mode,
  );
}

// ============================================================ ask aside

/** `/btw` while the main session works: answered in a hidden fork, then sent to main and closed. */
async function askAside(api: TestApi): Promise<void> {
  const c = () => api.controller()!;
  await api.handle({ type: "newSession" });
  await sendAndWait(api, "Remember the word PINEAPPLE. Reply with the single word OK.");
  const main = c().current!.id;
  const mainItems = items(api).length;
  const slow = waitCommand(25, "main-done");
  const { since } = await sendShell(
    api,
    `Run the shell command \`${slow.command}\` exactly as written and wait for it, then reply DONE.`,
    slow.pattern,
  );
  const existing = await storedSessions(api);
  await api.handle({
    type: "askAside",
    text: "Which word did I ask you to remember? Reply with that word only.",
  });
  await waitFor("side answer", () => c().asideView()?.status === "idle" || undefined, 120_000);
  const turn = c().asideView()!.turns[0];
  check(
    "Ask aside answers from the session's history",
    /pineapple/i.test(turn.answer),
    turn.error ?? turn.answer,
  );
  check("The main task keeps running while the side thread answers", api.viewState().busy, "");
  const leaked = items(api)
    .slice(mainItems)
    .some((i) => (i.kind === "user" || i.kind === "assistant") && /Which word did I ask/i.test(i.text));
  check("Nothing of the side thread reaches the main timeline", !leaked);
  await api.handle({ type: "refreshSessions" });
  const listed = new Set(api.viewState().sessions.map((s) => s.id));
  const forks = (await storedSessions(api)).filter((s) => !existing.includes(s));
  check(
    "The side thread is not in History",
    forks.length === 1 && !listed.has(forks[0]) && listed.has(main),
    JSON.stringify(forks),
  );
  await api.handle({ type: "asideToMain" });
  await waitFor(
    "queued",
    () => api.viewState().pending.some((p) => /side question/i.test(p.text)) || undefined,
    10_000,
  ).catch(() => undefined);
  check(
    "Add to session queues the answer while the agent works",
    api.viewState().pending.some((p) => p.delivery === "queue" && /pineapple/i.test(p.text)),
    JSON.stringify(api.viewState().pending.map((p) => [p.delivery, p.text.slice(0, 40)])),
  );
  await api.handle({ type: "closeAside" });
  const after = await storedSessions(api);
  check(
    "Closing deletes the side thread",
    forks.every((f) => !after.includes(f)),
    JSON.stringify(forks),
  );
  await waitIdle(api, since);
  check("The main task finished normally", c().current?.id === main && !api.viewState().busy);
}

// ====================================================== background sessions

/**
 * Two sessions at once: one keeps working while another is open. The strip shows it
 * working, then finished; its notice's Open switches to it; the badge counts nothing.
 */
async function backgroundSessions(api: TestApi): Promise<void> {
  const c = () => api.controller()!;
  const notices: Array<{ message: string; actions: string[] }> = [];
  // A background notice's Open is clicked once the strip has been checked.
  let release!: () => void;
  const clicked = new Promise<void>((r) => (release = r));
  api.setNotifier(async (_severity, message, actions) => {
    notices.push({ message, actions });
    if (actions[0] !== "Open") return undefined;
    await clicked;
    return "Open";
  });
  await api.handle({ type: "newSession" });
  await sendAndWait(api, "Reply with the single word OK.");
  const first = c().current!.id;
  const slow = waitCommand(30, "background-done");
  await sendShell(
    api,
    `Run the shell command \`${slow.command}\` exactly as written and wait for it, then reply DONE.`,
    slow.pattern,
  );
  await api.handle({ type: "newSession" });
  await sendAndWait(api, "Reply with the single word OK.");
  const second = c().current!.id;
  const tab = (id: string) => api.viewState().strip.find((t) => t.id === id);
  check(
    "The strip shows the open session and the one working in the background",
    tab(second)?.current === true && /^(running|done)$/.test(tab(first)?.status ?? ""),
    JSON.stringify(api.viewState().strip),
  );
  const background = await waitFor(
    "the background session's notice",
    () => notices.find((n) => n.actions[0] === "Open"),
    180_000,
  );
  check(
    "A session that is not open is notified when it finishes, with Open",
    /finished in/.test(background.message),
    JSON.stringify(notices),
  );
  release();
  await waitFor("Open switches to it", () => c().current?.id === first || undefined, 15_000).catch(
    () => undefined,
  );
  check("Open switches to the session that finished", c().current?.id === first, c().current?.id ?? "");
  check(
    "Both stay on the strip; the opened one is seen",
    tab(first)?.current === true && tab(first)?.status === "idle" && !!tab(second),
    JSON.stringify(api.viewState().strip),
  );
  await api.handle({ type: "closeStripTab", id: second });
  check("× takes a session off the strip", !tab(second), JSON.stringify(api.viewState().strip));
  check(
    "The closed session stays in History",
    api.viewState().sessions.some((s) => s.id === second),
  );
}

/** Root session ids OpenCode lists for the open folder, newest first (straight from OpenCode). */
async function storedSessions(api: TestApi): Promise<string[]> {
  const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8"));
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
  const url = new URL("/api/session", svc.url);
  url.searchParams.set("directory", opencodeDirectory(api.workspace().active!.path));
  url.searchParams.set("parentID", "null");
  url.searchParams.set("order", "desc");
  url.searchParams.set("limit", "100");
  const page = (await (await fetch(url, { headers })).json()) as { data: Array<{ id: string }> };
  return page.data.map((s) => s.id);
}

// ========================================================= controls and budget

async function waitIdle(_api: TestApi, since: number, timeoutMs = 240_000) {
  return waitFor(
    "session idle",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    timeoutMs,
  );
}

/** Copies an assistant message through the real handler and returns the clipboard text (clipboard restored after). */
async function copyViaUi(api: TestApi, itemId: string): Promise<string> {
  const saved = await vscode.env.clipboard.readText();
  try {
    await api.handle({ type: "copyMessage", itemId, requestId: "accept" });
    return await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}

function lastAssistant(api: TestApi): Extract<TranscriptItem, { kind: "assistant" }> | undefined {
  return [...items(api)]
    .reverse()
    .find((i): i is Extract<TranscriptItem, { kind: "assistant" }> => i.kind === "assistant");
}

async function checkFullReportCopy(api: TestApi, prompt: string): Promise<void> {
  const since = events.length;
  await api.handle({ type: "send", text: prompt });
  await waitIdle(api, since);
  const item = lastAssistant(api);
  const sid = api.controller()?.current?.id;
  check(
    "Report has Markdown structure",
    !!item && /^#/m.test(item.text) && /^\s*[-*] /m.test(item.text) && /\|/.test(item.text),
    (item?.text ?? "").slice(0, 120).replace(/\n/g, "⏎"),
  );
  const copied = item ? await copyViaUi(api, item.id) : "";
  check(
    "Full-message Copy equals canonical text",
    !!item && copied === item.text,
    `${copied.length} chars copied`,
  );
  // Reload the session from OpenCode's own storage and compare again.
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const stored = lastAssistant(api);
  check(
    "Copied Markdown matches OpenCode's stored message exactly",
    !!stored && stored.text === copied,
    `${stored?.text.length} vs ${copied.length}`,
  );
}

async function checkQuestion(api: TestApi, prompt: string, pick: (opts: string[]) => string): Promise<void> {
  const since = events.length;
  await api.handle({ type: "send", text: prompt });
  const req = await waitFor(
    "OpenCode question",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "form.requested" }> => e.type === "form.requested"),
    180_000,
  );
  const field = req.form.fields[0];
  check(
    "Question card rendered",
    items(api).some((i) => i.id === `form:${req.form.id}` && i.kind === "form" && i.status === "pending"),
    `${req.form.title}: ${field.type === "external" ? "" : (field.title ?? field.key)}`,
  );
  const sid = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const restored = items(api).find((i) => i.id === `form:${req.form.id}`);
  check(
    "Pending question survives session reopen",
    restored?.kind === "form" && restored.status === "pending",
  );
  const options =
    field.type === "string" || field.type === "multiselect" ? (field.options ?? []).map((o) => o.value) : [];
  const value = pick(options);
  await api.handle({
    type: "answerForm",
    formId: req.form.id,
    answer: { [field.key]: field.type === "multiselect" ? [value] : value },
  });
  const answered = items(api).find((i) => i.id === `form:${req.form.id}`);
  check(
    "Question answered from the sidebar",
    answered?.kind === "form" && answered.status === "answered",
    value,
  );
  const after = events.length;
  await waitIdle(api, Math.min(since, after));
  check(
    "Agent continued after the answer",
    lastAssistantText(api).length > 0,
    lastAssistantText(api).slice(0, 100).replace(/\n/g, " "),
  );
}

async function v02RealRepo(api: TestApi): Promise<void> {
  const st = api.viewState();
  const providers = new Set((st.models ?? []).map((m) => m.providerName));
  check("Model selector grouped by provider", providers.size >= 1, [...providers].join(" | "));
  check(
    "Budget UI present",
    !!st.budget && !!st.budgetPresets.small,
    `level=${st.budget.level} small=${JSON.stringify(st.budgetPresets.small)}`,
  );
  await api.handle({ type: "selectAgent", id: "plan" });
  await api.handle({ type: "newSession" });
  await checkFullReportCopy(
    api,
    "Run `git --no-optional-locks status` only, then summarize it as a short Markdown report with a level-1 heading, a bullet list and a two-column table. Do not modify anything.",
  );
  await api.handle({ type: "newSession" });
  await checkQuestion(
    api,
    "Use your question tool to ask me whether I want a short or a detailed answer (two options). After I answer, run `git --no-optional-locks status` only and answer accordingly. Do not modify anything.",
    (opts) => opts.find((o) => /short/i.test(o)) ?? opts[0] ?? "Short",
  );
  // Cancellation still works (read-only command).
  await api.handle({ type: "newSession" });
  const wait = waitCommand(30);
  const { since } = await sendShell(
    api,
    `Run the shell command \`${wait.command}\` exactly as written and wait for it to finish. Do not do anything else.`,
    wait.pattern,
  );
  await new Promise((r) => setTimeout(r, 1500));
  await api.handle({ type: "stop" });
  const idle = await waitIdle(api, since, 30_000);
  await new Promise((r) => setTimeout(r, 500));
  check("Stop still cancels", idle.outcome === "interrupted" && !psHas(wait.pattern), idle.outcome);

  // Session titles: broken generated titles are never shown.
  await api.handle({ type: "refreshSessions" });
  await new Promise((r) => setTimeout(r, 1500));
  const titles = api.viewState().sessions.map((x) => x.title);
  check(
    "No broken generated titles in the session list",
    !titles.some((x) => /title only|massive request/i.test(x)),
    titles.slice(0, 6).join(" | "),
  );

  // Read-only proof that holds even while other agents work in this repository:
  // OpenCode's own snapshot diff of every session this run used must be empty.
  const changed: string[] = [];
  for (const id of touchedSessions) {
    await api.handle({ type: "selectSession", id });
    await api.controller()?.refreshChanges();
    const ac = api.viewState().agentChanges;
    if (ac.status !== "none")
      changed.push(
        `${id}:${ac.status}${ac.status === "ok" ? ":" + ac.files.map((f) => f.path).join(",") : ""}`,
      );
  }
  check(
    "This run changed no files (OpenCode snapshot diff of all its sessions)",
    changed.length === 0 && touchedSessions.size > 0,
    `${touchedSessions.size} sessions checked ${changed.join(" ")}`,
  );
}

async function v02Fixture(api: TestApi): Promise<void> {
  const root = api.workspace().active!.path;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();

  // --- full-report copy
  await api.handle({ type: "newSession" });
  await checkFullReportCopy(
    api,
    "Write a short Markdown report about this folder with a level-1 heading, a bullet list, a two-column table and a fenced code block. Do not run any tools.",
  );

  // --- agent-only diff on a repository that is already dirty
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qam", "baseline");
  fs.appendFileSync(path.join(root, "a.txt"), "user line\n");
  fs.writeFileSync(path.join(root, "b.txt"), "user change in another file\n");
  await api.handle({ type: "selectAgent", id: "build" });
  await api.handle({ type: "newSession" });
  let since = events.length;
  await api.handle({
    type: "send",
    text: "Append a new last line containing exactly AGENT LINE to the file a.txt using your edit tool. Do not touch any other file.",
  });
  await waitIdle(api, since);
  await waitFor("agent changes", () => api.viewState().agentChanges.status !== "none", 15_000);
  const ac = api.viewState().agentChanges;
  const files = ac.status === "ok" ? ac.files.map((f) => f.path) : [];
  check(
    "Agent changes list only the agent's file (dirty repo, other file)",
    ac.status === "ok" && files.length === 1 && files[0] === "a.txt",
    JSON.stringify(ac),
  );
  // VS Code's Git extension notices external edits asynchronously (it can take 10 s+ for temp
  // folders). Ask it to refresh, as the Source Control "Refresh" button does, then wait.
  await vscode.commands.executeCommand("git.refresh").then(undefined, () => undefined);
  await waitFor(
    "git refresh",
    () => (api.viewState().workspaceChanges?.count ?? 0) >= 2 || undefined,
    30_000,
  ).catch(() => undefined);
  check(
    "Workspace changes counted separately",
    (api.viewState().workspaceChanges?.count ?? 0) >= 2,
    JSON.stringify(api.viewState().workspaceChanges),
  );
  await api.handle({ type: "openAgentDiff", path: "a.txt" });
  await new Promise((r) => setTimeout(r, 1000));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  const isAgentDiff =
    input instanceof vscode.TabInputTextDiff && input.original.scheme === "opencode-sidecar-agent";
  check("Agent-only diff opens in the native diff editor", isAgentDiff, `${tab?.label}`);
  if (input instanceof vscode.TabInputTextDiff) {
    const before = (await vscode.workspace.openTextDocument(input.original)).getText();
    const afterText = (await vscode.workspace.openTextDocument(input.modified)).getText();
    check(
      "Same-file pre-existing user change is baseline, not attributed to the agent",
      before.includes("user line") &&
        !before.includes("AGENT LINE") &&
        afterText.includes("user line") &&
        afterText.includes("AGENT LINE"),
      JSON.stringify({ before, after: afterText }),
    );
  }
  const sid = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  await waitFor("changes after reopen", () => api.viewState().agentChanges.status === "ok", 15_000);
  const ac2 = api.viewState().agentChanges;
  check(
    "Agent changes survive session restart",
    ac2.status === "ok" && ac2.files.length === 1 && ac2.files[0].path === "a.txt",
    JSON.stringify(ac2),
  );

  // --- steering and queue (OpenCode inbox delivery)
  await api.handle({ type: "newSession" });
  const first = waitCommand(12, "first");
  const sleepPrompt = `Run the shell command \`${first.command}\` exactly as written and wait for it, then reply DONE.`;
  const sent = await sendShell(api, sleepPrompt, first.pattern);
  since = sent.since;
  const mark = sent.mark;
  await api.handle({
    type: "send",
    text: "Steering: after that command, also run `echo steered`.",
    delivery: "steer",
  });
  await api.handle({
    type: "send",
    text: "Queued: then reply with the single word QUEUED.",
    delivery: "queue",
  });
  // Current Task: the running prompt, copied exactly.
  const runningTask = api.controller()?.taskView();
  check(
    "Current Task shows the running prompt",
    runningTask?.label === "current" && runningTask.summary === summarizeTask(sleepPrompt),
    JSON.stringify(runningTask),
  );
  await api.handle({ type: "send", text: "Queued2: reply SECOND.", delivery: "queue" });
  await waitFor("3 pending", () => api.viewState().pending.length === 3 || undefined, 10_000).catch(
    () => undefined,
  );
  const pend = api.viewState().pending;
  check(
    "Steer/queue messages shown as pending with their delivery",
    pend.some((p) => p.delivery === "steer") && pend.filter((p) => p.delivery === "queue").length === 2,
    JSON.stringify(pend.map((p) => [p.delivery, p.text.slice(0, 12)])),
  );
  check(
    "Queued prompt shows as Next with a count",
    api.controller()?.taskView()?.next?.summary === "Queued: then reply with the single word QUEUED." &&
      api.controller()?.taskView()?.next?.more === 1,
    JSON.stringify(api.controller()?.taskView()?.next),
  );
  const second = pend.find((p) => p.text.startsWith("Queued2"));
  if (second) await api.handle({ type: "removePending", id: second.id });
  check(
    "Removing a queued message updates Next",
    api.controller()?.taskView()?.next?.more === 0,
    JSON.stringify(api.controller()?.taskView()?.next),
  );
  await waitFor("steer delivered", () => api.controller()?.taskView()?.steer ?? undefined, 120_000).catch(
    () => undefined,
  );
  check(
    "Steer does not replace Current Task",
    api.controller()?.taskView()?.id === runningTask?.id &&
      /^Steering:/.test(api.controller()?.taskView()?.steer ?? ""),
    JSON.stringify({ id: api.controller()?.taskView()?.id, steer: api.controller()?.taskView()?.steer }),
  );
  check(
    "Removed queued message is cancelled in OpenCode",
    !api.viewState().pending.some((p) => p.text.startsWith("Queued2")),
  );
  await waitFor(
    "queue drained and idle",
    () =>
      api.viewState().pending.length === 0 &&
      !api.viewState().busy &&
      events.slice(since).some((e) => e.type === "session.idle")
        ? true
        : undefined,
    240_000,
  );
  const users = items(api)
    .filter((i): i is Extract<TranscriptItem, { kind: "user" }> => i.kind === "user")
    .map((u) => u.text);
  const outputs = toolsSince(api, mark)
    .map((t) => t.detail.output ?? "")
    .join("\n");
  check(
    "Steering delivered into the running task",
    users.some((u) => u.startsWith("Steering:")) && outputs.includes("steered"),
    outputs.slice(0, 80).replace(/\n/g, " "),
  );
  check(
    "Queued message delivered after the task",
    users.some((u) => u.startsWith("Queued:")) &&
      /QUEUED/.test(
        items(api)
          .filter((i) => i.kind === "assistant")
          .map((i) => (i.kind === "assistant" ? i.text : ""))
          .join(" "),
      ),
  );
  check("Removed message never delivered", !users.some((u) => u.startsWith("Queued2")));
  const doneTask = api.controller()?.taskView();
  check(
    "Delivered queued prompt became the task; finished task shows as Last Task",
    doneTask?.label === "last" &&
      doneTask.summary.startsWith("Queued: then reply") &&
      doneTask.status === "completed",
    JSON.stringify(doneTask),
  );
  const sqSession = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  check("New session shows no task", api.controller()?.taskView() === null);
  await api.handle({ type: "selectSession", id: sqSession! });
  check(
    "Session reopen restores the task from OpenCode messages",
    api.controller()?.taskView()?.id === doneTask?.id && api.controller()?.taskView()?.status === "completed",
    JSON.stringify(api.controller()?.taskView()),
  );

  // --- question form
  await api.handle({ type: "newSession" });
  await checkQuestion(
    api,
    "Use your question tool to ask me which color I prefer, with options red and blue. Then reply with my answer.",
    (opts) => opts.find((o) => /blue/i.test(o)) ?? "Blue",
  );
  check(
    "Answer reached the agent",
    /blue/i.test(lastAssistantText(api)),
    lastAssistantText(api).slice(0, 60),
  );

  // --- budget guard interrupts the real run
  await vscode.workspace
    .getConfiguration("opencodeSidecar")
    .update("budget.small", { maxCost: 0, maxSteps: 5 }, vscode.ConfigurationTarget.Global);
  await api.handle({ type: "selectBudget", level: "small" });
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({
    type: "send",
    text: "Run these shell commands one at a time, each as its own separate tool call and waiting for each before the next: `echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`, `echo 7`, `echo 8`, `echo 9`, `echo 10`. Then reply DONE.",
  });
  const stopCard = await waitFor(
    "budget stop",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "budget" }> => e.type === "budget" && e.state === "stopped"),
    240_000,
  );
  const warned = events.slice(since).some((e) => e.type === "budget" && e.state === "warning");
  const idle = await waitIdle(api, since, 60_000);
  check("Budget warning shown before the limit", warned);
  const budgetTask = api.controller()?.taskView();
  check(
    "Budget stop keeps the task (Stopped — budget reached)",
    budgetTask?.status === "budget-stopped" && budgetTask.summary.startsWith("Run these shell commands"),
    JSON.stringify(budgetTask),
  );
  check(
    "Budget hard limit interrupts the real OpenCode run",
    idle.outcome === "interrupted",
    `${idle.outcome}; task steps=${api.viewState().budget.taskSteps}`,
  );
  since = events.length;
  await api.handle({ type: "budgetAction", itemId: stopCard.id, action: "continue" });
  await waitFor(
    "continuation started",
    () => events.slice(since).some((e) => e.type === "session.busy") || undefined,
    60_000,
  );
  await waitFor(
    "continuation delivered",
    () => api.controller()?.taskView()?.status === "running" || undefined,
    30_000,
  ).catch(() => undefined);
  check(
    "Continue once keeps the same task",
    api.controller()?.taskView()?.id === budgetTask?.id && api.controller()?.taskView()?.status === "running",
    JSON.stringify(api.controller()?.taskView()),
  );
  const carried = api.viewState().budget;
  check(
    "Continue once resumes the same task with one override",
    carried.allowance === 2 && carried.taskSteps >= 5 && api.viewState().budget.level === "small",
    JSON.stringify(carried),
  );
  await waitIdle(api, since, 240_000);
  await api.handle({ type: "selectBudget", level: "off" });

  // --- task completion notification and "Open Chat"
  const shown: string[] = [];
  api.setNotifier(async (_severity, message) => {
    shown.push(message);
    return "Open Chat";
  });
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  // The view's visibility reaches the extension host asynchronously; a busy machine can take longer.
  await waitFor("view hidden", () => !api.viewVisible() || undefined, 10_000).catch(() => undefined);
  const hiddenBefore = !api.viewVisible();
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({ type: "send", text: "Reply with the single word OK." });
  await waitIdle(api, since, 180_000);
  await waitFor("view revealed", () => api.viewVisible() || undefined, 10_000).catch(() => undefined);
  check(
    "Completion notification uses the task summary and Open Chat reveals the view",
    hiddenBefore &&
      shown.length === 1 &&
      shown[0] === "✅ OpenCode task completed: Reply with the single word OK." &&
      api.viewVisible(),
    JSON.stringify({ hiddenBefore, shown, visible: api.viewVisible(), focused: vscode.window.state.focused }),
  );
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sqSession! });
  check("Reopening a session does not replay notifications", shown.length === 1, JSON.stringify(shown));

  // --- model variant
  // The chosen model itself when it has the variant, so a run never goes to a model (maybe a
  // paid one) nobody chose; another model of its provider only without ACCEPT_MODEL.
  const offered = api.viewState().models ?? [];
  const withVariant =
    offered.find((m) => m.key === MODEL && m.variants.includes("none")) ??
    (process.env.ACCEPT_MODEL
      ? undefined
      : offered.find((m) => m.providerID === MODEL.split("/")[0] && m.variants.includes("none")));
  if (withVariant) {
    await api.handle({ type: "selectModel", key: withVariant.key });
    await api.handle({ type: "selectVariant", variant: "none" });
    await api.handle({ type: "newSession" });
    since = events.length;
    await api.handle({ type: "send", text: "Reply with the single word OK." });
    await waitIdle(api, since, 180_000);
    const cur = api.controller()?.current;
    const errorCard = items(api).find((i) => i.kind === "error");
    check(
      "Model variant sent to OpenCode",
      cur?.variant === "none",
      `${withVariant.key} variant=${cur?.variant}; run: ${errorCard?.kind === "error" ? `error → ${errorCard.title}` : lastAssistantText(api).slice(0, 30)}`,
    );
    await api.handle({ type: "selectModel", key: MODEL });
    check(
      "Variant cleared for a model without that variant",
      api.viewState().selectedVariant === null ||
        (api.viewState().models ?? [])
          .find((m) => m.key === MODEL)
          ?.variants.includes(api.viewState().selectedVariant ?? "") === true,
    );
  } else {
    check("Model variant sent to OpenCode", true, "skipped: no model with variant 'none' for this provider");
  }
}

// ======================================================= 0.2.1 Current Task (real repo, read-only)

/** Reads stored messages straight from OpenCode (independent of the extension). */
async function storedMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8"));
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const url = new URL(`/api/session/${sessionId}/message`, svc.url);
    if (cursor) url.searchParams.set("cursor", cursor);
    else url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "100");
    const page = (await (await fetch(url, { headers })).json()) as {
      data: Array<Record<string, unknown>>;
      cursor?: { next?: string | null };
    };
    out.push(...page.data);
    cursor = page.cursor?.next ?? null;
    if (!cursor || page.data.length === 0) break;
  }
  return out;
}

async function realRepoTask(api: TestApi): Promise<void> {
  await common(api);
  // Never let Budget Guard act on someone else's run while browsing existing sessions.
  await api.handle({ type: "selectBudget", level: "off" });
  await api.handle({ type: "selectAgent", id: "plan" });

  // 1. An existing, idle session.
  const active = new Set<string>();
  const svcActive = await (async () => {
    const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8"));
    const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
    return (
      (await (await fetch(new URL("/api/session/active", svc.url), { headers })).json()) as {
        data: Record<string, unknown>;
      }
    ).data;
  })();
  for (const id of Object.keys(svcActive ?? {})) active.add(id);
  await api.handle({ type: "refreshSessions" });
  const candidate = api.viewState().sessions.find((x) => !active.has(x.id));
  check("Found an existing idle session", !!candidate, candidate ? `${candidate.title}` : "none");
  if (candidate) {
    await api.handle({ type: "selectSession", id: candidate.id });
    const st = api.viewState();
    check(
      "Session Title stays visible beside Current Task",
      !!st.currentSession?.title && st.currentSession.title.length > 0,
      st.currentSession?.title,
    );
    const msgs = await storedMessages(candidate.id);
    const users = msgs.filter((m) => m.type === "user");
    const task = api.controller()?.taskView() ?? null;
    const stored = users.find((u) => u.id === task?.id);
    check(
      "Current Task is an actual stored prompt of the session",
      !!task && !!stored && task.summary === summarizeTask(String(stored.text)),
      `${task?.label} · ${task?.status} · “${task?.summary}”`,
    );
  }

  // 2. Steer and queue on a read-only run (plan agent).
  await api.handle({ type: "newSession" });
  check("New session shows no task", api.controller()?.taskView() === null);
  const wait = waitCommand(15);
  const sent = await sendShell(
    api,
    `Run the shell command \`${wait.command}\` exactly as written and wait for it. Then reply DONE. Do not modify anything.`,
    wait.pattern,
  );
  let since = sent.since;
  const taskId = api.controller()?.taskView()?.id;
  await api.handle({
    type: "send",
    text: "Steer: afterwards also run `git --no-optional-locks status`.",
    delivery: "steer",
  });
  await api.handle({
    type: "send",
    text: "Queued: then reply with the single word QUEUED.",
    delivery: "queue",
  });
  await waitFor("next", () => api.controller()?.taskView()?.next ?? undefined, 15_000).catch(() => undefined);
  check(
    "Queued prompt shows as Next",
    api.controller()?.taskView()?.next?.summary === "Queued: then reply with the single word QUEUED.",
    JSON.stringify(api.controller()?.taskView()?.next),
  );
  await waitFor("steer", () => api.controller()?.taskView()?.steer ?? undefined, 120_000).catch(
    () => undefined,
  );
  check(
    "Steer does not replace Current Task",
    api.controller()?.taskView()?.id === taskId && /^Steer:/.test(api.controller()?.taskView()?.steer ?? ""),
    JSON.stringify(api.controller()?.taskView()),
  );
  await waitFor(
    "drained",
    () =>
      (!api.viewState().busy &&
        api.viewState().pending.length === 0 &&
        events.slice(since).some((e) => e.type === "session.idle")) ||
      undefined,
    240_000,
  );

  // 3. Budget stop keeps the task (read-only commands).
  await vscode.workspace
    .getConfiguration("opencodeSidecar")
    .update("budget.small", { maxCost: 0, maxSteps: 3 }, vscode.ConfigurationTarget.Global);
  await api.handle({ type: "selectBudget", level: "small" });
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({
    type: "send",
    text: "Run these shell commands one at a time as separate tool calls: `echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`. Then reply DONE. Do not modify anything.",
  });
  await waitFor(
    "budget stop",
    () => events.slice(since).find((e) => e.type === "budget" && e.state === "stopped"),
    240_000,
  );
  await waitIdle(api, since, 60_000);
  const t = api.controller()?.taskView();
  check(
    "Budget stop does not lose the task",
    t?.status === "budget-stopped" && t.summary.startsWith("Run these shell commands"),
    JSON.stringify(t),
  );
  await api.handle({ type: "selectBudget", level: "off" });

  // Read-only proof via OpenCode snapshots of this run's own sessions.
  const changed: string[] = [];
  for (const id of touchedSessions) {
    if (candidate && id === candidate.id) continue; // pre-existing session, only viewed
    await api.handle({ type: "selectSession", id });
    await api.controller()?.refreshChanges();
    const ac = api.viewState().agentChanges;
    if (ac.status === "ok") changed.push(`${id}:${ac.files.map((f) => f.path).join(",")}`);
  }
  check("This run's sessions made no file changes (snapshot diff)", changed.length === 0, changed.join(" "));
}

/**
 * A shell command that waits `seconds`, then prints `word`, and the pattern that finds it in a
 * tool call and in the process list. On Windows OpenCode runs commands in Windows PowerShell 5.1,
 * which has no `&&` and runs `sleep` inside its own process, so the wait is a Node child process
 * there (Node is on PATH wherever the harness runs), which also proves the whole tree is stopped.
 */
function waitCommand(seconds: number, word?: string): { command: string; pattern: RegExp } {
  if (process.platform !== "win32")
    return {
      command: word ? `sleep ${seconds} && echo ${word}` : `sleep ${seconds}`,
      pattern: new RegExp(`sleep ${seconds}\\b`),
    };
  const ms = seconds * 1000;
  return {
    command: `node -e "setTimeout(()=>console.log('${word ?? "done"}'),${ms})"`,
    pattern: new RegExp(`setTimeout.*\\b${ms}\\b`),
  };
}

/**
 * Sends a prompt asking for a shell command and waits until it runs. The model is the flaky
 * party here: when it finishes without running the command (or runs another), it is asked
 * once more. Returns where the successful attempt's events and transcript items start.
 */
async function sendShell(
  api: TestApi,
  text: string,
  pattern: RegExp,
  also: (t: Extract<TranscriptItem, { kind: "tool" }>) => boolean = () => true,
): Promise<{ since: number; mark: number }> {
  for (let attempt = 1; ; attempt++) {
    const since = events.length;
    const mark = items(api).length;
    await api.handle({ type: "send", text });
    const started = await waitFor(
      "the shell command to start",
      () =>
        toolsSince(api, mark).some(
          (t) =>
            t.category === "shell" &&
            pattern.test(t.detail.command ?? "") &&
            t.status === "running" &&
            also(t),
        ) || (events.slice(since).some((e) => e.type === "session.idle") ? "idle" : undefined),
      180_000,
    );
    if (started === true) return { since, mark };
    const ran = toolsSince(api, mark)
      .map((t) => t.detail.command ?? t.title)
      .join(" | ");
    if (attempt === 2) throw new Error(`The model did not run the command (it ran: ${ran || "nothing"})`);
    console.log(`The model did not run the command (it ran: ${ran || "nothing"}); asking again`);
  }
}

/** Whether any running process's command line matches. */
function psHas(pattern: RegExp): boolean {
  try {
    const lines =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | % CommandLine"],
            { windowsHide: true },
          )
            .toString()
            .split(/\r?\n/)
        : execFileSync("ps", ["-axo", "command"])
            .toString()
            .split("\n")
            .filter((l) => !l.includes("ps -axo"));
    return lines.some((l) => pattern.test(l));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------- worktree header

async function worktree(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand("opencodeSidecar.focusChat");
  await api.ensureStarted();
  await waitFor("workspace", () => api.workspace().active, 10_000);
  const ws = api.workspace();
  check("Secondary worktree detected", ws.repoKind === "worktree", `${ws.repoKind}; main=${ws.mainWorktree}`);
  check("Worktree branch", ws.branch === "feature/wt", String(ws.branch));
}

// ------------------------------------------------------- onboarding (A–G)

const CLI = process.env.ACCEPT_CLI ?? "";
const FREE_URL = process.env.ACCEPT_FREE_URL ?? "";
const BARE_URL = process.env.ACCEPT_BARE_URL ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stage = (api: TestApi) => api.viewState().onboarding.stage;
const settings = () => vscode.workspace.getConfiguration("opencodeSidecar");

async function openChat(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand("opencodeSidecar.focusChat");
  await api.ensureStarted();
}

async function waitStage(api: TestApi, want: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`stage ${want}`, () => stage(api) === want, timeoutMs).catch((e: Error) => {
    const c = api.controller();
    throw new Error(
      `${e.message}; now ${stage(api)} account=${JSON.stringify(c?.account)} models=${c?.models?.length} loading=${c?.catalogLoading} signIn=${api.signInState()}`,
    );
  });
  // The Status Bar follows with the next state push (coalesced, a few milliseconds later).
  await waitFor(
    "the Status Bar",
    () => api.statusBar().text.includes(statusBarText(want as OnboardingStage)),
    2000,
  ).catch(() => undefined);
}

/** Adds a key credential on an ISOLATED test server through OpenCode's own API (never the real service). */
async function connectTestKey(serverUrl: string, integration: string, key: string): Promise<void> {
  if (!serverUrl || serverUrl === "" || !/^http:\/\/127\.0\.0\.1:/.test(serverUrl))
    throw new Error("isolated server only");
  const auth =
    "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD ?? "")).toString("base64");
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  // Right after a sign-in attempt OpenCode can briefly answer IntegrationNotFoundError for an
  // integration it lists (seen on Windows; the same request a moment later succeeds).
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(
      `${serverUrl}/api/integration/${integration}/connect/key?location%5Bdirectory%5D=${encodeURIComponent(dir)}`,
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ key }),
      },
    );
    if (res.ok) return;
    const text = (await res.text()).slice(0, 200);
    if (res.status !== 404 || attempt === 10)
      throw new Error(`connect ${integration}: HTTP ${res.status} ${text}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function terminalNamed(name: string): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name === name);
}

async function onbMissing(api: TestApi): Promise<void> {
  await openChat(api);
  await waitStage(api, "not-installed", 30_000);
  const ob = api.viewState().onboarding;
  check("A. CLI missing → 'OpenCode is required' onboarding", ob.stage === "not-installed");
  check(
    "A. Checklist: OpenCode installed / connected not done",
    ob.checklist.installed === "todo" && ob.checklist.connected === "todo",
    JSON.stringify(ob.checklist),
  );
  await waitFor("status bar", () => api.statusBar().text.includes("Not installed"), 5000).catch(
    () => undefined,
  );
  check(
    "A. Status Bar: OpenCode: Not installed",
    api.statusBar().text.includes("OpenCode: Not installed"),
    api.statusBar().text,
  );
  check("A. Chat disabled until OpenCode is usable", stage(api) !== "ready");
  // The user installs OpenCode (here: points the setting at the real CLI) and its service is reachable:
  // the sidebar re-checks and continues without a window reload.
  await settings().update("executablePath", CLI, vscode.ConfigurationTarget.Global);
  await settings().update("serverUrl", FREE_URL, vscode.ConfigurationTarget.Global);
  await waitStage(api, "ready", 90_000);
  check("A. Check again → ready without reloading the window", stage(api) === "ready");
}

async function onbStopped(api: TestApi): Promise<void> {
  await openChat(api);
  await waitStage(api, "stopped", 30_000);
  const st = api.viewState();
  check("B. Service not running → 'OpenCode is installed' onboarding", st.onboarding.stage === "stopped");
  check(
    "B. Checklist: installed done, connected not done",
    st.onboarding.checklist.installed === "done" && st.onboarding.checklist.connected === "todo",
    JSON.stringify(st.onboarding.checklist),
  );
  await waitFor("status bar", () => api.statusBar().text.includes("Stopped"), 5000).catch(() => undefined);
  check(
    "B. Status Bar: OpenCode: Stopped",
    api.statusBar().text.includes("OpenCode: Stopped"),
    api.statusBar().text,
  );
  await vscode.commands.executeCommand("opencodeSidecar.refreshConnection");
  await waitFor("re-check", () => api.connection().kind !== "connecting", 30_000);
  check("B. Refresh Connection re-checks (still stopped)", stage(api) === "stopped", stage(api));
  // The service becomes reachable (here: the isolated server) → continues automatically.
  await settings().update("serverUrl", FREE_URL, vscode.ConfigurationTarget.Global);
  await waitStage(api, "ready", 90_000);
  check("B. Continues to ready once OpenCode runs", stage(api) === "ready");
}

async function onbSignIn(api: TestApi): Promise<void> {
  await openChat(api);
  await waitStage(api, "sign-in", 60_000);
  let ob = api.viewState().onboarding;
  check("C. No account, no models → Sign in onboarding", ob.stage === "sign-in");
  check(
    "C. Checklist: account + models to do",
    ob.checklist.account === "todo" && ob.checklist.models === "todo" && ob.checklist.connected === "done",
    JSON.stringify(ob.checklist),
  );
  check(
    "C. Header/Status Bar never say Connected while chat is unusable",
    api.statusBar().text.includes("Sign in required") && !api.statusBar().text.includes("Connected"),
    api.statusBar().text,
  );

  // Sign in to OpenCode (same handler as the button): OpenCode's own device login in a terminal.
  await vscode.commands.executeCommand("opencodeSidecar.signIn");
  const term = await waitFor("sign-in terminal", () => terminalNamed("OpenCode Sign In")[0], 10_000);
  const opts = term.creationOptions as vscode.TerminalOptions;
  check(
    "C. Sign in runs `opencode auth login opencode --method device` (OpenCode's flow)",
    opts.shellPath === CLI &&
      JSON.stringify(opts.shellArgs) ===
        JSON.stringify(["auth", "login", "opencode", "--method", "device", "--server", BARE_URL]),
    `${path.basename(String(opts.shellPath))} ${JSON.stringify(opts.shellArgs)}`,
  );
  check("C. Waiting state shown", api.viewState().onboarding.signIn === "waiting");
  await vscode.commands.executeCommand("opencodeSidecar.signIn");
  check("C. A second click reuses the open sign-in terminal", terminalNamed("OpenCode Sign In").length === 1);
  await sleep(5000);
  check("C. OpenCode device login started and is waiting for the browser", term.exitStatus === undefined);

  // Login cancelled: the user closes the sign-in terminal (Terminal: Kill) before anything changed.
  term.show();
  await sleep(300);
  await vscode.commands.executeCommand("workbench.action.terminal.kill");
  await waitFor("cancelled", () => api.signInState() === "cancelled", 15_000).catch((e: Error) => {
    throw new Error(
      `${e.message}; state=${api.signInState()} exit=${JSON.stringify(term.exitStatus)} terminals=${vscode.window.terminals.map((t) => t.name).join("|")} stage=${stage(api)}`,
    );
  });
  check("Error UX: login cancelled is reported", api.viewState().onboarding.signIn === "cancelled");
  check("C. Still asks to sign in after a cancelled login", stage(api) === "sign-in");

  // D. Connect another provider: OpenCode's provider picker in a terminal. OpenCode then records a
  // provider connection (simulated with OpenCode's API on the isolated server) that offers no models.
  await api.handle({ type: "connectProvider" });
  const prov = await waitFor("provider terminal", () => terminalNamed("OpenCode Providers")[0], 10_000);
  const popts = prov.creationOptions as vscode.TerminalOptions;
  check(
    "D. Configure models / Connect provider runs `opencode auth login` (OpenCode's provider picker)",
    JSON.stringify(popts.shellArgs) === JSON.stringify(["auth", "login", "--server", BARE_URL]),
    JSON.stringify(popts.shellArgs),
  );
  await connectTestKey(BARE_URL, "openai", "sk-acceptance-test-key-not-real");
  await waitStage(api, "no-models", 30_000);
  ob = api.viewState().onboarding;
  check(
    "D. Connected provider but no models → 'No models are available yet.' (auto re-check)",
    ob.stage === "no-models",
    JSON.stringify(ob.checklist),
  );
  check(
    "D. Status Bar: OpenCode: No models",
    api.statusBar().text.includes("No models"),
    api.statusBar().text,
  );
  await waitFor("wait ended", () => api.signInState() === "idle", 15_000).catch(() => undefined);
  check("D. The wait ends when OpenCode reports the change", api.signInState() === "idle", api.signInState());
  await vscode.commands.executeCommand("opencodeSidecar.refreshConnection");
  check("D. Refresh keeps the honest state", stage(api) === "no-models");
  prov.dispose();

  // Sign in again; OpenCode records an OpenCode Console credential (the test key is not valid, so
  // OpenCode reports that the sign-in must be renewed).
  await vscode.commands.executeCommand("opencodeSidecar.signIn");
  const term3 = await waitFor(
    "sign-in terminal",
    () => terminalNamed("OpenCode Sign In").find((t) => t !== term && t.exitStatus === undefined),
    10_000,
  );
  await connectTestKey(BARE_URL, "opencode", "acceptance-test-key-not-real");
  await waitStage(api, "sign-in-expired", 30_000);
  check(
    "C. Auto re-check after login, no manual refresh (OpenCode reports the sign-in as expired)",
    stage(api) === "sign-in-expired",
  );
  await waitFor("wait ended", () => api.signInState() === "idle", 15_000).catch(() => undefined);
  check(
    "C. Sign-in wait ends when OpenCode reports the change",
    api.signInState() === "idle",
    api.signInState(),
  );
  term3.dispose();

  // E. A provider with models appears.
  await connectTestKey(BARE_URL, "anthropic", "sk-ant-acceptance-test-key-not-real");
  await waitStage(api, "ready", 30_000);
  const st = api.viewState();
  check(
    "E. Models appear → onboarding hides automatically",
    st.onboarding.stage === "ready",
    `${st.models?.length} models`,
  );
  check("E. Expired OpenCode sign-in still noted (non-blocking)", st.onboarding.hint === "sign-in-expired");
  await waitFor("status bar", () => api.statusBar().text.includes("Connected"), 5000).catch(() => undefined);
  check(
    "E. Status Bar: OpenCode: Connected",
    api.statusBar().text.includes("OpenCode: Connected"),
    api.statusBar().text,
  );
  const leaked = JSON.stringify(st).match(/sk-|acceptance-test-key/);
  check("Privacy: no credential material in the view state", !leaked);
}

async function onbNoFolder(api: TestApi): Promise<void> {
  await openChat(api);
  await waitStage(api, "no-folder", 60_000);
  check("F. No folder → 'Open a project to start coding'", stage(api) === "no-folder");
  check(
    "F. Status Bar is neutral (not Connected)",
    api.statusBar().text.includes("Sidecar"),
    api.statusBar().text,
  );
  await waitFor("the view", () => api.viewVisible(), 10_000).catch(() => undefined);
  check("F. Focus Chat works without a folder", api.viewVisible());
}

async function onbReady(api: TestApi): Promise<void> {
  // Read-only against the user's real OpenCode service.
  await openChat(api);
  await waitStage(api, "ready", 90_000);
  const st = api.viewState();
  check("E. Existing configured user: no onboarding", st.onboarding.stage === "ready");
  check("E. No sign-in note for a signed-in user", st.onboarding.hint === null, String(st.onboarding.hint));
  // The Status Bar follows the next state push.
  await waitFor("status bar", () => api.statusBar().text.includes("Connected"), 5000).catch(() => undefined);
  check(
    "E. Status Bar: OpenCode: Connected",
    api.statusBar().text.includes("OpenCode: Connected"),
    api.statusBar().text,
  );
  // Privacy: connection labels from OpenCode's integration list never reach the view state.
  const svc = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8")) as { url: string; password: string };
  const auth = "Basic " + Buffer.from("opencode:" + svc.password).toString("base64");
  const list = (await (
    await fetch(new URL("/api/integration", svc.url), { headers: { authorization: auth } })
  ).json()) as {
    data: Array<{ name?: string; connections: Array<{ label?: string; id?: string }> }>;
  };
  const conns = list.data.flatMap((i) => i.connections);
  const ids = conns.map((c) => c.id).filter((x): x is string => !!x);
  const labels = conns.map((c) => c.label).filter((x): x is string => !!x);
  const json = JSON.stringify(st);
  check(
    "Privacy: credential ids from OpenCode's integration list are not in the view state",
    ids.every((id) => !json.includes(id)),
    `${ids.length} checked`,
  );
  // Provider display names come from OpenCode (shown in the model picker and the Providers panel
  // by design) and may contain an account label ("Personal / OpenCode"); a key's label is often
  // just the provider's name; the usage menu names the workspace whose limits it shows ("Limits ·
  // Personal"). Outside of those names, labels must not appear.
  const names = new Set(
    [
      ...list.data.map((i) => i.name),
      ...(st.models ?? []).map((m) => m.providerName),
      st.quota?.workspace,
    ].filter((x): x is string => !!x),
  );
  let withoutProviderNames = json;
  // Longer names first: "Personal / DeepSeek" before "DeepSeek".
  for (const n of [...names].sort((a, b) => b.length - a.length))
    withoutProviderNames = withoutProviderNames.split(JSON.stringify(n).slice(1, -1)).join("");
  const own = labels.filter((l) => !names.has(l));
  check(
    "Privacy: account labels are not in the view state (outside OpenCode's provider names)",
    own.every((l) => !withoutProviderNames.includes(l)),
    `${own.length} checked`,
  );
  // Refresh keeps the user's selection.
  const other = st.models?.find((m) => m.key !== st.selectedModel);
  if (other) {
    await api.handle({ type: "selectModel", key: other.key });
    await vscode.commands.executeCommand("opencodeSidecar.refreshConnection");
    check(
      "Refresh Connection keeps the selected model",
      api.viewState().selectedModel === other.key,
      other.key,
    );
  }
}

async function easyOpen(api: TestApi, reload: boolean): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === "opencode-sidecar")!;
  const pj = ext.packageJSON;
  if (!reload) {
    check(
      "G. Activated after startup without opening or focusing the chat",
      !api.viewVisible() && api.connection().kind === "connecting",
    );
    check(
      "G. Status Bar item before connecting: 'Sidecar' → Focus Chat",
      api.statusBar().text.includes("Sidecar") && api.statusBar().command === "opencodeSidecar.focusChat",
      api.statusBar().text,
    );
  }
  check(
    "G. One Activity Bar container titled 'Sidecar for OpenCode' with one view",
    pj.contributes.viewsContainers.activitybar.length === 1 &&
      pj.contributes.viewsContainers.activitybar[0].title === "Sidecar for OpenCode" &&
      pj.contributes.views.opencodeSidecar.length === 1,
  );
  check(
    "G. Keyboard shortcut contributes the same command (Cmd+Alt+O on macOS)",
    // The review's Alt+] and Alt+[ are the only other shortcuts.
    JSON.stringify(
      (pj.contributes.keybindings as Array<{ command: string }>).filter(
        (k) => k.command === "opencodeSidecar.focusChat",
      ),
    ) === JSON.stringify([{ command: "opencodeSidecar.focusChat", key: "cmd+alt+o", when: "isMac" }]),
  );
  // Status Bar click = the canonical command.
  await vscode.commands.executeCommand(String(api.statusBar().command));
  await api.ensureStarted();
  await waitFor("view visible", () => api.viewVisible(), 15_000);
  await waitFor("webview ready", () => !api.focusPending(), 15_000);
  check("G. Status Bar opens the chat and focuses the input", api.viewVisible() && !api.focusPending());
  await waitStage(api, "ready", 90_000);
  check(
    "G. Status Bar shows OpenCode: Connected",
    api.statusBar().text.includes("OpenCode: Connected"),
    api.statusBar().text,
  );

  if (!reload) {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await waitFor("hidden", () => !api.viewVisible(), 10_000);
    await vscode.commands.executeCommand("opencodeSidecar.focusChat");
    await waitFor("visible", () => api.viewVisible(), 10_000);
    check("G. Focus Chat reveals the closed Primary Side Bar view", api.viewVisible());
    // The user moves the chat to the Secondary Side Bar.
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: ["opencodeSidecar.chat"],
      destinationId: "workbench.panel.chat",
    });
    await sleep(1000);
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await waitFor("hidden", () => !api.viewVisible(), 10_000);
    await vscode.commands.executeCommand("opencodeSidecar.focusChat");
    await waitFor("visible", () => api.viewVisible(), 10_000);
    check("G. Focus Chat reveals the view in the Secondary Side Bar", api.viewVisible());

    // During a running task: Focus Chat does not disturb it; a notification's Open Chat reveals it.
    const model =
      api.viewState().models?.find((m) => /ling.*free/.test(m.key)) ??
      api.viewState().models?.find((m) => /free/.test(m.key));
    if (model) await api.handle({ type: "selectModel", key: model.key });
    const notices: string[] = [];
    api.setNotifier(async (_sev, message) => {
      notices.push(message);
      return "Open Chat";
    });
    await api.handle({ type: "newSession" });
    const since = events.length;
    await api.handle({ type: "send", text: "Reply with the single word OK." });
    await waitFor(
      "busy",
      () => api.viewState().busy || events.slice(since).some((e) => e.type === "session.idle"),
      30_000,
    );
    const sid = api.controller()?.current?.id;
    const wasBusy = api.viewState().busy;
    await vscode.commands.executeCommand("opencodeSidecar.focusChat");
    check(
      "G. Focus Chat during a running task keeps the task and session",
      api.controller()?.current?.id === sid &&
        (!wasBusy || api.viewState().busy || events.slice(since).some((e) => e.type === "session.idle")),
      `${model?.key}; busy=${wasBusy}`,
    );
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await waitFor("hidden", () => !api.viewVisible(), 10_000);
    await waitFor("idle", () => events.slice(since).some((e) => e.type === "session.idle"), 180_000);
    await waitFor("notification", () => notices.length > 0, 15_000);
    await waitFor("visible after Open Chat", () => api.viewVisible(), 10_000);
    check("G. Notification 'Open Chat' uses Focus Chat and reveals the view", api.viewVisible(), notices[0]);
    // Leave the chat in the Secondary Side Bar for the reload run.
  } else {
    check("G. After reload: Focus Chat still reveals the moved view", api.viewVisible());
    await vscode.commands.executeCommand("opencodeSidecar.focusChat");
    await vscode.commands.executeCommand("opencodeSidecar.focusChat");
    check(
      "G. Repeated Focus Chat keeps one chat view",
      api.viewVisible() && pj.contributes.views.opencodeSidecar.length === 1,
    );
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === "opencode-sidecar");
  if (!ext) throw new Error("extension not found");
  const exports = (await ext.activate()) as { testApi: TestApi };
  const api = exports.testApi;
  const tap = api.tap((evs) => {
    events.push(...evs);
    const id = api.controller()?.current?.id;
    if (id) touchedSessions.add(id);
  });
  const scenario = process.env.ACCEPT_SCENARIO;
  try {
    if (scenario === "real-repo") await realRepo(api);
    else if (scenario === "real-repo-task") await realRepoTask(api);
    else if (scenario === "fixture") await fixture(api);
    else if (scenario === "worktree") await worktree(api);
    else if (scenario === "review") await common(api).then(() => agentReview(api, "between-turns"));
    else if (scenario === "onb-a-missing") await onbMissing(api);
    else if (scenario === "onb-b-stopped") await onbStopped(api);
    else if (scenario === "onb-c-signin") await onbSignIn(api);
    else if (scenario === "onb-f-nofolder") await onbNoFolder(api);
    else if (scenario === "onb-e-ready") await onbReady(api);
    else if (scenario === "easy-open") await easyOpen(api, false);
    else if (scenario === "easy-open-reload") await easyOpen(api, true);
    else throw new Error(`unknown scenario ${scenario}`);
  } catch (e) {
    check("Scenario completed", false, e instanceof Error ? e.message : String(e));
  } finally {
    tap.dispose();
    const report = process.env.ACCEPT_REPORT;
    if (report)
      fs.writeFileSync(
        report,
        JSON.stringify(
          { scenario, results, sessionId: exports.testApi.controller()?.current?.id ?? null },
          null,
          2,
        ),
      );
  }
  if (results.some((r) => !r.ok))
    throw new Error(`${results.filter((r) => !r.ok).length} acceptance check(s) failed`);
}
