import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_SUBSCRIPTION_MAX_OUTPUT_TOKENS,
  claudeSubscription,
  withDefaultMaxOutputTokens,
} from "../dist/claude.js";

/**
 * A subscription is a shared per-minute output budget. Without a cap the
 * provider asks for the model's maximum on every call (max_tokens 128000 on
 * claude-opus-5), and the subscription agent is the first thing to fail under
 * load. These pin the default, the override, and the opt-out (KYB-530).
 */

/** A provider whose models record the call options they receive. */
function recordingProvider(calls) {
  return () => (modelId) => ({
    specificationVersion: "v3",
    provider: "anthropic",
    modelId,
    async doGenerate(options) {
      calls.push({ kind: "generate", options });
      return { content: [] };
    },
    async doStream(options) {
      calls.push({ kind: "stream", options });
      return { stream: null };
    },
  });
}

test("AC1: a call that sets no cap carries the default", async () => {
  const calls = [];
  const model = claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls) });
  await model.doGenerate({ prompt: [] });
  await model.doStream({ prompt: [] });
  assert.equal(CLAUDE_SUBSCRIPTION_MAX_OUTPUT_TOKENS, 16_000);
  assert.equal(calls[0].options.maxOutputTokens, 16_000);
  assert.equal(calls[1].options.maxOutputTokens, 16_000);
  // Everything else on the model is untouched.
  assert.equal(model.modelId, "claude-opus-5");
  assert.equal(model.specificationVersion, "v3");
});

test("AC2: a per-call value wins over the default", async () => {
  const calls = [];
  const model = claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls) });
  await model.doGenerate({ prompt: [], maxOutputTokens: 900 });
  assert.equal(calls[0].options.maxOutputTokens, 900);
});

test("the option overrides the default for every call", async () => {
  const calls = [];
  const model = claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls), maxOutputTokens: 4_000 });
  await model.doGenerate({ prompt: [] });
  assert.equal(calls[0].options.maxOutputTokens, 4_000);
});

test("AC3: maxOutputTokens: false leaves the call without a cap from us", async () => {
  const calls = [];
  const model = claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls), maxOutputTokens: false });
  await model.doGenerate({ prompt: [] });
  assert.equal(calls[0].options.maxOutputTokens, undefined);
});

test("the wrapper is generic: a model with no call methods passes through unchanged in shape", () => {
  const plain = { modelId: "x", specificationVersion: "v3" };
  const wrapped = withDefaultMaxOutputTokens(plain, 10);
  assert.deepEqual({ ...wrapped }, plain);
});
