// Connecting a provider through OpenCode's own sign-in flows. OpenCode does the work and
// stores the credentials; Sidecar only asks the questions OpenCode lists, opens the page it
// returns and passes on what the user types. A key goes straight to OpenCode and is never
// kept or logged. VS Code stays out of this module (the `ConnectUi`), so the flow is tested
// with the mock client.

import type { OAuthAttempt, OpenCodeClient } from "../opencode/client";
import type { FormAnswer, FormField, FormValue } from "../shared/model";
import { isFieldActive, validateAnswer } from "./forms";
import { methodName, runnableMethods, type IntegrationInfo, type IntegrationMethod } from "./providers";

export interface ConnectUi {
  /** Picks one of several sign-in methods; undefined when dismissed. */
  pickMethod(
    integration: IntegrationInfo,
    methods: IntegrationMethod[],
  ): Promise<IntegrationMethod | undefined>;
  /** Asks one of OpenCode's questions; undefined when dismissed. */
  askField(integration: IntegrationInfo, field: FormField): Promise<FormValue | undefined>;
  /** Asks for an API key in a masked box; undefined when dismissed. */
  askKey(integration: IntegrationInfo, method: IntegrationMethod): Promise<string | undefined>;
  /** Asks for the code (or the redirect URL) shown in the browser; undefined when dismissed. */
  askCode(integration: IntegrationInfo, attempt: OAuthAttempt): Promise<string | undefined>;
  openUrl(url: string): Promise<boolean>;
  /** Says what the flow waits for; `cancelled()` turns true when the user gives up. */
  waiting(text: string): { cancelled(): boolean; done(): void };
  /** Runs `opencode auth login <id> --method <method>` where the user can answer it. */
  runInTerminal(integration: IntegrationInfo, method: IntegrationMethod | null): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type ConnectOutcome =
  | { kind: "connected" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  /** Handed to OpenCode in a terminal; the catalog refresh notices when it is done. */
  | { kind: "terminal" }
  /** Only an environment variable can connect it: set one of `names`. */
  | { kind: "env"; names: string[] };

export const OAUTH_POLL_MS = 2000;
/** How long a browser sign-in is waited for when OpenCode gives no expiry. */
export const OAUTH_MAX_MS = 10 * 60_000;

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "OpenCode could not connect it.";
}

/**
 * Asks the method's questions in order, skipping ones whose conditions do not hold and
 * using the default of hidden ones. Null when dismissed; `terminal` when a question needs
 * something only OpenCode's terminal flow can show (an external page, a list of choices).
 */
async function answerForm(
  integration: IntegrationInfo,
  method: IntegrationMethod,
  ui: ConnectUi,
): Promise<null | "terminal" | { ok: true; answer: FormAnswer } | { ok: false; error: string }> {
  const answer: FormAnswer = {};
  for (const field of method.fields) {
    if (field.type === "external" || field.type === "multiselect") return "terminal";
    if (!isFieldActive(field, answer)) continue;
    if (field.hidden) {
      if (field.default !== undefined) answer[field.key] = field.default;
      continue;
    }
    const v = await ui.askField(integration, field);
    if (v === undefined) return null;
    if (v !== "") answer[field.key] = v;
  }
  const form = { id: "connect", sessionID: "", title: integration.name, fields: method.fields, toolId: null };
  return validateAnswer(form, answer);
}

/**
 * Connects `integration` (or signs in again). For a re-auth, `prefer` is how it is connected
 * now, so the same kind of method is offered first.
 */
export async function connectIntegration(
  client: OpenCodeClient,
  directory: string,
  integration: IntegrationInfo,
  ui: ConnectUi,
  prefer?: IntegrationMethod["type"],
): Promise<ConnectOutcome> {
  let methods = runnableMethods(integration);
  if (!methods.length) {
    const names = integration.methods.flatMap((m) => m.envNames);
    return names.length
      ? { kind: "env", names }
      : { kind: "failed", message: `OpenCode has no sign-in for ${integration.name}.` };
  }
  if (prefer && methods.some((m) => m.type === prefer)) methods = methods.filter((m) => m.type === prefer);
  const method = methods.length === 1 ? methods[0] : await ui.pickMethod(integration, methods);
  if (!method) return { kind: "cancelled" };
  if (method.type === "command") {
    await ui.runInTerminal(integration, method);
    return { kind: "terminal" };
  }

  const form = await answerForm(integration, method, ui);
  if (form === null) return { kind: "cancelled" };
  if (form === "terminal") {
    await ui.runInTerminal(integration, method);
    return { kind: "terminal" };
  }
  if (!form.ok) return { kind: "failed", message: form.error };
  const answer = Object.keys(form.answer).length ? form.answer : undefined;

  try {
    switch (method.type) {
      case "key": {
        const key = (await ui.askKey(integration, method))?.trim();
        if (!key) return { kind: "cancelled" };
        const wait = ui.waiting(`Checking the key with ${integration.name}…`);
        try {
          await client.connectKey(directory, integration.id, key, answer);
        } finally {
          wait.done();
        }
        return { kind: "connected" };
      }
      case "external": {
        const wait = ui.waiting(`Connecting ${integration.name}…`);
        try {
          await client.connectExternal(directory, integration.id, method.id ?? "", answer);
        } finally {
          wait.done();
        }
        return { kind: "connected" };
      }
      case "oauth":
        return await oauth(client, directory, integration, method, answer, ui);
      default:
        return { kind: "failed", message: `${methodName(method)} is not supported here.` };
    }
  } catch (e) {
    return { kind: "failed", message: message(e) };
  }
}

async function oauth(
  client: OpenCodeClient,
  directory: string,
  integration: IntegrationInfo,
  method: IntegrationMethod,
  answer: FormAnswer | undefined,
  ui: ConnectUi,
): Promise<ConnectOutcome> {
  const attempt = await client.startOAuth(directory, integration.id, method.id ?? "", answer);
  const cancel = () =>
    client.cancelOAuth(directory, integration.id, attempt.attemptID).catch(() => undefined);
  if (!(await ui.openUrl(attempt.url))) {
    await cancel();
    return { kind: "failed", message: "The sign-in page could not be opened." };
  }
  if (attempt.mode === "code") {
    const code = (await ui.askCode(integration, attempt))?.trim();
    if (!code) {
      await cancel();
      return { kind: "cancelled" };
    }
    await client.completeOAuth(directory, integration.id, attempt.attemptID, code);
    return { kind: "connected" };
  }
  const started = ui.now();
  const until = attempt.expires && attempt.expires > started ? attempt.expires : started + OAUTH_MAX_MS;
  const wait = ui.waiting(
    attempt.instructions || `Finish signing in to ${integration.name} in your browser.`,
  );
  try {
    for (;;) {
      if (wait.cancelled()) {
        await cancel();
        return { kind: "cancelled" };
      }
      const s = await client.oauthStatus(directory, integration.id, attempt.attemptID);
      if (s.status === "complete") return { kind: "connected" };
      if (s.status === "failed") return { kind: "failed", message: s.message || "The sign-in failed." };
      if (s.status === "expired" || ui.now() >= until) {
        await cancel();
        return { kind: "failed", message: "The sign-in expired before it was finished. Try again." };
      }
      await ui.sleep(OAUTH_POLL_MS);
    }
  } finally {
    wait.done();
  }
}
