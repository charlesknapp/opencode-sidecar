import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthMarkdown, healthReport, overall, type HealthInput } from "../src/core/healthCheck";
import { parseIntegration, type IntegrationInfo } from "../src/core/providers";
import type { ModelOption } from "../src/shared/model";

const model = (providerID: string, id: string, contextLimit: number | null): ModelOption => ({
  key: `${providerID}/${id}`,
  providerID,
  id,
  name: id,
  providerName: providerID,
  contextLimit,
  variants: [],
});

const integration = (raw: unknown) => parseIntegration(raw) as IntegrationInfo;

/** A healthy Windows setup like the one OpenCode 2.4.2 runs on here. */
function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    platform: "win32",
    cli: { found: true, path: "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd", source: "PATH" },
    cliVersion: "2.4.2",
    service: { url: "http://127.0.0.1:28894", pid: 21132 },
    serverSetting: "",
    server: { url: "http://127.0.0.1:28894", version: "2.4.2", pid: 21132 },
    folder: { path: "c:\\work\\repo", sent: "C:\\work\\repo" },
    projectID: "prj_1",
    account: { opencode: "none", otherProviders: false },
    integrations: [
      integration({ id: "opencode", name: "OpenCode", methods: [{ type: "key" }], connections: [] }),
    ],
    providers: [
      {
        id: "opencode",
        name: "OpenCode",
        integrationID: "opencode",
        activation: "enabled",
        localEndpoint: null,
      },
    ],
    models: [model("opencode", "big-pickle", 200_000)],
    defaultModel: "opencode/big-pickle",
    providerErrors: new Map(),
    pathDirs: ["C:\\Windows", "C:\\Users\\me\\AppData\\Roaming\\npm\\"],
    ...over,
  };
}

const texts = (i: HealthInput) =>
  healthReport(i)
    .flatMap((s) => s.checks)
    .map((c) => `${c.level} ${c.text}`);

describe("setup check", () => {
  it("reports a working setup section by section", () => {
    const sections = healthReport(input());
    assert.deepEqual(
      sections.map((s) => s.title),
      ["OpenCode program", "Background service", "Sign-in and models", "Providers", "Windows"],
    );
    assert.equal(overall(sections), "ok");
    const all = texts(input());
    assert.ok(all.includes("ok Version 2.4.2"));
    assert.ok(all.includes("ok Process 21132 matches the registration"));
    assert.ok(all.includes("ok Default model `opencode/big-pickle` is available"));
    assert.ok(all.includes("ok The opencode folder is on PATH"), "a trailing separator still matches");
    assert.ok(all.includes("ok Drive letter upper-cased for OpenCode: `c:\\work\\repo` → `C:\\work\\repo`"));
    assert.ok(all.some((t) => t.startsWith("info opencode is an npm command script")));
    const md = healthMarkdown(sections, { when: new Date(Date.UTC(2026, 10, 26, 9, 5)), sidecar: "0.1.7" });
    assert.match(
      md,
      /^# OpenCode setup check\n\n✅ Everything looks fine\.\n\nSidecar 0\.1\.7 · 2026-11-26 09:05 UTC\n/,
    );
    assert.match(md, /## Windows\n\n- ✅ The opencode folder is on PATH/);
  });

  it("explains a missing program and stops there for the version", () => {
    const all = texts(
      input({ cli: { found: false, searched: ["a", "b"], configuredInvalid: false }, cliVersion: null }),
    );
    assert.ok(all[0].startsWith("error The opencode program was not found."));
    assert.ok(!all.some((t) => t.includes("Version")));
    const bad = healthReport(input({ cli: { found: false, searched: ["x"], configuredInvalid: true } }));
    assert.match(bad[0].checks[0].hint ?? "", /executablePath/);
  });

  it("flags a stale registration, an unreachable service and mismatched versions", () => {
    assert.ok(
      texts(input({ server: { url: "http://127.0.0.1:28894", version: "2.4.2", pid: 999 } })).includes(
        "error A different process (999) answers than the one registered (21132).",
      ),
    );
    const down = texts(input({ server: null, serverError: "fetch failed", account: null, models: null }));
    assert.ok(down.includes("error OpenCode did not answer."));
    assert.ok(down.includes("info Not checked: OpenCode is not reachable."));
    assert.ok(
      texts(input({ service: null, server: null })).includes(
        "error No OpenCode background service is registered.",
      ),
    );
    assert.ok(
      texts(input({ cliVersion: "2.5.0" })).some((t) =>
        t.startsWith("warn The service runs 2.4.2 but the program is 2.5.0."),
      ),
    );
    assert.ok(
      texts(input({ serverSetting: "http://127.0.0.1:4096" }))[2].startsWith("info Using the server set"),
    );
  });

  it("checks sign-in, models and the default model", () => {
    assert.ok(texts(input({ models: [] })).some((t) => t.startsWith("error OpenCode offers no models")));
    assert.ok(
      texts(input({ defaultModel: "anthropic/claude-gone" })).includes(
        "error The default model `anthropic/claude-gone` is not available.",
      ),
    );
    assert.ok(
      texts(input({ account: { opencode: "needs-auth", otherProviders: false } })).includes(
        "warn The OpenCode account sign-in has expired.",
      ),
    );
  });

  it("lists providers that need a sign-in or whose last run failed", () => {
    const all = texts(
      input({
        integrations: [
          integration({
            id: "openai",
            name: "OpenAI",
            methods: [{ type: "key" }],
            connections: [
              {
                type: "credential",
                id: "c",
                method: "oauth",
                status: { status: "needs_auth", message: "Expired" },
              },
            ],
          }),
          integration({
            id: "anthropic",
            name: "Anthropic",
            methods: [{ type: "key" }],
            connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }],
          }),
        ],
        providerErrors: new Map([
          ["anthropic", "Anthropic rejected the credentials."],
          ["opencode", "OpenCode does not offer this model right now."],
        ]),
      }),
    );
    assert.ok(all.includes("warn OpenAI: needs signing in again."));
    assert.ok(all.includes("warn Anthropic: the last run failed."));
    assert.ok(all.includes("warn opencode: the last run failed."), "a provider without a connection too");
  });

  it("warns when a local model's context is too small for OpenCode, or not reported", () => {
    const sections = healthReport(
      input({
        providers: [
          {
            id: "ollama",
            name: "Ollama",
            integrationID: null,
            activation: "auto",
            localEndpoint: "localhost:11434",
          },
          {
            id: "lmstudio",
            name: "LM Studio",
            integrationID: "lmstudio",
            activation: "auto",
            localEndpoint: "127.0.0.1:1234",
          },
        ],
        models: [
          model("ollama", "llama3", 4096),
          model("ollama", "qwen-big", 32_768),
          model("lmstudio", "gemma", null),
        ],
        defaultModel: "ollama/qwen-big",
      }),
    );
    const checks = sections.find((s) => s.title === "Providers")!.checks;
    const t = checks.map((c) => `${c.level} ${c.text}`);
    assert.ok(t.includes("info Ollama runs on this machine (localhost:11434), 2 models."));
    assert.ok(t.includes("warn Ollama · llama3: a 4,096-token context is too small for OpenCode."));
    assert.ok(!t.some((x) => x.includes("qwen-big")), "32k is enough");
    assert.ok(t.includes("warn LM Studio: gemma reports no context size."));
    assert.match(checks.find((c) => c.text.includes("llama3"))!.hint ?? "", /num_ctx/);
    assert.equal(overall(sections), "warn");
  });

  it("checks the drive letter and the folder's project on Windows only", () => {
    assert.ok(
      texts(input({ folder: { path: "c:\\r", sent: "c:\\r" } })).some((t) =>
        t.startsWith("error The folder is sent as"),
      ),
    );
    assert.ok(
      texts(input({ projectID: null })).includes("warn OpenCode has no project for this folder yet."),
    );
    assert.ok(
      texts(input({ pathDirs: ["C:\\Windows"] })).includes("warn The opencode folder is not on PATH."),
    );
    assert.ok(!healthReport(input({ platform: "linux" })).some((s) => s.title === "Windows"));
  });

  it("counts what to look at in the summary", () => {
    const md = healthMarkdown(healthReport(input({ models: [], projectID: null })), {
      when: new Date(0),
      sidecar: "x",
    });
    assert.match(md, /❌ 2 things to look at\./);
    assert.match(
      md,
      /- ❌ OpenCode offers no models for this folder\.\n {2}Connect a provider in the Providers panel\./,
    );
  });
});
