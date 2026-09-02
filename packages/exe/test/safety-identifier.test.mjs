import assert from "node:assert/strict";
import { test } from "node:test";

import { exeModel } from "../dist/model.js";
import { withoutSafetyIdentifier } from "../dist/grok.js";

/**
 * The gateway rejects OpenAI's `safety_identifier` with HTTP 400, and eve fills
 * it on every call it thinks is bound for OpenAI. Under eve 0.47.7 that failed
 * all eighteen evals on the first run — every turn, before the model saw a
 * token. These guard the two places a call leaves this package.
 */

function fakeProvider(seen) {
  const model = {
    specificationVersion: "v3",
    provider: "openai.responses",
    modelId: "x",
    supportedUrls: {},
    doGenerate: async (o) => {
      seen.push(o);
      return { content: [], finishReason: "stop", usage: {}, warnings: [] };
    },
    doStream: async (o) => {
      seen.push(o);
      return { stream: new ReadableStream({ start(c) { c.close(); } }) };
    },
  };
  return { chat: () => model, responses: () => model };
}

test("exeModel strips eve's safety identifier and forces store:false on every call", async () => {
  const seen = [];
  const model = exeModel({ model: "openai/gpt-5", createOpenAI: () => fakeProvider(seen) });
  const call = { prompt: [], providerOptions: { openai: { safetyIdentifier: "sha256:abc", reasoningEffort: "low" } } };

  await model.doGenerate(call);
  await model.doStream(call);

  assert.equal(seen.length, 2);
  for (const o of seen) {
    assert.equal("safetyIdentifier" in o.providerOptions.openai, false);
    assert.equal(o.providerOptions.openai.store, false);
    // Everything else the harness asked for still reaches the provider.
    assert.equal(o.providerOptions.openai.reasoningEffort, "low");
  }
  // The caller's object is not mutated.
  assert.equal(call.providerOptions.openai.safetyIdentifier, "sha256:abc");
});

test("withoutSafetyIdentifier removes only that field, and leaves non-JSON bodies alone", () => {
  const body = JSON.stringify({ model: "grok-4.6", messages: [], safety_identifier: "sha256:abc", stream: true });
  assert.deepEqual(JSON.parse(withoutSafetyIdentifier(body)), { model: "grok-4.6", messages: [], stream: true });

  const clean = JSON.stringify({ model: "grok-4.6", messages: [] });
  assert.equal(withoutSafetyIdentifier(clean), clean);
  assert.equal(withoutSafetyIdentifier("not json"), "not json");
  assert.equal(withoutSafetyIdentifier(undefined), undefined);
  assert.equal(withoutSafetyIdentifier(null), null);
});
