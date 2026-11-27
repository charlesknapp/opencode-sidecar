import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyError } from "../src/core/errors";
import { connectIntegration, OAUTH_MAX_MS, type ConnectUi } from "../src/core/providerConnect";
import {
  deriveProviders,
  integrationOf,
  parseIntegration,
  parseProvider,
  type IntegrationInfo,
} from "../src/core/providers";
import { SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, OpenCodeHttpError } from "../src/opencode/client";
import { toRawError } from "../src/opencode/events";
import { cliInvocation } from "../src/opencode/service";
import type { FormField, ModelOption, UiEvent } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

// Integration records as OpenCode 2.4.2 lists them (GET /api/integration), trimmed to four.
const OPENAI = {
  id: "openai",
  name: "OpenAI",
  methods: [
    { type: "key" },
    { type: "env", names: ["OPENAI_API_KEY"] },
    { id: "chatgpt-token-sharing", type: "oauth", label: "Sign in with ChatGPT" },
    { id: "chatgpt-browser", type: "oauth", label: "Codex browser (legacy)" },
    { id: "chatgpt-headless", type: "oauth", label: "Codex device code (legacy)" },
  ],
  connections: [],
};
const COPILOT = {
  id: "github-copilot",
  name: "GitHub Copilot",
  methods: [
    { type: "env", names: ["COPILOT_GITHUB_TOKEN"] },
    {
      id: "device",
      type: "oauth",
      label: "Login with GitHub Copilot",
      form: [
        {
          key: "deploymentType",
          title: "Select GitHub deployment type",
          required: true,
          type: "string",
          options: [
            { value: "github.com", label: "GitHub.com", description: "Public" },
            { value: "enterprise", label: "GitHub Enterprise", description: "Data residency or self-hosted" },
          ],
        },
        {
          key: "enterpriseUrl",
          title: "Enter your GitHub Enterprise URL or domain",
          required: true,
          when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
          type: "string",
          placeholder: "company.ghe.com or https://company.ghe.com",
        },
      ],
    },
  ],
  connections: [],
};
const OPENCODE = {
  id: "opencode",
  name: "OpenCode",
  methods: [
    { type: "key", label: "API key (service account)" },
    { type: "env", names: ["OPENCODE_API_KEY"] },
    {
      id: "device",
      type: "oauth",
      label: "OpenCode account",
      form: [
        {
          key: "server",
          hidden: true,
          type: "string",
          format: "uri",
          default: "https://opencode.ai/console",
        },
      ],
    },
  ],
  connections: [],
};
const BEDROCK = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  methods: [
    { type: "key", label: "Bedrock API key" },
    { type: "env", names: ["AWS_BEARER_TOKEN_BEDROCK"] },
    {
      id: "aws-profile",
      type: "external",
      label: "AWS profile (SSO or named profile)",
      form: [
        {
          key: "profile",
          title: "AWS profile",
          required: true,
          type: "string",
          minLength: 1,
          pattern: "\\S",
          placeholder: "Profile name",
          options: [],
          custom: true,
        },
      ],
    },
  ],
  connections: [],
};

const integration = (raw: unknown): IntegrationInfo => {
  const i = parseIntegration(raw);
  assert.ok(i);
  return i;
};

const model = (providerID: string, id: string, contextLimit: number | null = 128_000): ModelOption => ({
  key: `${providerID}/${id}`,
  providerID,
  id,
  name: id,
  providerName: providerID,
  contextLimit,
  variants: [],
});

describe("provider records", () => {
  it("reads an integration's methods and questions, and drops labels and metadata", () => {
    const i = integration({
      ...COPILOT,
      metadata: { secret: "x" },
      connections: [
        {
          type: "credential",
          id: "cred_1",
          label: "someone@example.com",
          method: "oauth",
          status: { status: "needs_auth", message: "Token expired", url: "https://github.com/login" },
        },
        { type: "env", name: "COPILOT_GITHUB_TOKEN" },
      ],
    });
    assert.deepEqual(
      i.methods.map((m) => [m.type, m.id, m.label, m.envNames]),
      [
        ["env", null, "", ["COPILOT_GITHUB_TOKEN"]],
        ["oauth", "device", "Login with GitHub Copilot", []],
      ],
    );
    const fields = i.methods[1].fields;
    assert.deepEqual(
      fields.map((f) => f.key),
      ["deploymentType", "enterpriseUrl"],
    );
    assert.deepEqual(i.connections, [
      {
        kind: "credential",
        credentialID: "cred_1",
        method: "oauth",
        envName: null,
        needsAuth: "Token expired",
      },
      { kind: "env", credentialID: null, method: "env", envName: "COPILOT_GITHUB_TOKEN", needsAuth: null },
    ]);
    assert.ok(!JSON.stringify(i).includes("someone@example.com"), "labels are not kept");
    assert.ok(!JSON.stringify(i).includes("secret"));
  });

  it("drops methods it cannot start and unknown connection types", () => {
    const i = integration({
      id: "x",
      name: "X",
      methods: [{ type: "oauth", label: "no id" }, { type: "magic" }, { type: "key" }],
      connections: [{ type: "weird" }],
    });
    assert.deepEqual(
      i.methods.map((m) => m.type),
      ["key"],
    );
    assert.deepEqual(i.connections, []);
    assert.equal(parseIntegration({ name: "no id" }), null);
  });

  it("keeps only whether a provider's endpoint is on this machine, never its settings", () => {
    const remote = parseProvider({
      id: "opencode",
      integrationID: "opencode",
      name: "OpenCode",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/inference/openai/v1" },
    });
    assert.deepEqual(remote, {
      id: "opencode",
      name: "OpenCode",
      integrationID: "opencode",
      activation: "enabled",
      localEndpoint: null,
    });
    for (const [base, endpoint] of [
      ["http://localhost:11434/v1", "localhost:11434"],
      ["http://127.0.0.1:1234/v1", "127.0.0.1:1234"],
      ["http://[::1]:8080", "[::1]:8080"],
      ["{env:OLLAMA_URL}", null],
      ["https://api.example.com/v1", null],
    ] as const)
      assert.equal(
        parseProvider({ id: "p", name: "P", settings: { baseURL: base } })?.localEndpoint,
        endpoint,
        base,
      );
    assert.equal(parseProvider({ id: "p", settings: { apiKey: "sk-1" } })?.integrationID, null);
    assert.ok(!JSON.stringify(remote).includes("public"));
  });
});

describe("provider status", () => {
  const providers = [
    {
      id: "opencode",
      name: "OpenCode",
      integrationID: "opencode",
      activation: "enabled" as const,
      localEndpoint: null,
    },
    {
      id: "openai",
      name: "OpenAI",
      integrationID: "openai",
      activation: "auto" as const,
      localEndpoint: null,
    },
    {
      id: "ollama",
      name: "Ollama",
      integrationID: null,
      activation: "auto" as const,
      localEndpoint: "localhost:11434",
    },
  ];

  it("lists connected providers with their state, how they connect and their model count", () => {
    const view = deriveProviders({
      integrations: [
        integration(OPENCODE),
        integration({
          ...OPENAI,
          connections: [{ type: "credential", id: "cred_o", label: "x", method: "oauth" }],
        }),
        integration({
          ...COPILOT,
          connections: [
            {
              type: "credential",
              id: "cred_c",
              method: "oauth",
              status: { status: "needs_auth", message: "Sign in again" },
            },
          ],
        }),
        integration({ ...BEDROCK, connections: [{ type: "env", name: "AWS_BEARER_TOKEN_BEDROCK" }] }),
      ],
      providers,
      models: [
        model("opencode", "big-pickle"),
        model("openai", "gpt-5"),
        model("openai", "gpt-5-mini"),
        model("ollama", "qwen"),
      ],
      errors: new Map([["amazon-bedrock", "Bedrock rejected the credentials."]]),
    });
    assert.deepEqual(
      view.connected.map((r) => [
        r.id,
        r.state,
        r.via,
        r.models,
        r.error,
        r.canReauth,
        r.canDisconnect,
        !!r.local,
      ]),
      [
        [
          "amazon-bedrock",
          "error",
          "Environment variable AWS_BEARER_TOKEN_BEDROCK",
          0,
          "Bedrock rejected the credentials.",
          true,
          false,
          false,
        ],
        ["github-copilot", "needs-auth", "OAuth", 0, "Sign in again", true, true, false],
        ["ollama", "connected", "OpenCode config", 1, null, false, false, true],
        ["openai", "connected", "OAuth", 2, null, true, true, false],
        ["opencode", "connected", "Free models, no sign-in", 1, null, true, false, false],
      ],
    );
    assert.ok(!view.available.some((c) => ["openai", "opencode", "github-copilot"].includes(c.id)));
  });

  it("offers the rest to connect, popular ones first, with their methods", () => {
    const view = deriveProviders({
      integrations: [
        integration({ id: "zeta", name: "Zeta", methods: [{ type: "key" }], connections: [] }),
        integration({
          id: "alpha",
          name: "Alpha",
          methods: [{ type: "env", names: ["ALPHA_KEY"] }],
          connections: [],
        }),
        integration(BEDROCK),
        integration(OPENAI),
        integration(COPILOT),
      ],
      providers: [],
      models: [],
      errors: new Map(),
      busy: { id: "openai", text: "Connecting…" },
    });
    assert.deepEqual(
      view.available.map((c) => [c.id, c.methods, !!c.popular]),
      [
        ["openai", "Sign in · API key", true],
        ["github-copilot", "Sign in", true],
        ["amazon-bedrock", "API key · External", true],
        ["alpha", "Environment variable", false],
        ["zeta", "API key", false],
      ],
    );
    assert.deepEqual(view.busy, { id: "openai", text: "Connecting…" });
    assert.deepEqual(view.connected, []);
  });

  it("finds a provider's integration, or uses its own id", () => {
    assert.equal(integrationOf("openai", providers), "openai");
    assert.equal(integrationOf("ollama", providers), "ollama");
    assert.equal(integrationOf("unknown", null), "unknown");
  });
});

describe("run errors that a sign-in or another model fixes", () => {
  // `Session.StructuredError` as OpenCode 2.4 sends it in session.execution.failed.
  const ctx = { modelName: "GPT-5", providerName: "OpenAI" };
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      {
        type: "provider.auth",
        message: "Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx1234",
        status: 401,
        response: { body: '{"error":{"code":"invalid_api_key"}}' },
      },
      "auth",
    ],
    [{ type: "provider.auth", message: "Authorization failed" }, "auth"],
    [{ type: "provider.error", message: "Your token has expired", status: 403 }, "auth"],
    [{ type: "unknown", message: "OAuth token has expired. Please re-authenticate." }, "auth"],
    [{ type: "provider.no-route", message: "Model unavailable: openai/gpt-9" }, "model-not-found"],
    [{ type: "provider.no-route", message: "No model is available for session ses_1" }, "model-not-found"],
    [{ type: "provider.no-route", message: "Variant unavailable for openai/gpt-5: max" }, "model-not-found"],
    [
      {
        type: "provider.invalid-request",
        message: "The model `gpt-9` does not exist or you do not have access to it.",
        status: 404,
      },
      "model-not-found",
    ],
    [
      {
        type: "provider.no-route",
        message: "Cannot initialize local/qwen: OLLAMA_HOST is required to resolve the provider endpoint",
      },
      "provider-setup",
    ],
    [{ type: "provider.no-route", message: "Unsupported package for x/y: @ai-sdk/foo" }, "provider-setup"],
    // As the live service sent it today.
    [
      {
        type: "provider.free-limit",
        message:
          "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
        status: 429,
        response: {
          body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}',
        },
        retryAfterMs: 74220000,
      },
      "quota",
    ],
    [{ type: "provider.go-limit", message: "OpenCode Go limit reached" }, "quota"],
    [
      {
        type: "provider.chatgpt-limit",
        message: "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
      },
      "quota",
    ],
    [{ type: "provider.budget-limit", message: "Budget reached" }, "funds"],
    [{ type: "provider.rate-limit", message: "slow down", status: 429, retryAfterMs: 2000 }, "rate-limit"],
    [{ type: "provider.transport", message: "fetch failed" }, "network"],
    [{ type: "provider.timeout", message: "no answer" }, "timeout"],
    [{ type: "provider.content-filter", message: "blocked (violence)" }, "content-filter"],
  ];
  for (const [payload, kind] of cases)
    it(`${payload.type}: "${String(payload.message).slice(0, 40)}" is ${kind}`, () => {
      const raw = toRawError(payload);
      assert.ok(raw);
      assert.equal(classifyError(raw, ctx).kind, kind);
    });

  it("offers a new sign-in and another model for auth, model and setup errors", () => {
    const of = (p: Record<string, unknown>) => classifyError(toRawError(p)!, ctx);
    assert.deepEqual(of(cases[0][0]).actions, ["reauth", "changeModel", "retry"]);
    assert.deepEqual(of(cases[4][0]).actions, ["changeModel", "reauth"]);
    assert.deepEqual(of(cases[8][0]).actions, ["reauth", "changeModel"]);
    assert.ok(!of(cases[10][0]).actions.includes("reauth"), "a quota is not fixed by signing in");
    assert.equal(
      of(cases[0][0]).title,
      "GPT-5 (OpenAI) rejected the credentials. Sign in again, or choose another model.",
    );
    assert.ok(!of(cases[0][0]).detail.includes("abcdefghijklmnop"), "keys in the message are redacted");
  });
});

/** A ConnectUi that answers from a script and records what it was asked. */
function fakeUi(script: {
  method?: (labels: string[]) => number | undefined;
  fields?: Record<string, string | undefined>;
  key?: string;
  code?: string;
  open?: boolean;
  cancelAfter?: number;
}) {
  const asked: string[] = [];
  let clock = 1_000;
  let polls = 0;
  const ui: ConnectUi = {
    async pickMethod(_i, methods) {
      asked.push(`pick:${methods.map((m) => m.type).join(",")}`);
      const n = script.method?.(methods.map((m) => m.label));
      return n === undefined ? undefined : methods[n];
    },
    async askField(_i, field: FormField) {
      asked.push(`field:${field.key}`);
      return script.fields?.[field.key];
    },
    async askKey() {
      asked.push("key");
      return script.key;
    },
    async askCode() {
      asked.push("code");
      return script.code;
    },
    async openUrl(url) {
      asked.push(`open:${url}`);
      return script.open !== false;
    },
    waiting(text) {
      asked.push(`wait:${text}`);
      return {
        cancelled: () => script.cancelAfter !== undefined && polls >= script.cancelAfter,
        done: () => asked.push("done"),
      };
    },
    async runInTerminal(i, m) {
      asked.push(`terminal:${i.id}:${m?.id ?? ""}`);
    },
    async sleep(ms) {
      polls++;
      clock += ms;
    },
    now: () => clock,
  };
  return { ui, asked, polls: () => polls };
}

describe("connecting a provider through OpenCode", () => {
  const DIR = "C:\\work\\repo";

  it("hands a key to OpenCode and nowhere else", async () => {
    const client = new MockClient();
    const { ui, asked } = fakeUi({ method: () => 0, key: "  sk-live-123  " });
    const out = await connectIntegration(client, DIR, integration(OPENAI), ui);
    assert.deepEqual(out, { kind: "connected" });
    assert.deepEqual(client.callsTo("connectKey")[0].args, [DIR, "openai", "sk-live-123", undefined]);
    assert.equal(asked[0], "pick:key,oauth,oauth,oauth", "the environment variable is not offered");
    assert.ok(!asked.some((a) => a.includes("sk-live")), "the UI never echoes the key");
  });

  it("is cancelled when the key box or the method pick is dismissed", async () => {
    const client = new MockClient();
    assert.deepEqual(
      await connectIntegration(client, DIR, integration(OPENAI), fakeUi({ method: () => 0 }).ui),
      {
        kind: "cancelled",
      },
    );
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), fakeUi({}).ui), {
      kind: "cancelled",
    });
    assert.equal(client.callsTo("connectKey").length, 0);
  });

  it("reports OpenCode's answer when it rejects the key", async () => {
    const client = new MockClient();
    client.connectErrors.set(
      "connectKey",
      new OpenCodeHttpError(400, "InvalidRequestError", "Invalid API key"),
    );
    const { ui, asked } = fakeUi({ method: () => 0, key: "bad" });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), ui), {
      kind: "failed",
      message: "Invalid API key",
    });
    assert.equal(asked.at(-1), "done", "the progress closes on failure too");
  });

  it("opens OpenCode's page and polls the attempt until it completes", async () => {
    const client = new MockClient();
    client.oauthStatuses = [
      { status: "pending", message: null },
      { status: "pending", message: null },
      { status: "complete", message: null },
    ];
    const { ui, asked, polls } = fakeUi({ method: () => 1 });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), ui), { kind: "connected" });
    assert.deepEqual(client.callsTo("startOAuth")[0].args, [
      DIR,
      "openai",
      "chatgpt-token-sharing",
      undefined,
    ]);
    assert.ok(asked.includes("open:https://example.test/authorize"));
    assert.ok(asked.includes("wait:Enter code ABCD-1234"), "OpenCode's instructions are shown");
    assert.equal(client.callsTo("oauthStatus").length, 3);
    assert.equal(polls(), 2);
    assert.equal(client.callsTo("cancelOAuth").length, 0);
  });

  it("asks OpenCode's questions, follows their conditions and uses hidden defaults", async () => {
    const client = new MockClient();
    const gh = fakeUi({ fields: { deploymentType: "enterprise", enterpriseUrl: "acme.ghe.com" } });
    assert.deepEqual(await connectIntegration(client, DIR, integration(COPILOT), gh.ui), {
      kind: "connected",
    });
    assert.deepEqual(client.callsTo("startOAuth")[0].args, [
      DIR,
      "github-copilot",
      "device",
      { deploymentType: "enterprise", enterpriseUrl: "acme.ghe.com" },
    ]);
    const pub = fakeUi({ fields: { deploymentType: "github.com" } });
    await connectIntegration(client, DIR, integration(COPILOT), pub.ui);
    assert.ok(!pub.asked.includes("field:enterpriseUrl"), "a question whose condition fails is skipped");
    const oc = fakeUi({ method: (labels) => labels.indexOf("OpenCode account") });
    await connectIntegration(client, DIR, integration(OPENCODE), oc.ui);
    assert.ok(!oc.asked.some((a) => a.startsWith("field:")), "hidden questions are not asked");
    assert.deepEqual(client.callsTo("startOAuth")[2].args[3], { server: "https://opencode.ai/console" });
  });

  it("refuses an answer OpenCode's form would reject", async () => {
    const client = new MockClient();
    const { ui } = fakeUi({
      method: (l) => l.findIndex((x) => x.startsWith("AWS")),
      fields: { profile: " " },
    });
    const out = await connectIntegration(client, DIR, integration(BEDROCK), ui);
    assert.equal(out.kind, "failed");
    assert.equal(client.callsTo("connectExternal").length, 0);
    const ok = fakeUi({ method: (l) => l.findIndex((x) => x.startsWith("AWS")), fields: { profile: "dev" } });
    assert.deepEqual(await connectIntegration(client, DIR, integration(BEDROCK), ok.ui), {
      kind: "connected",
    });
    assert.deepEqual(client.callsTo("connectExternal")[0].args, [
      DIR,
      "amazon-bedrock",
      "aws-profile",
      { profile: "dev" },
    ]);
  });

  it("finishes a code sign-in with the pasted code", async () => {
    const client = new MockClient();
    client.oauthAttempt = { ...client.oauthAttempt, mode: "code", instructions: "Paste the code" };
    const { ui } = fakeUi({ method: () => 1, code: " abc123 " });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), ui), { kind: "connected" });
    assert.deepEqual(client.callsTo("completeOAuth")[0].args, [DIR, "openai", "att_1", "abc123"]);
    const none = fakeUi({ method: () => 1 });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), none.ui), {
      kind: "cancelled",
    });
    assert.equal(client.callsTo("cancelOAuth").length, 1, "an abandoned attempt is cancelled");
  });

  it("cancels the attempt when the user gives up, it fails, expires or the page cannot open", async () => {
    const client = new MockClient();
    client.oauthStatuses = [{ status: "pending", message: null }];
    const gaveUp = fakeUi({ method: () => 1, cancelAfter: 2 });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), gaveUp.ui), {
      kind: "cancelled",
    });
    assert.equal(client.callsTo("cancelOAuth").length, 1);

    const slow = fakeUi({ method: () => 1 });
    const out = await connectIntegration(client, DIR, integration(OPENAI), slow.ui);
    assert.equal(out.kind, "failed");
    assert.equal(slow.polls(), OAUTH_MAX_MS / 2000, "waits up to ten minutes without an expiry");
    assert.equal(client.callsTo("cancelOAuth").length, 2);

    client.oauthStatuses = [{ status: "failed", message: "Access denied" }];
    assert.deepEqual(
      await connectIntegration(client, DIR, integration(OPENAI), fakeUi({ method: () => 1 }).ui),
      {
        kind: "failed",
        message: "Access denied",
      },
    );
    client.oauthStatuses = [{ status: "expired", message: null }];
    assert.equal(
      (await connectIntegration(client, DIR, integration(OPENAI), fakeUi({ method: () => 1 }).ui)).kind,
      "failed",
    );

    const blocked = fakeUi({ method: () => 1, open: false });
    assert.deepEqual(await connectIntegration(client, DIR, integration(OPENAI), blocked.ui), {
      kind: "failed",
      message: "The sign-in page could not be opened.",
    });
    assert.ok(!blocked.asked.some((a) => a.startsWith("wait:")));
  });

  it("reports an attempt OpenCode would not start", async () => {
    const client = new MockClient();
    client.connectErrors.set(
      "startOAuth",
      new OpenCodeHttpError(500, "UnknownError", "Server failed to handle the request."),
    );
    assert.deepEqual(
      await connectIntegration(client, DIR, integration(OPENAI), fakeUi({ method: () => 1 }).ui),
      {
        kind: "failed",
        message: "Server failed to handle the request.",
      },
    );
  });

  it("runs command methods and questions it cannot ask in OpenCode's terminal flow", async () => {
    const client = new MockClient();
    const cmd = integration({
      id: "corp",
      name: "Corp",
      methods: [{ id: "sso", type: "command", label: "Corp SSO", command: ["corp", "login"] }],
      connections: [],
    });
    const a = fakeUi({});
    assert.deepEqual(await connectIntegration(client, DIR, cmd, a.ui), { kind: "terminal" });
    assert.deepEqual(a.asked, ["terminal:corp:sso"]);
    const multi = integration({
      id: "m",
      name: "M",
      methods: [
        {
          id: "o",
          type: "oauth",
          label: "M",
          form: [{ key: "scopes", type: "multiselect", options: [{ value: "a" }] }],
        },
      ],
      connections: [],
    });
    const b = fakeUi({});
    assert.deepEqual(await connectIntegration(client, DIR, multi, b.ui), { kind: "terminal" });
    assert.equal(client.callsTo("startOAuth").length, 0);
  });

  it("says which variable to set when only an environment variable connects it", async () => {
    const client = new MockClient();
    const env = integration({
      id: "e",
      name: "E",
      methods: [{ type: "env", names: ["E_KEY", "E_TOKEN"] }],
      connections: [],
    });
    assert.deepEqual(await connectIntegration(client, DIR, env, fakeUi({}).ui), {
      kind: "env",
      names: ["E_KEY", "E_TOKEN"],
    });
  });

  it("signs in again the way it is connected now", async () => {
    const client = new MockClient();
    const { ui, asked } = fakeUi({ method: () => 0 });
    await connectIntegration(client, DIR, integration(OPENAI), ui, "oauth");
    assert.equal(asked[0], "pick:oauth,oauth,oauth");
    const key = fakeUi({ key: "k" });
    await connectIntegration(client, DIR, integration(OPENAI), key.ui, "key");
    assert.equal(key.asked[0], "key", "one matching method: no pick");
  });
});

describe("providers in the session controller", () => {
  const DIR = "/work/repo";
  const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });
  function setup() {
    const client = new MockClient();
    const emitted: UiEvent[] = [];
    const logs: string[] = [];
    const log = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const c = new SessionController(
      client,
      new MemoryStore(),
      { onEvents: (e) => emitted.push(...e), onTranscriptReset() {}, onStateChanged() {} },
      log,
      () => ({ model: "", agent: "" }),
      { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
    );
    return { client, c, emitted, logs };
  }

  async function failWith(error: Record<string, unknown>, providers?: MockClient["providers"]) {
    const env = setup();
    if (providers) env.client.providers = providers;
    await env.c.setDirectory(DIR);
    await env.c.send("hi", []);
    env.c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_1" }));
    env.c.handleRawEvent(
      raw("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        model: { providerID: "vast", id: "qwen" },
      }),
    );
    env.c.handleRawEvent(raw("session.execution.failed", { sessionID: "ses_1", error }));
    const card = env.emitted.find((e) => e.type === "error");
    assert.ok(card?.type === "error");
    return { ...env, card };
  }

  it("an auth failure offers a new sign-in for the model's provider and is remembered", async () => {
    const { c, card } = await failWith({ type: "provider.auth", message: "Invalid API key", status: 401 }, [
      { id: "vast", name: "Vast", integrationID: "vast-ai", activation: "auto", localEndpoint: null },
    ]);
    assert.deepEqual(card.actions, ["reauth", "changeModel", "retry"]);
    assert.deepEqual(card.provider, { id: "vast-ai", name: "Vast" });
    assert.match(c.providerErrors.get("vast-ai") ?? "", /rejected the credentials/);
  });

  it("a run that fails before its first step is put down to the session's model", async () => {
    const { c, emitted } = setup();
    await c.setDirectory(DIR);
    await c.send("hi", []);
    const model = c.current?.modelKey;
    assert.ok(model);
    // What OpenCode 2.4.2 sends for a session on a model it does not have (checked live).
    c.handleRawEvent(
      raw("session.execution.failed", {
        sessionID: c.current!.id,
        error: { type: "provider.no-route", message: `Model unavailable: ${model}` },
      }),
    );
    const card = emitted.find((e) => e.type === "error");
    assert.ok(card?.type === "error");
    assert.deepEqual(card.actions, ["changeModel", "reauth"]);
    assert.equal(card.provider?.id, model.split("/")[0]);
    assert.match(card.title, /does not offer this model right now/);
  });

  it("other failures are not remembered against the provider", async () => {
    const { c, card } = await failWith({ type: "provider.rate-limit", message: "slow down", status: 429 });
    assert.ok(!card.actions.includes("reauth"));
    assert.equal(card.provider, undefined);
    assert.equal(c.providerErrors.size, 0);
  });

  it("builds the panel from OpenCode's lists and the remembered errors", async () => {
    const { c, client } = await failWith({
      type: "provider.no-route",
      message: "Model unavailable: vast/qwen",
    });
    client.integrations = [
      integration({
        id: "vast",
        name: "Vast",
        methods: [{ type: "key" }],
        connections: [{ type: "credential", id: "cred_v", method: "key" }],
      }),
      integration(OPENAI),
    ];
    const view = await c.providersView();
    assert.deepEqual(
      view.connected.map((r) => [r.id, r.state, r.models]),
      [
        ["vast", "error", 1],
        ["opencode-go", "connected", 1],
      ],
    );
    assert.deepEqual(
      view.available.map((x) => x.id),
      ["openai"],
    );
  });

  it("a successful sign-in forgets the error and reloads the catalog", async () => {
    const { c, client } = await failWith({ type: "provider.auth", message: "expired", status: 401 });
    client.integrations = [
      integration({
        id: "vast",
        name: "Vast",
        methods: [{ type: "key" }],
        connections: [{ type: "credential", id: "cred_v", method: "key" }],
      }),
    ];
    const before = client.callsTo("listModels").length;
    let name = "";
    const out = await c.connectProvider("vast", fakeUi({ key: "new" }).ui, true, (n) => (name = n));
    assert.deepEqual(out, { kind: "connected" });
    assert.equal(name, "Vast");
    assert.equal(c.providerErrors.has("vast"), false);
    assert.ok(client.callsTo("listModels").length > before);
  });

  it("an unknown provider fails without asking anything", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    const { ui, asked } = fakeUi({});
    const out = await c.connectProvider("nope", ui);
    assert.equal(out.kind, "failed");
    assert.deepEqual(asked, []);
  });

  it("disconnect removes the stored credentials only; reload asks OpenCode to rebuild", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.integrations = [
      integration({
        ...OPENAI,
        connections: [
          { type: "credential", id: "cred_1", method: "key" },
          { type: "credential", id: "cred_2", method: "oauth" },
          { type: "env", name: "OPENAI_API_KEY" },
        ],
      }),
    ];
    assert.equal(await c.disconnectProvider("openai"), 2);
    assert.deepEqual(
      client.callsTo("removeCredential").map((x) => x.args[0]),
      ["cred_1", "cred_2"],
    );
    await c.reloadConfig();
    assert.equal(client.callsTo("reloadConfig").length, 1);
  });
});

describe("running the CLI on Windows", () => {
  it("runs an npm command script through cmd.exe, quoted", () => {
    const exe = "C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\opencode.cmd";
    assert.deepEqual(cliInvocation(exe, ["service", "start"], "win32", "C:\\Windows\\system32\\cmd.exe"), {
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${exe}" "service" "start""`],
      verbatim: true,
    });
    assert.deepEqual(cliInvocation("C:\\bin\\opencode.exe", ["--version"], "win32"), {
      file: "C:\\bin\\opencode.exe",
      args: ["--version"],
      verbatim: false,
    });
    assert.equal(cliInvocation("/usr/bin/opencode.cmd", ["x"], "linux").file, "/usr/bin/opencode.cmd");
  });
});

describe("provider messages from the webview", () => {
  it("accepts provider ids and nothing else", () => {
    for (const m of [
      { type: "loadProviders" },
      { type: "providerConnect", id: "amazon-bedrock" },
      { type: "providerReauth", id: "302ai" },
      { type: "providerDisconnect", id: "github-copilot" },
      { type: "reloadProviders" },
      { type: "checkSetup" },
    ])
      assert.ok(parseWebviewMessage(m), JSON.stringify(m));
    for (const m of [
      { type: "providerConnect" },
      { type: "providerConnect", id: "" },
      { type: "providerConnect", id: "a b" },
      { type: "providerConnect", id: "x".repeat(201) },
      { type: "providerReauth", id: "openai", key: "sk-1" },
      { type: "providerDisconnect", id: 3 },
    ])
      assert.equal(parseWebviewMessage(m), undefined, JSON.stringify(m));
  });
});

describe("the HTTP client's provider calls", () => {
  function fakeFetch(answer: (method: string, path: string, body: unknown) => Response) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", url, body });
      return answer(init?.method ?? "GET", new URL(url).pathname, body);
    }) as typeof fetch;
    return { fn, calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("sends the key, questions and code in OpenCode's shapes, scoped to the folder", async () => {
    const { fn, calls } = fakeFetch((method, p) =>
      p.endsWith("/connect/oauth") && method === "POST"
        ? json({
            location: { directory: "C:\\r" },
            data: {
              attemptID: "att_9",
              url: "https://github.com/login/device",
              instructions: "Enter code 1234-ABCD",
              mode: "auto",
              time: { created: 1, expires: 900_000 },
            },
          })
        : p.includes("/connect/oauth/att_9") && method === "GET"
          ? json({
              location: { directory: "C:\\r" },
              data: { status: "failed", message: "denied", time: { created: 1, expires: 2 } },
            })
          : new Response(null, { status: 204 }),
    );
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:1" }, fn);
    await c.connectKey("c:\\r", "openai", "sk-1");
    const a = await c.startOAuth("c:\\r", "github-copilot", "device", { deploymentType: "github.com" });
    assert.deepEqual(a, {
      attemptID: "att_9",
      url: "https://github.com/login/device",
      instructions: "Enter code 1234-ABCD",
      mode: "auto",
      paste: false,
      expires: 900_000,
    });
    assert.deepEqual(await c.oauthStatus("c:\\r", "github-copilot", "att_9"), {
      status: "failed",
      message: "denied",
    });
    await c.completeOAuth("c:\\r", "openai", "att_9", "xyz");
    await c.connectExternal("c:\\r", "amazon-bedrock", "aws-profile", { profile: "dev" });
    await c.removeCredential("cred 1");
    assert.deepEqual(
      calls.map((x) => [x.method, decodeURIComponent(x.url.replace("http://127.0.0.1:1", "")), x.body]),
      [
        ["POST", "/api/integration/openai/connect/key?location[directory]=C:\\r", { key: "sk-1" }],
        [
          "POST",
          "/api/integration/github-copilot/connect/oauth?location[directory]=C:\\r",
          { methodID: "device", answer: { deploymentType: "github.com" } },
        ],
        ["GET", "/api/integration/github-copilot/connect/oauth/att_9?location[directory]=C:\\r", undefined],
        [
          "POST",
          "/api/integration/openai/connect/oauth/att_9/complete?location[directory]=C:\\r",
          { code: "xyz" },
        ],
        [
          "POST",
          "/api/integration/amazon-bedrock/connect/external?location[directory]=C:\\r",
          { methodID: "aws-profile", answer: { profile: "dev" } },
        ],
        ["DELETE", "/api/credential/cred 1", undefined],
      ],
    );
  });

  it("tries a reload again while OpenCode still has a deleted folder loaded", async () => {
    let n = 0;
    const gone = () =>
      json(
        {
          _tag: "ServiceUnavailableError",
          message: "FileSystem.DirectoryNotFoundError: Directory not found: C:\\tmp\\x",
          service: "location",
        },
        503,
      );
    const { fn, calls } = fakeFetch(() => (++n <= 2 ? gone() : new Response(null, { status: 204 })));
    await new HttpOpenCodeClient({ url: "http://127.0.0.1:1" }, fn).reloadConfig();
    assert.equal(calls.length, 3);
    const other = fakeFetch(() => json({ _tag: "ServiceUnavailableError", message: "busy" }, 503));
    await assert.rejects(
      new HttpOpenCodeClient({ url: "http://127.0.0.1:1" }, other.fn).reloadConfig(),
      /busy/,
    );
    assert.equal(other.calls.length, 1);
    const always = fakeFetch(gone);
    await assert.rejects(
      new HttpOpenCodeClient({ url: "http://127.0.0.1:1" }, always.fn).reloadConfig(),
      /Directory not found/,
    );
    assert.equal(always.calls.length, 5);
  });
});
