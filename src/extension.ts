import * as vscode from "vscode";
import { ChatViewProvider, FOCUS_COMMAND, VIEW_ID } from "./host/chatView";
import { AGENT_SCHEME, AgentDocumentProvider, EMPTY_SCHEME, EmptyDocumentProvider } from "./host/diff";
import { Logger } from "./host/log";
import { FIX_COMMAND, FixWithOpenCodeActions } from "./host/problems";
import { TOOL_TEXT_SCHEME, ToolTextProvider } from "./host/toolText";

let shutdown: (() => Promise<void>) | undefined;

/**
 * Activation is cheap: it registers the view, commands, a Status Bar item and an output
 * channel. Nothing connects to OpenCode until the sidebar is shown, and nothing takes focus.
 */
export function activate(context: vscode.ExtensionContext) {
  const log = new Logger();
  const toolText = new ToolTextProvider();
  const provider = new ChatViewProvider(context, log, toolText);
  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, new EmptyDocumentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(TOOL_TEXT_SCHEME, toolText),
    vscode.workspace.registerTextDocumentContentProvider(
      AGENT_SCHEME,
      new AgentDocumentProvider(() => provider),
    ),
    vscode.commands.registerCommand(FOCUS_COMMAND, () => provider.focus()),
    vscode.commands.registerCommand("opencodeSidecar.refreshConnection", () => provider.refreshConnection()),
    vscode.commands.registerCommand("opencodeSidecar.signIn", () => provider.signIn("account")),
    vscode.commands.registerCommand("opencodeSidecar.manageProviders", () => provider.showProviders()),
    vscode.commands.registerCommand("opencodeSidecar.checkSetup", () => provider.checkSetup()),
    vscode.commands.registerCommand("opencodeSidecar.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("opencodeSidecar.addCurrentFile", () => provider.addCurrentFile()),
    vscode.commands.registerCommand("opencodeSidecar.addSelection", () => provider.addSelection()),
    vscode.commands.registerCommand("opencodeSidecar.stop", () => provider.stop()),
    vscode.commands.registerCommand("opencodeSidecar.showHistory", () => provider.showHistory()),
    vscode.commands.registerCommand("opencodeSidecar.exportSession", () => provider.exportSession()),
    // "Fix with OpenCode" in the light bulb for errors and warnings, in every language.
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: "file" }, { scheme: "untitled" }],
      new FixWithOpenCodeActions(),
      { providedCodeActionKinds: FixWithOpenCodeActions.kinds },
    ),
    vscode.commands.registerCommand(FIX_COMMAND, (uri?: vscode.Uri, range?: vscode.Range) =>
      provider.fixWithOpenCode(uri, range),
    ),
    vscode.commands.registerCommand("opencodeSidecar.fixFileProblems", () => provider.fixFileProblems()),
    vscode.commands.registerCommand("opencodeSidecar.fixWorkspaceProblems", () =>
      provider.fixWorkspaceProblems(),
    ),
    vscode.commands.registerCommand("opencodeSidecar.writeCommitMessage", (arg?: unknown) =>
      provider.writeCommitMessage(arg),
    ),
  );
  shutdown = () => provider.shutdown();
  log.info("Sidecar activated");
  // Exported for the local acceptance harness; not a public API.
  return { testApi: provider.testApi };
}

export function deactivate(): Promise<void> | undefined {
  // Disposables registered on the context are cleaned up by VS Code. The shared
  // OpenCode background service is intentionally left running: it is owned by
  // OpenCode and may be serving other clients (TUI, other windows). An open side
  // question's session is deleted (or, if VS Code does not wait, at the next start).
  return shutdown?.();
}
