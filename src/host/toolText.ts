// Read-only editor tabs for a tool call's full command, output or subagent prompt
// ("Shell output (npm test)"), opened from the chat's IN/OUT boxes.

import * as vscode from "vscode";

export const TOOL_TEXT_SCHEME = "opencode-sidecar-tool";
const MAX_DOCS = 50;

export class ToolTextProvider implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private seq = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(new URLSearchParams(uri.query).get("id") ?? "") ?? "";
  }

  /** Opens `text` in a read-only tab titled `title`; keeps the latest 50 documents. */
  async open(title: string, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.uri(title, text));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** A read-only document holding `text` (a side of a preview diff, say). */
  uri(title: string, text: string): vscode.Uri {
    const id = String(++this.seq);
    this.docs.set(id, text);
    while (this.docs.size > MAX_DOCS) this.docs.delete(this.docs.keys().next().value as string);
    const name =
      title
        .replace(/[\\/:*?"<>|\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "Tool text";
    return vscode.Uri.from({ scheme: TOOL_TEXT_SCHEME, path: `/${name}`, query: `id=${id}` });
  }
}
