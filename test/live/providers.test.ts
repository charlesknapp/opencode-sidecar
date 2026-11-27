// Live tests for provider setup: OpenCode's integration and provider lists, the connect
// endpoints' validation (only with ids OpenCode does not know, so nothing is connected,
// changed or removed), the config reload and the setup check against the real service.
// They skip without a registered service. No credential is read, added or removed.
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { discoverExecutable } from "../../src/core/cliDiscovery";
import { healthMarkdown, healthReport } from "../../src/core/healthCheck";
import { deriveProviders } from "../../src/core/providers";
import { SessionController } from "../../src/core/sessionController";
import {
  HttpOpenCodeClient,
  OpenCodeHttpError,
  opencodeDirectory,
  type Endpoint,
} from "../../src/opencode/client";
import { cliVersion, discoverServer, parseRegistration, serviceFilePath } from "../../src/opencode/service";
import { forgetLocations } from "./locations";
import type { UiEvent } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

let client: HttpOpenCodeClient | undefined;
let endpoint: Endpoint | undefined;
let skipReason = "";
let dir = "";
/** An integration id OpenCode does not know: every connect call with it is refused. */
const UNKNOWN = "sidecar-live-unknown";

before(async () => {
  const outcome = await discoverServer(
    { serverUrl: "", allowRemote: false },
    { readFile: (f) => fs.promises.readFile(f, "utf8").catch(() => undefined), fetch, env: process.env },
  );
  if (!outcome.ok) {
    skipReason = `no live OpenCode service (${outcome.reason}: ${outcome.detail})`;
    return;
  }
  endpoint = outcome.endpoint;
  client = new HttpOpenCodeClient(endpoint);
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-prov-")));
  for (let i = 0; i < 20 && (await client.listModels(dir)).length === 0; i++)
    await new Promise((r) => setTimeout(r, 500));
});

const created = new Set<string>();

after(async () => {
  for (const id of created) await client?.deleteSession(id).catch(() => undefined);
  await forgetLocations(endpoint, [dir]);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

/** What OpenCode refused a call with. */
async function refusal(p: Promise<unknown>): Promise<OpenCodeHttpError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof OpenCodeHttpError, String(e));
    return e;
  }
  assert.fail("OpenCode accepted the call");
}

describe("live: provider setup", () => {
  it("lists every integration with its methods and connection states, and no labels", async (t) => {
    const c = live(t);
    if (!c) return;
    const list = await c.listIntegrations(dir);
    assert.ok(list.length > 50, `only ${list.length} integrations`);
    for (const i of list) {
      assert.ok(i.id && i.name, JSON.stringify(i));
      for (const m of i.methods) {
        assert.ok(["oauth", "key", "command", "external", "env"].includes(m.type));
        if (m.type === "oauth" || m.type === "command" || m.type === "external") assert.ok(m.id);
        if (m.type === "env") assert.ok(m.envNames.length > 0);
      }
      for (const x of i.connections) {
        assert.ok(["credential", "env"].includes(x.kind));
        assert.equal(Object.hasOwn(x, "label"), false);
      }
    }
    const opencode = list.find((i) => i.id === "opencode");
    assert.ok(opencode, "OpenCode's own integration is listed");
    assert.ok(opencode.methods.some((m) => m.type === "oauth" && m.id === "device"));
    const hidden = opencode.methods.find((m) => m.type === "oauth")?.fields.find((f) => f.key === "server");
    assert.ok(hidden && hidden.type === "string" && hidden.hidden === true && hidden.default);
    // A sample with questions: GitHub Copilot asks for its deployment, with a condition.
    const copilot = list.find((i) => i.id === "github-copilot");
    if (copilot) {
      const fields = copilot.methods.find((m) => m.type === "oauth")?.fields ?? [];
      assert.ok(fields.some((f) => f.type === "string" && f.when?.length));
    }
  });

  it("reads one integration, and answers 404 for one it does not know", async (t) => {
    const c = live(t);
    if (!c) return;
    const one = await c.getIntegration(dir, "opencode");
    const listed = (await c.listIntegrations(dir)).find((i) => i.id === "opencode");
    assert.deepEqual(one, listed);
    const e = await refusal(c.getIntegration(dir, UNKNOWN));
    assert.equal(e.status, 404);
    assert.equal(e.tag, "IntegrationNotFoundError");
  });

  it("lists active providers without their settings", async (t) => {
    const c = live(t);
    if (!c) return;
    const providers = await c.listProviders(dir);
    assert.ok(providers.length > 0);
    for (const p of providers) {
      assert.ok(p.id && p.name);
      assert.ok(["auto", "enabled", "disabled"].includes(p.activation));
      assert.deepEqual(Object.keys(p).sort(), ["activation", "id", "integrationID", "localEndpoint", "name"]);
    }
    const models = await c.listModels(dir);
    const view = deriveProviders({
      integrations: await c.listIntegrations(dir),
      providers,
      models,
      errors: new Map(),
    });
    // Every model belongs to a provider the panel shows as connected.
    const shown = new Set(view.connected.map((r) => r.id));
    for (const m of models) {
      const p = providers.find((x) => x.id === m.providerID);
      assert.ok(shown.has(p?.integrationID ?? m.providerID), m.key);
    }
    assert.equal(
      view.connected.reduce((n, r) => n + r.models, 0),
      models.length,
    );
    assert.ok(view.available.length > 50);
    assert.ok(!JSON.stringify(view).includes('"apiKey"'));
  });

  it("refuses connect calls for an unknown integration, so nothing is stored", async (t) => {
    const c = live(t);
    if (!c) return;
    for (const call of [
      () => c.connectKey(dir, UNKNOWN, "not-a-key"),
      () => c.connectExternal(dir, UNKNOWN, "x"),
      () => c.oauthStatus(dir, UNKNOWN, "att_x"),
      () => c.completeOAuth(dir, UNKNOWN, "att_x", "code"),
    ]) {
      const e = await refusal(call());
      assert.equal(e.status, 404);
      assert.equal(e.tag, "IntegrationNotFoundError");
      assert.match(e.message, /Integration not found/);
    }
    const attempt = await refusal(c.oauthStatus(dir, "opencode", "att_sidecar_live"));
    assert.equal(attempt.status, 404);
    assert.equal(attempt.tag, "IntegrationAttemptNotFoundError");
    // OpenCode 2.4.2 answers an unknown OAuth integration or method with a 500, not a 404.
    const start = await refusal(c.startOAuth(dir, UNKNOWN, "device"));
    assert.ok([404, 500].includes(start.status), String(start.status));
    // Cancelling an attempt that does not exist is accepted and changes nothing.
    await c.cancelOAuth(dir, "opencode", "att_sidecar_live");
    // So is removing a credential id no integration has (OpenCode answers 204).
    const ids = (await c.listIntegrations(dir)).flatMap((i) => i.connections.map((x) => x.credentialID));
    assert.ok(!ids.includes("sidecar-live-no-such-credential"));
    await c.removeCredential("sidecar-live-no-such-credential");
    assert.deepEqual(
      (await c.listIntegrations(dir)).flatMap((i) => i.connections.map((x) => x.credentialID)),
      ids,
      "no connection changed",
    );
  });

  it("reloads OpenCode's config, also after a folder it loaded was deleted", async (t) => {
    const c = live(t);
    if (!c) return;
    // A reload rebuilds every folder OpenCode has loaded, so it would disturb the live tests
    // running beside this file (and anything else using OpenCode): it runs only when asked.
    if (!process.env.OCS_LIVE_RELOAD) return t.skip("set OCS_LIVE_RELOAD=1 to reload OpenCode's config");
    if ((await c.activeSessions()).size)
      return t.skip("a session is running; a reload would cancel its requests");
    // OpenCode refuses a reload (503 Directory not found) while it has a deleted folder
    // loaded, and drops the folder as it does; the client tries again.
    const gone = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-gone-")));
    await c.listModels(gone);
    fs.rmSync(gone, { recursive: true, force: true });
    await c.reloadConfig();
    assert.ok((await c.info()).version, "OpenCode answers after the reload");
    // A rebuilt folder briefly lists no models, as on its first load.
    let models = await c.listModels(dir);
    for (let i = 0; i < 20 && !models.length; i++) {
      await new Promise((r) => setTimeout(r, 500));
      models = await c.listModels(dir);
    }
    assert.ok(models.length > 0, "the test folder has its models again");
  });

  it("a run on a model OpenCode does not have shows Choose another model and Re-authenticate", async (t) => {
    const c = live(t);
    if (!c) return;
    // No model is called: OpenCode fails the run before its first step.
    const s = await c.createSession({
      directory: dir,
      model: { providerID: "opencode", id: "sidecar-no-such-model" },
    });
    created.add(s.id);
    const events: UiEvent[] = [];
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents: (e) => events.push(...e), onTranscriptReset() {}, onStateChanged() {} },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "opencode/big-pickle", agent: "build" }),
    );
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const sub = c.subscribe({ onEvent: (r) => ctl.handleRawEvent(r), onOpen: () => opened(), onClose() {} });
    try {
      await ready;
      await ctl.setDirectory(dir);
      assert.ok(await ctl.openSession(s.id));
      await c.prompt(s.id, { text: "hi", files: [] });
      const deadline = Date.now() + 15_000;
      while (!events.some((e) => e.type === "error") && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      const card = events.find((e) => e.type === "error");
      assert.ok(card?.type === "error", "an error card");
      // The name OpenCode gives the provider (signed in to a workspace: "Workspace / OpenCode").
      const name =
        (await c.listModels(dir)).find((m) => m.providerID === "opencode")?.providerName ?? "OpenCode";
      assert.equal(card.title, `${name} does not offer this model right now.`);
      assert.equal(card.detail, "Model unavailable: opencode/sidecar-no-such-model");
      assert.deepEqual(card.actions, ["changeModel", "reauth"]);
      assert.deepEqual(card.provider, { id: "opencode", name });
      assert.match(ctl.providerErrors.get("opencode") ?? "", /does not offer this model/);
      const view = await ctl.providersView();
      assert.equal(view.connected.find((r) => r.id === "opencode")?.state, "error");
    } finally {
      sub.dispose();
      ctl.dispose();
    }
  });

  it("composes the setup check from the real service", async (t) => {
    const c = live(t);
    if (!c) return;
    const cli = discoverExecutable({
      configuredPath: "",
      pathEnv: process.env.PATH ?? "",
      home: os.homedir(),
      platform: process.platform,
      isExecutable: (f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      },
    });
    const version = cli.found ? await cliVersion(cli.path) : null;
    if (cli.found) assert.match(version?.version ?? "", /^\d+\.\d+\.\d+/, version?.output);
    const reg = parseRegistration(
      await fs.promises.readFile(serviceFilePath(), "utf8").catch(() => undefined),
    );
    const info = await c.info();
    const lower = dir.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
    const sections = healthReport({
      platform: process.platform,
      cli,
      cliVersion: version?.version ?? null,
      service: reg ? { url: reg.url, pid: reg.pid ?? null } : null,
      serverSetting: "",
      server: { url: c.url, version: info.version, pid: info.pid },
      folder: { path: lower, sent: opencodeDirectory(lower) },
      projectID: await c.projectId(dir),
      account: await c.accountStatus(dir),
      integrations: await c.listIntegrations(dir),
      providers: await c.listProviders(dir),
      models: await c.listModels(dir),
      defaultModel: await c.defaultModel(dir),
      providerErrors: new Map(),
      pathDirs: (process.env.PATH ?? "").split(path.delimiter),
    });
    const checks = sections.flatMap((s) => s.checks);
    assert.ok(checks.some((x) => x.level === "ok" && x.text.startsWith("Reachable: OpenCode")));
    if (reg?.pid) assert.ok(checks.some((x) => x.text === `Process ${info.pid} matches the registration`));
    assert.ok(checks.some((x) => x.level === "ok" && /models? available$/.test(x.text)));
    assert.ok(!checks.some((x) => x.text.startsWith("The default model")), "the default model is offered");
    if (process.platform === "win32") {
      assert.ok(sections.some((s) => s.title === "Windows"));
      assert.ok(checks.some((x) => x.level === "ok" && x.text.startsWith("Drive letter upper-cased")));
      assert.ok(checks.some((x) => x.text === "OpenCode knows the folder (project found)"));
    }
    const md = healthMarkdown(sections, { when: new Date(), sidecar: "live" });
    assert.ok(md.startsWith("# OpenCode setup check"));
    if (reg?.password) assert.ok(!md.includes(reg.password), "the service password is not in the report");
  });
});
