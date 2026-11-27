// VS Code side of the Project instructions panel: which instruction files OpenCode reads
// for the folder (src/core/instructions.ts works them out), opening and creating them, and
// "Remember this", which adds one line to the project's AGENTS.md after showing the change
// as a diff and asking. A file outside the folder is only created after a modal question,
// and so is an AGENTS.md beside a CLAUDE.md, which OpenCode then stops reading (it can be
// copied in first).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { globalConfigDir, isInside } from "../core/agents";
import { appendBullet, instructionView, rememberLine, startAgentsFile } from "../core/instructions";
import type { SessionController } from "../core/sessionController";
import type { InstructionsView } from "../shared/model";
import type { HostMessage } from "../shared/protocol";
import type { Logger } from "./log";
import type { ToolTextProvider } from "./toolText";

/** What a new global AGENTS.md starts with. */
const GLOBAL_TEMPLATE = [
  "# Instructions for every project",
  "",
  "OpenCode reads this file in every session, before a project's own AGENTS.md.",
  "",
].join("\n");

/** The choices for a new AGENTS.md beside a CLAUDE.md. */
const COPY = "Create AGENTS.md and copy CLAUDE.md into it";
const CREATE = "Create AGENTS.md";

const isFile = (f: string) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

export class InstructionsHost {
  private view: InstructionsView | null = null;

  constructor(
    private readonly deps: {
      controller: () => SessionController | undefined;
      folder: () => string | null;
      post: (m: HostMessage) => void;
      log: Logger;
      /** Holds the two sides of the preview diff (none in tests: no preview). */
      toolText?: ToolTextProvider;
    },
  ) {}

  /** Replaceable for tests: a modal question; resolves to the label picked (undefined: Cancel). */
  confirm: (message: string, detail: string, ...actions: string[]) => Thenable<string | undefined> = (
    message,
    detail,
    ...actions
  ) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions);

  /** Replaceable for tests: the line to remember, edited by the user (undefined: cancelled). */
  ask: (title: string, value: string) => Thenable<string | undefined> = (title, value) =>
    vscode.window.showInputBox({
      title,
      value,
      prompt: "One line OpenCode reads at the start of every session in this project",
      ignoreFocusOut: true,
      validateInput: (v) => (rememberLine(v) ? null : "Type what OpenCode should remember."),
    });

  private async load(): Promise<InstructionsView> {
    const c = this.deps.controller();
    const folder = this.deps.folder();
    if (!c || !folder) throw new Error("Open a folder first.");
    const [sources, projectDir] = await Promise.all([c.configSources(), c.projectDirectory()]);
    const home = os.homedir();
    const view = instructionView({
      folder,
      projectDir,
      home,
      configDir: globalConfigDir(sources, folder) ?? path.join(home, ".config", "opencode"),
      instructions: sources.instructions ?? [],
      isFile,
    });
    view.canInit = c.commands.some((x) => x.name === "init");
    this.view = view;
    return view;
  }

  async postView(): Promise<void> {
    try {
      this.deps.post({ type: "instructions", view: await this.load() });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`Listing instruction files failed: ${why}`);
      this.deps.post({
        type: "instructions",
        view: null,
        error: this.deps.folder() ? "OpenCode could not say which files it reads." : why,
      });
    }
  }

  /**
   * Before a new AGENTS.md is written beside a CLAUDE.md OpenCode reads: says that OpenCode
   * then stops reading it, and offers to copy it in. Resolves to CLAUDE.md's text to start
   * from (null: the template), or undefined when cancelled.
   */
  private async fromClaude(view: InstructionsView): Promise<string | null | undefined> {
    if (view.projectExists || !view.claudeFile) return null;
    const pick = await this.confirm(
      "Create AGENTS.md?",
      `OpenCode reads a folder's AGENTS.md, or its CLAUDE.md only when there is no AGENTS.md. Once ${view.projectLabel} exists, OpenCode stops reading ${view.claudeFile}. Copy CLAUDE.md into it to keep those instructions.`,
      COPY,
      CREATE,
    );
    if (pick === CREATE) return null;
    if (pick !== COPY) return undefined;
    try {
      return await fs.promises.readFile(view.claudeFile, "utf8");
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Could not read CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  }

  /** Opens one of the listed files (nothing else: the path comes from the webview). */
  async open(file: string): Promise<void> {
    const view = this.view ?? (await this.load().catch(() => null));
    const known = view?.rows.some((r) => r.path === file && (r.state === "loaded" || r.state === "shadowed"));
    if (!known || !isFile(file)) return;
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  /** Creates the project's AGENTS.md, or after asking the global one, and opens it. */
  async create(scope: "project" | "global"): Promise<void> {
    let view: InstructionsView;
    try {
      view = await this.load();
    } catch (e) {
      void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const file = scope === "project" ? view.projectFile : view.globalFile;
    if (!isFile(file)) {
      const folder = this.deps.folder() ?? "";
      let claude: string | null = null;
      if (scope === "global") {
        const pick = await this.confirm(
          "Create a global AGENTS.md?",
          `OpenCode reads ${file} in every session of every project.`,
          "Create",
        );
        if (pick !== "Create") return;
      } else if (view.claudeFile) {
        const from = await this.fromClaude(view);
        if (from === undefined) return;
        claude = from;
      } else if (!isInside(file, folder)) {
        const pick = await this.confirm(
          "Create AGENTS.md at the project root?",
          `OpenCode's project for this folder is ${path.dirname(file)}, so its AGENTS.md goes there.`,
          "Create",
        );
        if (pick !== "Create") return;
      }
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        // "wx": never replaces a file that appeared meanwhile.
        await fs.promises.writeFile(file, scope === "project" ? startAgentsFile(claude) : GLOBAL_TEMPLATE, {
          flag: "wx",
        });
        this.deps.log.info(`Created ${file}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          void vscode.window.showWarningMessage(
            `Could not create ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
      }
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    await this.postView();
  }

  /**
   * "Remember this": the user edits the line, sees the change to the project's AGENTS.md as
   * a diff, and confirms; then the line is added at the end. A new AGENTS.md beside a
   * CLAUDE.md is asked about first (and can start as a copy of it). Returns whether it was.
   */
  async remember(text: string): Promise<boolean> {
    let view: InstructionsView;
    try {
      view = await this.load();
    } catch (e) {
      void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
    const file = view.projectFile;
    const claude = await this.fromClaude(view);
    if (claude === undefined) return false;
    const typed = await this.ask(`Remember in ${view.projectLabel}`, rememberLine(text).slice(0, 500));
    const line = typed === undefined ? "" : rememberLine(typed);
    if (!line) return false;
    const read = () => fs.promises.readFile(file, "utf8").catch(() => null);
    const before = await read();
    const after = appendBullet(before ?? startAgentsFile(claude), line);
    const name = path.basename(file);
    const docs = this.deps.toolText;
    if (docs)
      await vscode.commands.executeCommand(
        "vscode.diff",
        docs.uri(`${name} now`, before ?? ""),
        docs.uri(`${name} with the new line`, after),
        `${view.projectLabel}: Remember this (preview)`,
        { preview: true },
      );
    const created = claude === null ? "with a short template" : "from a copy of CLAUDE.md";
    const pick = await this.confirm(
      `Add this line to ${view.projectLabel}?`,
      `- ${line}${before === null ? `\n\n${name} does not exist yet; it is created ${created}.` : ""}`,
      "Add",
    );
    if (pick !== "Add") return false;
    try {
      // The file may have changed while the preview was open: add to what is there now.
      const now = await read();
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, now === before ? after : appendBullet(now, line));
      this.deps.log.info(`Added a line to ${file}`);
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Could not write ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    void vscode.window.showInformationMessage(`Added to ${view.projectLabel}.`, "Open").then((o) => {
      if (o === "Open") void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    });
    await this.postView();
    return true;
  }
}
