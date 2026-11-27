// VS Code side of provider setup: the questions, key box, browser and progress of
// OpenCode's connect flows (src/core/providerConnect.ts runs them), and the setup check's
// report. A key typed here goes from the input box to OpenCode and nowhere else.

import * as vscode from "vscode";
import type { ConnectUi } from "../core/providerConnect";
import { methodName, type IntegrationInfo, type IntegrationMethod } from "../core/providers";
import type { OAuthAttempt } from "../opencode/client";
import type { FormField, FormValue } from "../shared/model";

/** The connect flow's UI in VS Code: quick picks, masked input boxes and a progress notification. */
export function vscodeConnectUi(
  runInTerminal: (integration: IntegrationInfo, method: IntegrationMethod | null) => Promise<void>,
  onWaiting: (text: string | null) => void,
): ConnectUi {
  return {
    async pickMethod(integration, methods) {
      const pick = await vscode.window.showQuickPick(
        methods.map((m) => ({ label: methodName(m), method: m })),
        {
          title: `Connect ${integration.name}`,
          placeHolder: "How do you want to connect?",
          ignoreFocusOut: true,
        },
      );
      return pick?.method;
    },
    async askField(integration, field) {
      return askField(integration, field);
    },
    async askKey(integration, method) {
      return vscode.window.showInputBox({
        title: `${integration.name}: ${methodName(method)}`,
        prompt: `Paste your ${integration.name} key. It goes to OpenCode, which stores it; Sidecar keeps no copy.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "Paste the key, or press Escape to cancel."),
      });
    },
    async askCode(integration, attempt) {
      return askCode(integration, attempt);
    },
    async openUrl(url) {
      try {
        return await vscode.env.openExternal(vscode.Uri.parse(url, true));
      } catch {
        return false;
      }
    },
    waiting(text) {
      let cancelled = false;
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      onWaiting(text);
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: text, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => (cancelled = true));
          return finished;
        },
      );
      return {
        cancelled: () => cancelled,
        done: () => {
          finish();
          onWaiting(null);
        },
      };
    },
    runInTerminal,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

async function askField(integration: IntegrationInfo, field: FormField): Promise<FormValue | undefined> {
  if (field.type === "external" || field.type === "multiselect") return undefined;
  const title = `${integration.name}: ${field.title ?? field.key}`;
  if (field.type === "boolean") {
    const pick = await vscode.window.showQuickPick(["Yes", "No"], { title, ignoreFocusOut: true });
    return pick === undefined ? undefined : pick === "Yes";
  }
  if (field.type === "string" && field.options?.length) {
    const items: Array<vscode.QuickPickItem & { value: string | null }> = field.options.map((o) => ({
      label: o.label,
      description: o.description,
      value: o.value,
    }));
    if (field.custom) items.push({ label: "Other…", value: null });
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: field.description,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.value !== null) return pick.value;
  }
  const v = await vscode.window.showInputBox({
    title,
    prompt: field.description,
    placeHolder: field.type === "string" ? field.placeholder : undefined,
    value: field.default === undefined ? undefined : String(field.default),
    ignoreFocusOut: true,
    validateInput: (x) => (field.required && !x.trim() ? `${field.title ?? field.key} is required.` : null),
  });
  if (v === undefined) return undefined;
  if (field.type === "number" || field.type === "integer") return v.trim() === "" ? "" : Number(v);
  return v.trim();
}

async function askCode(integration: IntegrationInfo, attempt: OAuthAttempt): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Sign in to ${integration.name}`,
    prompt: attempt.instructions || "Paste the code shown in your browser after signing in.",
    password: true,
    ignoreFocusOut: true,
  });
}
