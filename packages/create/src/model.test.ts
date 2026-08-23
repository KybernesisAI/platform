/**
 * Tests for the provider binding — the pure parts.
 *
 * Node's built-in runner, no new dependency: the workspace root already runs
 * `npm run test --workspaces --if-present`, so a package that adds a `test`
 * script joins that without anyone wiring anything.
 *
 * These cover the two things that actually went wrong in the field:
 * detection reading prose instead of imports, and a provider paired with a
 * model it structurally cannot call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProvider } from "./model.js";
import { DEFAULT_MODEL_FOR, hostAgentTs, type ModelProvider } from "./templates.js";

const PROVIDERS: ModelProvider[] = ["openai", "claude", "claude-subscription"];

test("detects each provider from the code it generates", () => {
  for (const p of PROVIDERS) {
    assert.equal(
      detectProvider(hostAgentTs("exe", DEFAULT_MODEL_FOR[p], p)),
      p,
      `round-trip failed for ${p}`,
    );
  }
});

test("does NOT mistake a line comment for a binding", () => {
  // The real case, 2026-08-23: a hand-edited agent.ts on the claude binding
  // documented the upgrade path in a comment. Matching bare identifiers
  // reported it as already on the subscription, so `kyb model` lied about a
  // live agent's billing. Detection reads imports for exactly this reason.
  const src = `import { defineAgent } from "eve";
import { createAnthropic } from "@ai-sdk/anthropic";

// NEXT: swap to claudeSubscription() from @kybernesis/exe to bill a Claude
// plan instead of a metered gateway.
export default defineAgent({ model: anthropic("claude-sonnet-5") });`;
  assert.match(src, /claudeSubscription\(/, "precondition: the comment mentions it");
  assert.equal(detectProvider(src), "claude");
});

test("ignores mentions in block comments too", () => {
  const src = `/* we could use claudeSubscription() or exeModel() later */
import { createAnthropic } from "@ai-sdk/anthropic";
export default defineAgent({ model: anthropic("claude-sonnet-5") });`;
  assert.equal(detectProvider(src), "claude");
});

test("unknown when nothing recognisable is imported", () => {
  assert.equal(detectProvider(`export default defineAgent({ model: "x" });`), "unknown");
});

/** Strip comments, so an assertion is about CODE and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

test("the openai binding is the ONLY one that calls exeModel", () => {
  // exeModel requires a createOpenAI factory and calls /v1/responses. Pairing
  // it with an anthropic model is the defect this command exists to catch.
  //
  // Asserted against comment-stripped source: the claude binding's comment
  // explains why it does NOT use exeModel, and the first version of this test
  // matched that sentence. Same mistake the detector made.
  assert.match(code(hostAgentTs("exe", "gpt-5.6-sol", "openai")), /exeModel\(/);
  assert.doesNotMatch(code(hostAgentTs("exe", "claude-sonnet-5", "claude")), /exeModel\(/);
  assert.doesNotMatch(
    code(hostAgentTs("exe", "claude-opus-5", "claude-subscription")),
    /exeModel\(/,
  );
});

test("no default pairs an anthropic model with the openai binding", () => {
  // The original bug: DEFAULT_MODEL was "anthropic/claude-sonnet-5" while
  // hostAgentTs emitted createOpenAI. Green typecheck, green doctor, 404 on
  // the first turn.
  assert.doesNotMatch(DEFAULT_MODEL_FOR.openai, /anthropic|claude/i);
  assert.match(DEFAULT_MODEL_FOR.claude, /claude/);
  assert.match(DEFAULT_MODEL_FOR["claude-subscription"], /claude/);
});

test("claude-subscription never hardcodes a context window", () => {
  // A wrong window makes eve compact at a fraction of the real limit.
  const src = hostAgentTs("exe", "claude-opus-5", "claude-subscription");
  assert.match(src, /CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW/);
  assert.doesNotMatch(src, /modelContextWindowTokens:\s*\d/);
});
