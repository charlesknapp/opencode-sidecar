import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectUi } from "../src/core/providerConnect";
import { deriveProviders, parseIntegration } from "../src/core/providers";
import { SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError } from "../src/opencode/client";
import { mcpNameError, parseMcpTarget, splitCommand } from "../src/shared/mcp";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "C:\\work\\repo";
const silentLog = { info() {}, warn() {}, error() {} };

function setup() {
  const client = new MockClient();
  let mcpEvents = 0;
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents() {}, onTranscriptReset() {}, onStateChanged() {}, onMcpChanged: () => mcpEvents++ },
    silentLog,
    () => ({ model: "", agent: "" }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, mcpPollMs: 1 },
  );
  return { client, c, mcpEvents: () => mcpEvents };
}

/** A ConnectUi whose browser sign-in finishes at once. */
function okUi(asked: string[] = []): ConnectUi {
  return {
    pickMethod: async (_i, m) => m[0],
    askField: async () => undefined,
    askKey: async () => undefined,
    askCode: async () => undefined,
    openUrl: async (url) => (asked.push(`open:${url}`), true),
    waiting: () => ({ cancelled: () => false, done() {} }),
    runInTerminal: async () => undefined,
    sleep: async () => undefined,
    now: () => 0,
  };
}

const REMOTE_AUTH = {
  id: "mcp_3643",
  name: "remo",
  mcp: true as const,
  methods: [{ type: "oauth" as const, id: "mcp_3643", label: "remo", envNames: [], fields: [] }],
  connections: [],
};

describe("MCP servers added for one OpenCode run", () => {
  it("splits a command line like a shell, keeping quoted spaces and Windows backslashes", () => {
    assert.deepEqual(splitCommand("npx -y @acme/mcp-server"), ["npx", "-y", "@acme/mcp-server"]);
    assert.deepEqual(splitCommand('node "C:\\My Tools\\server.js"  --port 3'), [
      "node",
      "C:\\My Tools\\server.js",
      "--port",
      "3",
    ]);
    assert.deepEqual(splitCommand("a 'b c' \"\" d"), ["a", "b c", "", "d"]);
    assert.deepEqual(splitCommand("   "), []);
  });

  it("reads a URL as a remote server and anything else as a command", () => {
    assert.deepEqual(parseMcpTarget(" https://mcp.example.com/mcp "), {
      ok: true,
      config: { type: "remote", url: "https://mcp.example.com/mcp" },
    });
    assert.deepEqual(parseMcpTarget("uvx mcp-server-git"), {
      ok: true,
      config: { type: "local", command: ["uvx", "mcp-server-git"] },
    });
    assert.equal(parseMcpTarget("").ok, false);
    assert.equal(parseMcpTarget('""').ok, false, "an empty program");
    assert.deepEqual(parseMcpTarget("ws://host/mcp"), {
      ok: false,
      error: "A URL must start with http:// or https://.",
    });
    assert.equal(parseMcpTarget("http://").ok, false);
  });

  it("checks names: file-safe, short and not taken", () => {
    assert.equal(mcpNameError("git-tools_1.x", ["github"]), null);
    assert.match(mcpNameError("", [])!, /Give the server a name/);
    assert.match(mcpNameError("has space", [])!, /letters, digits/);
    assert.match(mcpNameError("-x", [])!, /letters, digits/);
    assert.match(mcpNameError("a".repeat(65), [])!, /up to 64/);
    assert.match(mcpNameError("github", ["github"])!, /already exists/);
  });
});

describe("MCP over HTTP", () => {
  it("connects, disconnects, adds and removes through OpenCode's experimental routes", async () => {
    const calls: Array<{ method: string; url: URL; body: unknown }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname.includes("nope"))
        return new Response(
          JSON.stringify({
            _tag: "McpServerNotFoundError",
            server: "nope",
            message: "MCP server not found: nope",
          }),
          { status: 404 },
        );
      if (url.pathname === "/api/mcp")
        return new Response(
          JSON.stringify({
            location: { directory: DIR },
            data: [
              {
                name: "remo",
                status: { status: "needs_auth", error: "Unauthorized" },
                integrationID: "mcp_3643",
              },
              { name: "tiny", status: { status: "connected" }, integrationID: "" },
            ],
          }),
        );
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn);
    assert.deepEqual(await c.listMcpServers(DIR), [
      { name: "remo", status: "needs_auth", error: "Unauthorized", integrationID: "mcp_3643" },
      { name: "tiny", status: "connected" },
    ]);
    await c.connectMcp("c:\\work\\repo", "my server");
    await c.disconnectMcp(DIR, "tiny");
    await c.addMcp(DIR, "git", { type: "local", command: ["uvx", "mcp-server-git"] });
    await c.removeMcp(DIR, "git");
    assert.deepEqual(
      calls.slice(1).map((x) => [x.method, x.url.pathname, x.url.searchParams.get("location[directory]")]),
      [
        ["POST", "/api/experimental/mcp/my%20server/connect", "C:\\work\\repo"],
        ["POST", "/api/experimental/mcp/tiny/disconnect", DIR],
        ["PUT", "/api/experimental/mcp/git", DIR],
        ["DELETE", "/api/experimental/mcp/git", DIR],
      ],
    );
    assert.deepEqual(calls[3].body, { config: { type: "local", command: ["uvx", "mcp-server-git"] } });
    await assert.rejects(c.connectMcp(DIR, "nope"), (e: unknown) => {
      assert.ok(e instanceof OpenCodeHttpError);
      assert.equal(e.status, 404);
      assert.equal(e.tag, "McpServerNotFoundError");
      return true;
    });
  });

  it("keeps an MCP server's sign-in out of the Providers panel", () => {
    const parsed = parseIntegration({
      id: "mcp_3643",
      name: "remo",
      metadata: { source: "mcp" },
      methods: [{ id: "mcp_3643", type: "oauth", label: "remo" }],
      connections: [{ type: "credential", id: "cred_1", label: "me@example.com", method: "oauth" }],
    });
    assert.equal(parsed?.mcp, true);
    assert.equal(
      parseIntegration({ id: "openai", name: "OpenAI", methods: [], connections: [] })?.mcp,
      undefined,
    );
    const view = deriveProviders({ integrations: [parsed!], providers: [], models: [], errors: new Map() });
    assert.deepEqual([view.connected, view.available], [[], []]);
  });
});

describe("session controller: the MCP panel", () => {
  it("marks the servers it added for this run, and forgets them once OpenCode no longer lists them", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.mcp = [{ name: "github", status: "connected" }];
    await c.addMcp("git", 'uvx "mcp server git"');
    assert.deepEqual(client.callsTo("addMcp")[0].args, [
      DIR,
      "git",
      { type: "local", command: ["uvx", "mcp server git"] },
    ]);
    assert.deepEqual(await c.mcpServers(), [
      { name: "github", status: "connected" },
      { name: "git", status: "connected", runtime: true },
    ]);
    // A config reload drops it in OpenCode; a server added again later under that name is not Sidecar's.
    client.mcp = client.mcp.filter((m) => m.name !== "git");
    assert.deepEqual(await c.mcpServers(), [{ name: "github", status: "connected" }]);
    client.mcp.push({ name: "git", status: "connected" });
    assert.deepEqual((await c.mcpServers()).at(-1), { name: "git", status: "connected" });
  });

  it("refuses a bad name, a taken one or an empty command before asking OpenCode", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.mcp = [{ name: "github", status: "connected" }];
    await assert.rejects(c.addMcp("github", "npx x"), /already exists/);
    await assert.rejects(c.addMcp("my server", "npx x"), /letters, digits/);
    await assert.rejects(c.addMcp("x", "  "), /Type a command/);
    assert.equal(client.callsTo("addMcp").length, 0);
  });

  it("connects, disconnects and removes for this run", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.mcp = [{ name: "db", status: "failed", error: "spawn ENOENT" }];
    await c.connectMcp("db");
    assert.equal((await c.mcpServers())[0].status, "connected");
    await c.disconnectMcp("db");
    assert.equal((await c.mcpServers())[0].status, "disabled");
    await c.removeMcp("db");
    assert.deepEqual(await c.mcpServers(), []);
    await assert.rejects(c.connectMcp("db"), /not found/);
  });

  it("signs in through the server's integration, connects it and waits until it is connected", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.integrations = [REMOTE_AUTH];
    client.mcp = [{ name: "remo", status: "needs_auth", error: "Unauthorized", integrationID: "mcp_3643" }];
    // OpenCode lists it as connecting for a moment after the sign-in.
    client.mcpAfterConnect = ["pending"];
    let polls = 0;
    const list = client.listMcpServers.bind(client);
    client.listMcpServers = async (d: string) => {
      const l = await list(d);
      if (l[0]?.status === "pending" && ++polls >= 2) client.mcp = [{ ...l[0], status: "connected" }];
      return client.mcp;
    };
    const asked: string[] = [];
    assert.deepEqual(await c.authenticateMcp("remo", okUi(asked)), { kind: "connected" });
    assert.deepEqual(client.callsTo("startOAuth")[0].args, [DIR, "mcp_3643", "mcp_3643", undefined]);
    assert.deepEqual(asked, ["open:https://example.test/authorize"]);
    assert.equal(client.callsTo("connectMcp").length, 1);
    assert.equal((await c.mcpServers())[0].status, "connected");
  });

  it("says so when a server has no sign-in, is gone, still needs one or fails after it", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.integrations = [REMOTE_AUTH];
    client.mcp = [{ name: "plain", status: "needs_auth", error: "Unauthorized" }];
    assert.deepEqual(await c.authenticateMcp("plain", okUi()), {
      kind: "failed",
      message: "OpenCode offers no sign-in for plain.",
    });
    assert.deepEqual(await c.authenticateMcp("gone", okUi()), {
      kind: "failed",
      message: "OpenCode no longer lists gone.",
    });
    client.mcp = [{ name: "remo", status: "needs_auth", error: "Unauthorized", integrationID: "mcp_3643" }];
    client.mcpAfterConnect = ["needs_auth"];
    assert.deepEqual(await c.authenticateMcp("remo", okUi()), {
      kind: "failed",
      message: "OpenCode still reports that it needs a sign-in.",
    });
    client.mcpAfterConnect = ["failed"];
    const failed = await c.authenticateMcp("remo", okUi());
    assert.equal(failed.kind, "failed");
    client.oauthStatuses = [{ status: "failed", message: "access_denied" }];
    client.mcp = [{ name: "remo", status: "needs_auth", error: "Unauthorized", integrationID: "mcp_3643" }];
    assert.deepEqual(await c.authenticateMcp("remo", okUi()), { kind: "failed", message: "access_denied" });
    client.integrations = [];
    assert.equal((await c.authenticateMcp("remo", okUi())).kind, "failed", "an integration OpenCode lost");
  });

  it("hears OpenCode's MCP state changes for the open folder only", async () => {
    const { c, mcpEvents } = setup();
    await c.setDirectory(DIR);
    const ev = (directory?: string) => ({
      id: "e",
      created: 1,
      type: "mcp.status.changed",
      data: { server: "tiny" },
      ...(directory ? { location: { directory } } : {}),
    });
    c.handleRawEvent(ev("c:\\work\\repo"));
    c.handleRawEvent(ev());
    c.handleRawEvent(ev("C:\\elsewhere"));
    c.handleRawEvent({ id: "e", created: 1, type: "mcp.resources.changed", data: { server: "tiny" } });
    assert.equal(mcpEvents(), 2);
  });

  it("accepts the panel's messages and nothing else", () => {
    for (const m of [
      { type: "mcpConnect", name: "my server" },
      { type: "mcpDisconnect", name: "tiny" },
      { type: "mcpAuth", name: "remo" },
      { type: "mcpRemove", name: "git" },
      { type: "mcpAdd", name: "git", target: "uvx mcp-server-git" },
      { type: "reloadMcp" },
    ])
      assert.deepEqual(parseWebviewMessage(m), m, m.type);
    assert.equal(parseWebviewMessage({ type: "mcpConnect", name: "" }), undefined);
    assert.equal(parseWebviewMessage({ type: "mcpAdd", name: "git" }), undefined);
    assert.equal(parseWebviewMessage({ type: "mcpAdd", name: "git", target: "x".repeat(4001) }), undefined);
    assert.equal(parseWebviewMessage({ type: "mcpAuth", name: "remo", url: "https://evil" }), undefined);
  });
});
