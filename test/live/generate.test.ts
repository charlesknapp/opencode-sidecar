// Live tests: OpenCode's stateless generation (POST /api/experimental/generate/text), which
// "Write commit message with OpenCode" uses. They skip without a registered service. The
// model call uses the free model with a tiny prompt and is skipped when the free daily
// limit is reached (OpenCode answers 502 with the provider's 429 as `rate_limit`).
//
//   npm run test:live

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { before, describe, it, type TestContext } from "node:test";
import { buildCommitPrompt, cleanCommitMessage, splitGitDiff } from "../../src/core/commitMessage";
import { HttpOpenCodeClient, OpenCodeHttpError } from "../../src/opencode/client";
import { discoverServer } from "../../src/opencode/service";

const FREE_MODEL = { providerID: "opencode", id: "big-pickle" };

let client: HttpOpenCodeClient | undefined;
let skipReason = "";

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
});

function live(t: TestContext): HttpOpenCodeClient | undefined {
  if (!client) t.skip(skipReason);
  return client;
}

describe("live: stateless generation (commit messages)", () => {
  it("refuses a model OpenCode does not have with ModelNotFoundError (no model call)", async (t) => {
    const c = live(t);
    if (!c) return;
    await assert.rejects(
      () => c.generateText("x", { providerID: "opencode", id: "no-such-model-ocs" }),
      (e: unknown) =>
        e instanceof OpenCodeHttpError &&
        e.status === 404 &&
        e.tag === "ModelNotFoundError" &&
        /no-such-model-ocs/.test(e.message),
    );
  });

  it("writes a commit message for a small diff, or reports the free limit as rate_limit", async (t) => {
    const c = live(t);
    if (!c) return;
    // A folder OpenCode has not loaded yet briefly lists no models.
    let models = await c.listModels(process.cwd());
    for (let i = 0; i < 20 && models.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      models = await c.listModels(process.cwd());
    }
    if (!models.some((m) => m.key === `${FREE_MODEL.providerID}/${FREE_MODEL.id}`))
      return t.skip(`${FREE_MODEL.providerID}/${FREE_MODEL.id} is not offered`);
    const prompt = buildCommitPrompt({
      sections: splitGitDiff(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# App\n+# App (beta)\n",
      ),
      recent: ["Docs: install steps", "Fix: a typo"],
      source: "staged",
    });
    let reply: string;
    try {
      reply = await c.generateText(prompt, FREE_MODEL);
    } catch (e) {
      // The shape Sidecar turns into "the model's usage limit is reached".
      if (e instanceof OpenCodeHttpError && e.reason === "rate_limit") {
        assert.equal(e.status, 502);
        assert.equal(e.tag, "ProviderRequestError");
        assert.ok(e.message.length > 0);
        return t.skip("the free model usage limit is reached for today");
      }
      throw e;
    }
    assert.equal(typeof reply, "string");
    const message = cleanCommitMessage(reply);
    assert.ok(message.length > 0, JSON.stringify(reply));
    assert.ok(!message.startsWith("```"));
  });
});
