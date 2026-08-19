import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSubscription, isLoopbackUrl } from "../dist/claude.js";

/**
 * The loopback rule is a security control, not a preference. The proxy it
 * guards spends someone's paid subscription and asks for no credential of its
 * own, so a URL edited during debugging and left in place is an open gateway to
 * that subscription. A comment cannot enforce that; this can.
 */

/** Stands in for createAnthropic, recording what it was configured with. */
function recordingProvider(calls) {
  return (config) => {
    calls.push(config);
    return (model) => ({ model, config });
  };
}

test("a loopback proxy is accepted, in each spelling", () => {
  for (const baseURL of [
    "http://127.0.0.1:3333/v1",
    "http://localhost:3333/v1",
    "http://[::1]:3333/v1",
  ]) {
    const calls = [];
    claudeSubscription({ model: "claude-opus-5", baseURL, createAnthropic: recordingProvider(calls) });
    assert.equal(calls[0].baseURL, baseURL);
  }
});

test("a proxy on a public address is refused", () => {
  assert.throws(
    () =>
      claudeSubscription({
        model: "claude-opus-5",
        baseURL: "http://203.0.113.10:3333/v1",
        createAnthropic: recordingProvider([]),
      }),
    /not a loopback address/,
  );
});

test("a hostname that merely contains 'localhost' is still refused", () => {
  // localhost.evil.example resolves wherever its owner wants it to.
  assert.equal(isLoopbackUrl("http://localhost.evil.example:3333/v1"), false);
  assert.throws(
    () =>
      claudeSubscription({
        model: "claude-opus-5",
        baseURL: "http://localhost.evil.example:3333/v1",
        createAnthropic: recordingProvider([]),
      }),
    /not a loopback address/,
  );
});

test("the guard can be lifted deliberately, and only deliberately", () => {
  const calls = [];
  const model = claudeSubscription({
    model: "claude-opus-5",
    baseURL: "http://10.0.0.5:3333/v1",
    requireLoopback: false,
    createAnthropic: recordingProvider(calls),
  });
  assert.equal(model.model, "claude-opus-5");
});

test("the API key sent to the SDK is a placeholder, never a real key", () => {
  // A real Anthropic key here would bill metered usage and silently defeat the
  // entire point of running against a subscription.
  const calls = [];
  claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls) });
  assert.equal(calls[0].apiKey, "claude-subscription-local-proxy");
  assert.equal(calls[0].apiKey.startsWith("sk-"), false);
});

test("it defaults to the local proxy", () => {
  const calls = [];
  claudeSubscription({ model: "claude-opus-5", createAnthropic: recordingProvider(calls) });
  assert.equal(calls[0].baseURL, "http://127.0.0.1:3333/v1");
});
