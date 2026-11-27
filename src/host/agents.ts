// VS Code side of the Agents panel: reads and writes OpenCode's agent files, asks before
// it replaces a file or writes outside the folder, opens files in the editor, and imports
// Roo Code / Kilo Code modes. OpenCode notices a changed file itself; the controller waits
// for its agent list to show the change (and has OpenCode reload its config when it does
// not), so a new agent can be picked without restarting anything.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  newAgentFile,
  newAgentFileWithRules,
  toAgentName,
  updateAgentFile,
  validateAgentName,
} from "../core/agentFile";
import {
  agentFilePath,
  deriveAgentRows,
  globalConfigDir,
  globalStorageDirs,
  isInside,
  modeFileCandidates,
  modeRuleFiles,
  projectConfigDir,
  scanAgentFiles,
  type AgentDetail,
  type AgentFileRef,
  type ConfigSources,
  type ModeFileRef,
} from "../core/agents";
import {
  importComments,
  modesFileError,
  modeToAgent,
  parseModesFile,
  type ImportedAgent,
  type RooMode,
} from "../core/roomodes";
import type { SessionController } from "../core/sessionController";
import type { AgentDraft, AgentsView, ImportItem } from "../shared/model";
import type { HostMessage } from "../shared/protocol";
import type { Logger } from "./log";

interface Found {
  file: ModeFileRef;
  modes: RooMode[];
}

interface Pending {
  item: ImportItem;
  agent: ImportedAgent;
  mode: RooMode;
  file: ModeFileRef;
}

/** Text compared without its line breaks and runs of spaces. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export class AgentsHost {
  private files = new Map<string, AgentFileRef>();
  private sources: ConfigSources = { directories: [], documentAgents: {} };
  private details: AgentDetail[] = [];
  private busy: string | null = null;
  private pending = new Map<string, Pending>();
  /** Mode files that could not be read, for the preview. */
  private lastErrors: string[] = [];

  constructor(
    private readonly deps: {
      controller: () => SessionController | undefined;
      folder: () => string | null;
      post: (m: HostMessage) => void;
      log: Logger;
      /** Sidecar's own globalStorage folder; its parent holds Roo Code's and Kilo Code's. */
      storage: string | null;
    },
  ) {}

  /** Replaceable for tests: a modal question; resolves to the label picked. */
  confirm: (message: string, detail: string, action: string) => Thenable<string | undefined> = (
    message,
    detail,
    action,
  ) => vscode.window.showWarningMessage(message, { modal: true, detail }, action);

  private globalDir(folder: string): string | null {
    return globalConfigDir(this.sources, folder);
  }

  /** Reads OpenCode's agents, the files that define them and the mode files to import. */
  private async load(): Promise<AgentsView> {
    const c = this.deps.controller();
    const folder = this.deps.folder();
    if (!c || !folder) throw new Error("Open a folder first.");
    const [details, sources] = await Promise.all([c.agentDetails(), c.configSources()]);
    this.details = details;
    this.sources = sources;
    const project = projectConfigDir(folder);
    const dirs = sources.directories.some((d) => isInside(d, project) && isInside(project, d))
      ? sources.directories
      : [...sources.directories, project];
    this.files = await scanAgentFiles(dirs, folder);
    const found = await this.findModes(folder).catch(() => [] as Found[]);
    const count = found.reduce((n, f) => n + f.modes.length, 0);
    return {
      agents: deriveAgentRows({ details, files: this.files, documentAgents: sources.documentAgents, folder }),
      importable: count ? { count, sources: [...new Set(found.map((f) => f.file.label))] } : null,
      projectDir: ".opencode/agents",
      globalDir: this.globalDir(folder) ? path.join(this.globalDir(folder)!, "agents") : null,
      busy: this.busy,
    };
  }

  async postView(): Promise<void> {
    try {
      this.deps.post({ type: "agents", view: await this.load() });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`Listing agents failed: ${why}`);
      this.deps.post({
        type: "agents",
        view: null,
        error: this.deps.folder() ? "OpenCode could not list them." : why,
      });
    }
  }

  private setBusy(text: string | null): void {
    this.busy = text;
    void this.postView();
  }

  private fail(error: string): void {
    this.deps.post({ type: "agentResult", ok: false, error });
  }

  /** Asks before writing outside the folder; true to go on. */
  private async allowOutside(file: string, folder: string, verb: string): Promise<boolean> {
    if (isInside(file, folder)) return true;
    const pick = await this.confirm(
      `${verb} a file outside this folder?`,
      `${file}\n\nThis is OpenCode's global config, used by every folder.`,
      verb,
    );
    return pick === verb;
  }

  /**
   * Saves the agent form: a new file, or the changes to an existing one (only the fields
   * that changed are rewritten). Then waits for OpenCode to list it and, for a new agent
   * that can drive a session, selects it.
   */
  async save(draft: AgentDraft, editing: string | null, open = false): Promise<void> {
    const c = this.deps.controller();
    const folder = this.deps.folder();
    if (!c || !folder) return this.fail("Open a folder first.");
    if (this.busy) return this.fail("Another change is still being saved.");
    await this.load().catch(() => undefined);
    let file: string;
    let text: string;
    const id = editing ?? draft.name;
    if (editing) {
      const ref = this.files.get(editing);
      if (!ref) return this.fail("Its file is gone. Reload the list.");
      file = ref.path;
      let before: string;
      try {
        before = await fs.promises.readFile(file, "utf8");
        text = updateAgentFile(before, { ...draft, name: editing });
      } catch (e) {
        return this.fail(`Sidecar could not read the file: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (text === before) {
        this.deps.post({ type: "agentResult", ok: true, id });
        if (open) await this.openPath(file);
        return;
      }
      if (!(await this.allowOutside(file, folder, "Save"))) return this.fail("Not saved.");
    } else {
      // A file OpenCode did not load can be replaced (after asking); any other agent's name is taken.
      const broken = (id: string) => this.files.has(id) && !this.details.some((a) => a.id === id);
      const taken = [...new Set([...this.details.map((a) => a.id), ...this.files.keys()])].filter(
        (t) => !(t === draft.name && broken(t)),
      );
      const problem = validateAgentName(draft.name, taken);
      if (problem) return this.fail(problem);
      const dir = draft.scope === "global" ? this.globalDir(folder) : projectConfigDir(folder);
      if (!dir) return this.fail("OpenCode did not report its global config folder.");
      file = agentFilePath(dir, draft.name);
      text = newAgentFile(draft);
      if (!(await this.allowOutside(file, folder, "Save"))) return this.fail("Not saved.");
      if (fs.existsSync(file)) {
        const pick = await this.confirm(
          `Replace ${path.basename(file)}?`,
          `${file} exists. Its content is replaced.`,
          "Replace",
        );
        if (pick !== "Replace") return this.fail("Not saved: the file exists.");
      }
    }
    this.setBusy("Saving…");
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, text, "utf8");
      this.deps.log.info(`Saved agent ${id} to ${file}`);
      const prompt = draft.prompt.replace(/\r\n/g, "\n").trim();
      const loaded = await c.awaitAgents((list) =>
        list.some(
          (a) =>
            a.id === id &&
            a.mode === draft.mode &&
            a.description === draft.description.trim() &&
            oneLine(a.system) === oneLine(prompt),
        ),
      );
      if (loaded && !editing && draft.mode !== "subagent") await c.selectAgent(id);
      this.deps.post({ type: "agentResult", ok: true, id });
      if (!loaded) void this.notLoaded(id, file);
      if (open) await this.openPath(file);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`Saving agent ${id} failed: ${why}`);
      this.fail(`Could not save it: ${why}`);
    } finally {
      this.busy = null;
    }
    await this.postView();
  }

  private async notLoaded(id: string, file: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `Saved, but OpenCode has not loaded ${id}. Check the file's frontmatter.`,
      "Open File",
    );
    if (pick === "Open File") await this.openPath(file);
  }

  /** Deletes a custom agent's file (the webview has asked first). */
  async remove(id: string): Promise<void> {
    const c = this.deps.controller();
    const folder = this.deps.folder();
    if (!c || !folder) return this.fail("Open a folder first.");
    if (this.busy) return this.fail("Another change is still being saved.");
    await this.load().catch(() => undefined);
    const ref = this.files.get(id);
    if (!ref) return this.fail("Its file is gone. Reload the list.");
    if (!(await this.allowOutside(ref.path, folder, "Delete"))) return;
    this.setBusy("Deleting…");
    try {
      await fs.promises.rm(ref.path);
      this.deps.log.info(`Deleted agent ${id} (${ref.path})`);
      // A global agent of the same name takes over from a deleted project one.
      const shadowed = (await scanAgentFiles(this.sources.directories, folder)).has(id);
      await c.awaitAgents((list) => shadowed || !list.some((a) => a.id === id));
      this.deps.post({ type: "agentResult", ok: true, id });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`Deleting agent ${id} failed: ${why}`);
      this.fail(`Could not delete it: ${why}`);
    } finally {
      this.busy = null;
    }
    await this.postView();
  }

  async openFile(id: string): Promise<void> {
    const ref = this.files.get(id);
    const doc = this.sources.documentAgents[id];
    const file = ref?.path ?? (doc && path.isAbsolute(doc) ? doc : null);
    if (file) await this.openPath(file);
  }

  private async openPath(file: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  // ----------------------------------------------------------- import

  private async findModes(folder: string): Promise<Found[]> {
    const dirs = globalStorageDirs(this.deps.storage ? path.dirname(this.deps.storage) : null, {
      platform: process.platform,
      home: os.homedir(),
      appData: process.env.APPDATA,
      xdgConfig: process.env.XDG_CONFIG_HOME,
    });
    const out: Found[] = [];
    for (const file of modeFileCandidates(folder, dirs)) {
      const text = await fs.promises.readFile(file.path, "utf8").catch(() => null);
      if (text === null) continue;
      try {
        const modes = parseModesFile(text);
        if (modes.length) out.push({ file, modes });
      } catch (e) {
        this.deps.log.warn(`Reading ${file.path} failed: ${modesFileError(e)}`);
        if (!out.some((f) => f.file.path === file.path)) out.push({ file, modes: [] });
        this.lastErrors.push(`${file.label}: ${modesFileError(e)}`);
      }
    }
    return out;
  }

  /** The last import preview's modes (for the acceptance harness). */
  previewItems(): ImportItem[] {
    return [...this.pending.values()].map((p) => p.item);
  }

  /** Finds the modes to import and sends the preview: each mode as its agent, with conflicts and notes. */
  async preview(): Promise<void> {
    const folder = this.deps.folder();
    const c = this.deps.controller();
    if (!folder || !c) return;
    await this.load().catch(() => undefined);
    this.lastErrors = [];
    const found = await this.findModes(folder);
    this.pending.clear();
    const all = found.flatMap((f) => f.modes.map((mode) => ({ mode, file: f.file })));
    if (!all.length) {
      this.deps.post({
        type: "agentImport",
        preview: null,
        error: this.lastErrors.length
          ? this.lastErrors.join("\n")
          : "No Roo Code or Kilo Code modes found: no .roomodes or .kilocodemodes in this folder, and no global custom modes.",
      });
      return;
    }
    const models = c.models ?? [];
    const names = new Map<string, string>();
    for (const { mode, file } of all) {
      const rules = await modeRuleFiles(folder, mode.slug, file.kind).catch(() => []);
      const others = [...new Set(all.filter((x) => x.mode !== mode).map((x) => toAgentName(x.mode.slug)))];
      const agent = modeToAgent(mode, { models, rules, others });
      const ref = this.files.get(agent.name);
      const builtIn = this.details.find((a) => a.id === agent.name && !this.files.has(a.id));
      const conflict = names.has(agent.name)
        ? `Same name as the mode from ${names.get(agent.name)}`
        : ref
          ? `Replaces ${ref.scope === "project" ? path.relative(folder, ref.path).replace(/\\/g, "/") : ref.path}`
          : builtIn
            ? `Overrides OpenCode's built-in ${builtIn.name} agent`
            : this.sources.documentAgents[agent.name]
              ? `Same name as an agent in ${path.basename(this.sources.documentAgents[agent.name])}`
              : null;
      if (!names.has(agent.name)) names.set(agent.name, file.label);
      const key = `${file.path}#${mode.slug}`;
      const notes = [...agent.notes];
      if (rules.length) notes.unshift(`Adds ${rules.map((r) => r.source).join(", ")} to the prompt.`);
      const item: ImportItem = {
        key,
        name: agent.name,
        label: mode.name,
        description: agent.draft.description,
        mode: agent.draft.mode,
        source: file.label,
        conflict,
        notes,
        checked: !conflict,
      };
      this.pending.set(key, { item, agent, mode, file });
    }
    this.deps.post({
      type: "agentImport",
      preview: { items: [...this.pending.values()].map((p) => p.item) },
    });
  }

  /** Writes the checked modes of the last preview as agent files, then waits for OpenCode to list them. */
  async importModes(keys: string[], scope: AgentDraft["scope"]): Promise<void> {
    const c = this.deps.controller();
    const folder = this.deps.folder();
    if (!c || !folder) return this.fail("Open a folder first.");
    if (this.busy) return this.fail("Another change is still being saved.");
    const picked = keys.map((k) => this.pending.get(k)).filter((p): p is Pending => !!p);
    if (!picked.length) return this.fail("Pick at least one mode.");
    const names = picked.map((p) => p.agent.name);
    if (new Set(names).size !== names.length) return this.fail("Two of the picked modes have the same name.");
    const dir = scope === "global" ? this.globalDir(folder) : projectConfigDir(folder);
    if (!dir) return this.fail("OpenCode did not report its global config folder.");
    if (!(await this.allowOutside(path.join(dir, "agents"), folder, "Import")))
      return this.fail("Not imported.");
    const targets = picked.map((p) => ({ p, file: agentFilePath(dir, p.agent.name) }));
    const existing = targets.filter((t) => fs.existsSync(t.file));
    if (existing.length) {
      const pick = await this.confirm(
        existing.length === 1
          ? `Replace ${path.basename(existing[0].file)}?`
          : `Replace ${existing.length} agent files?`,
        existing.map((t) => t.file).join("\n"),
        "Replace",
      );
      if (pick !== "Replace") return this.fail("Not imported: some agent files exist.");
    }
    this.setBusy(`Importing ${picked.length} mode${picked.length === 1 ? "" : "s"}…`);
    const written: Pending[] = [];
    try {
      await fs.promises.mkdir(path.join(dir, "agents"), { recursive: true });
      for (const { p, file } of targets) {
        const text = newAgentFileWithRules(
          { ...p.agent.draft, scope },
          p.agent.rules,
          importComments(p.mode, p.file.label, p.agent.notes),
        );
        await fs.promises.writeFile(file, text, "utf8");
        written.push(p);
      }
      this.deps.log.info(`Imported ${written.length} modes into ${path.join(dir, "agents")}`);
      const loaded = await c.awaitAgents((list) => names.every((n) => list.some((a) => a.id === n)));
      this.deps.post({ type: "agentResult", ok: true });
      void this.summary(written, loaded);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`Importing modes failed: ${why}`);
      this.fail(`Could not import them: ${why}${written.length ? ` (${written.length} written)` : ""}`);
    } finally {
      this.busy = null;
    }
    await this.postView();
  }

  private async summary(written: Pending[], loaded: boolean): Promise<void> {
    const n = written.length;
    const pick = await vscode.window.showInformationMessage(
      loaded
        ? `Imported ${n} mode${n === 1 ? "" : "s"} as OpenCode agents.`
        : `Imported ${n} mode${n === 1 ? "" : "s"}, but OpenCode has not listed every one yet.`,
      "Show Summary",
    );
    if (pick !== "Show Summary") return;
    const lines = ["# Imported modes", ""];
    for (const p of written) {
      lines.push(`## ${p.agent.name} (${p.mode.name}, from ${p.file.label})`, "");
      lines.push(
        `- Mode: ${p.agent.draft.mode}${p.agent.orchestrator ? " (orchestrator: may start subagents)" : ""}`,
      );
      lines.push(`- Model: ${p.agent.draft.model ?? "the session's model"}`);
      for (const note of p.item.notes) lines.push(`- ${note}`);
      lines.push("");
    }
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: lines.join("\n") });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
