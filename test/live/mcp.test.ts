// Live tests for the MCP panel against the real OpenCode service, in a temporary folder:
// a tiny stdio MCP server (a hand-written JSON-RPC responder run with this Node) added for
// this OpenCode run only, connected, disconnected and removed; a failing one; the 404s;
// OpenCode's MCP events; and the sign-in of a fake remote server with OAuth served by the
// test itself (its "browser" follows the authorize page), whose credential is removed
// again. Nothing is written to OpenCode's config. They skip without a registered service.
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import type { ConnectUi } from "../../src/core/providerConnect";
import { SessionController } from "../../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError } from "../../src/opencode/client";
import { discoverServer } from "../../src/opencode/service";
import type { McpServerInfo } from "../../src/shared/model";
import { MemoryStore } from "../mockClient";

let client: HttpOpenCodeClient | undefined;
let skipReason = "";
let dir = "";
let serverJs = "";
/** Servers and credentials to clean up whatever happens. */
const added = new Set<string>();
const credentials = new Set<string>();

/** A minimal MCP server over stdio: newline-delimited JSON-RPC with one tool. */
const TINY_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "tiny", version: "1.0.0" } } });
  else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo the text",
      inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
});
`;

before(async () => {
  const outcome = await discoverServer(
    { serverUrl: "", allowRemote: false },
    { readFile: (f) => fs.promises.readFile(f, "utf8").catch(() => undefined), fetch, env: process.env },
  );
  if (!outcome.ok) {
    skipReason = `no live OpenCode service (${outcome.reason}: ${outcome.detail})`;
    return;
  }
  client = new HttpOpenCodeClient(outcome.endpoint);
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-mcp-")));
  serverJs = path.join(dir, "tiny-mcp.js");
  fs.writeFileSync(serverJs, TINY_SERVER);
});

after(async () => {
  for (const c of credentials) await client?.removeCredential(c).catch(() => undefined);
  for (const n of added) await client?.removeMcp(dir, n).catch(() => undefined);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

/** The server's entry once `ready` holds for it (OpenCode connects in the background). */
async function until(
  c: HttpOpenCodeClient,
  name: string,
  ready: (m: McpServerInfo | undefined) => boolean,
): Promise<McpServerInfo | undefined> {
  let m: McpServerInfo | undefined;
  for (let i = 0; i < 40; i++) {
    m = (await c.listMcpServers(dir)).find((x) => x.name === name);
    if (ready(m)) return m;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`${name} never got there: ${JSON.stringify(m)}`);
}

async function refusal(p: Promise<unknown>): Promise<OpenCodeHttpError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof OpenCodeHttpError, String(e));
    return e;
  }
  assert.fail("OpenCode accepted the call");
}

describe("live: MCP servers", () => {
  it("adds a stdio server for this run, connects and disconnects it, and removes it", async (t) => {
    const c = live(t);
    if (!c) return;
    assert.deepEqual(await c.listMcpServers(dir), [], "a new folder has none");
    await c.addMcp(dir, "tiny", { type: "local", command: [process.execPath, serverJs] });
    added.add("tiny");
    const up = await until(c, "tiny", (m) => m?.status === "connected");
    assert.deepEqual(up, { name: "tiny", status: "connected" }, "a local server has no sign-in");
    await c.disconnectMcp(dir, "tiny");
    assert.equal((await until(c, "tiny", (m) => m?.status !== "connected"))?.status, "disabled");
    await c.connectMcp(dir, "tiny");
    await until(c, "tiny", (m) => m?.status === "connected");
    // Runtime only: another folder does not have it, and the config documents do not mention it.
    const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-live-mcp2-")));
    try {
      assert.deepEqual(await c.listMcpServers(other), []);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    const sources = await c.configSources(dir);
    assert.ok(!JSON.stringify(sources).includes("tiny-mcp"), "nothing was written to a config");
    await c.removeMcp(dir, "tiny");
    added.delete("tiny");
    assert.deepEqual(await c.listMcpServers(dir), []);
  });

  it("lists a server that cannot start as failed with OpenCode's reason", async (t) => {
    const c = live(t);
    if (!c) return;
    await c.addMcp(dir, "broken", { type: "local", command: [process.execPath, "-e", "process.exit(3)"] });
    added.add("broken");
    const m = await until(c, "broken", (x) => x?.status === "failed");
    assert.match(m?.error ?? "", /exited with code 3/);
    await c.removeMcp(dir, "broken");
    added.delete("broken");
  });

  it("answers 404 McpServerNotFoundError for a server it does not have", async (t) => {
    const c = live(t);
    if (!c) return;
    for (const call of [
      c.connectMcp(dir, "sidecar-nope"),
      c.disconnectMcp(dir, "sidecar-nope"),
      c.removeMcp(dir, "sidecar-nope"),
    ]) {
      const e = await refusal(call);
      assert.equal(e.status, 404);
      assert.equal(e.tag, "McpServerNotFoundError");
    }
  });

  it("sends mcp.status.changed with the folder, which the controller passes on", async (t) => {
    const c = live(t);
    if (!c) return;
    let heard = 0;
    const ctl = new SessionController(
      c,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {}, onMcpChanged: () => heard++ },
      { info() {}, warn() {}, error() {} },
      () => ({ model: "", agent: "" }),
    );
    const seen: Array<{ server?: unknown; directory?: unknown }> = [];
    let opened!: () => void;
    const open = new Promise<void>((r) => (opened = r));
    const sub = c.subscribe({
      onOpen: () => opened(),
      onClose() {},
      onEvent: (raw) => {
        const e = raw as { type?: string; data?: { server?: unknown }; location?: { directory?: unknown } };
        if (e.type === "mcp.status.changed")
          seen.push({ server: e.data?.server, directory: e.location?.directory });
        ctl.handleRawEvent(raw);
      },
    });
    try {
      await ctl.setDirectory(dir);
      await open;
      await ctl.addMcp("evented", `"${process.execPath}" "${serverJs}"`);
      added.add("evented");
      assert.deepEqual(await ctl.mcpServers(), [{ name: "evented", status: "connected", runtime: true }]);
      await ctl.disconnectMcp("evented");
      for (let i = 0; i < 20 && !seen.some((s) => s.server === "evented"); i++)
        await new Promise((r) => setTimeout(r, 250));
      const mine = seen.filter((s) => s.server === "evented");
      assert.ok(mine.length > 0, "OpenCode sent mcp.status.changed");
      for (const s of mine) assert.equal(s.directory, dir);
      assert.ok(heard > 0, "the controller passed it on");
      await ctl.removeMcp("evented");
      added.delete("evented");
      assert.deepEqual(await ctl.mcpServers(), []);
    } finally {
      sub.dispose();
      ctl.dispose();
    }
  });

  it("signs in to a remote server through its OAuth integration and connects it", async (t) => {
    const c = live(t);
    if (!c) return;
    const fake = await oauthServer();
    try {
      await c.addMcp(dir, "remote", { type: "remote", url: `${fake.url}/mcp` });
      added.add("remote");
      const waiting = await until(c, "remote", (m) => m?.status === "needs_auth");
      assert.equal(waiting?.error, "Unauthorized");
      assert.match(waiting?.integrationID ?? "", /^mcp_/, "it names the integration to sign in with");
      const integration = await c.getIntegration(dir, waiting!.integrationID!);
      assert.deepEqual(
        integration.methods.map((m) => m.type),
        ["oauth"],
      );
      assert.equal(integration.mcp, true, "kept out of the Providers panel");

      const ctl = new SessionController(
        c,
        new MemoryStore(),
        { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
        { info() {}, warn() {}, error() {} },
        () => ({ model: "", agent: "" }),
      );
      await ctl.setDirectory(dir);
      const opened: string[] = [];
      const outcome = await ctl.authenticateMcp("remote", browserUi(opened));
      for (const conn of (await c.getIntegration(dir, waiting!.integrationID!)).connections)
        if (conn.credentialID) credentials.add(conn.credentialID);
      assert.deepEqual(outcome, { kind: "connected" });
      assert.equal(opened.length, 1);
      assert.ok(opened[0].startsWith(`${fake.url}/authorize?`), "the page OpenCode returned was opened");
      assert.equal((await c.listMcpServers(dir)).find((m) => m.name === "remote")?.status, "connected");
      assert.ok(fake.calls.includes("POST /token"), "OpenCode exchanged the code");
      assert.ok(fake.calls.includes("POST /mcp tools/list"), "and listed the tools with the token");
      ctl.dispose();
    } finally {
      for (const cred of credentials) await c.removeCredential(cred).catch(() => undefined);
      credentials.clear();
      await c.removeMcp(dir, "remote").catch(() => undefined);
      added.delete("remote");
      await fake.close();
    }
  });
});

/** A ConnectUi whose "browser" follows the authorize page to OpenCode's callback. */
function browserUi(opened: string[]): ConnectUi {
  return {
    pickMethod: async (_i, m) => m[0],
    askField: async () => undefined,
    askKey: async () => undefined,
    askCode: async () => undefined,
    async openUrl(url) {
      opened.push(url);
      const r = await fetch(url, { redirect: "manual" });
      const to = r.headers.get("location");
      if (!to) return false;
      await fetch(to);
      return true;
    },
    waiting: () => ({ cancelled: () => false, done() {} }),
    runInTerminal: async () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/**
 * A remote MCP server that wants OAuth: protected resource and authorization server
 * metadata, dynamic client registration, an authorize page that redirects at once with a
 * code, a token endpoint, and MCP over HTTP (JSON replies) for that token only.
 */
async function oauthServer(): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const token = `tok_${Math.random().toString(36).slice(2)}`;
  const calls: string[] = [];
  let url = "";
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", url);
      const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      calls.push(`${req.method} ${u.pathname}`);
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json(200, { resource: `${url}/mcp`, authorization_servers: [url] });
      if (u.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return json(200, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          registration_endpoint: `${url}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (u.pathname === "/register") {
        const r = JSON.parse(body || "{}") as { redirect_uris?: string[] };
        return json(201, {
          client_id: "sidecar-test",
          redirect_uris: r.redirect_uris,
          token_endpoint_auth_method: "none",
        });
      }
      if (u.pathname === "/authorize") {
        const to = new URL(u.searchParams.get("redirect_uri") ?? "");
        to.searchParams.set("code", "code123");
        to.searchParams.set("state", u.searchParams.get("state") ?? "");
        res.writeHead(302, { location: to.toString() });
        return res.end();
      }
      if (u.pathname === "/token")
        return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
      if (u.pathname.startsWith("/mcp")) {
        if (req.headers.authorization !== `Bearer ${token}`)
          return json(
            401,
            { error: "unauthorized" },
            { "www-authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"` },
          );
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const m = JSON.parse(body) as {
          id?: unknown;
          method?: string;
          params?: { protocolVersion?: string };
        };
        calls.push(`POST /mcp ${m.method}`);
        if (m.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        if (m.method === "initialize")
          return json(200, {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: m.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1" },
            },
          });
        if (m.method === "tools/list")
          return json(200, {
            jsonrpc: "2.0",
            id: m.id,
            result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] },
          });
        return json(200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () =>
      new Promise<void>((r) => {
        srv.close(() => r());
        srv.closeAllConnections();
      }),
  };
}
