import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CERTIFIED_MAX_INPUT_TOKENS_PER_SESSION,
  formatSessionInputLimit,
  parseEveManifestInspection,
} from "../dist/session-limit.js";
import { hostAgentTs } from "../dist/templates.js";

const info = (path = "/tmp/compiled-manifest.json") => JSON.stringify({
  diagnostics: { errors: 0, warnings: 2 },
  artifacts: { compiledManifest: path },
});

const inspect = (manifest) => parseEveManifestInspection(
  info(),
  "/agent",
  () => JSON.stringify(manifest),
);

test("an explicit numeric session input limit is reported as explicit", () => {
  const result = inspect({ config: { limits: { maxInputTokensPerSession: 12_345 } } });
  assert.deepEqual(result.limit, { status: "verified", source: "explicit", value: 12_345 });
  assert.equal(formatSessionInputLimit(result.limit), "limits.maxInputTokensPerSession = 12,345 (explicit)");
});

test("an omitted limit resolves to the certified Eve 0.49.0 inherited default", () => {
  const result = inspect({ config: {} });
  assert.deepEqual(result.limit, {
    status: "verified",
    source: "inherited",
    value: CERTIFIED_MAX_INPUT_TOKENS_PER_SESSION,
  });
  assert.match(formatSessionInputLimit(result.limit), /40,000,000 \(inherited Eve 0\.49\.0 default\)/);
});

test("false is reported as an explicit uncapped session", () => {
  const result = inspect({ config: { limits: { maxInputTokensPerSession: false } } });
  assert.deepEqual(result.limit, { status: "verified", source: "explicit", value: false });
  assert.equal(formatSessionInputLimit(result.limit), "limits.maxInputTokensPerSession = uncapped (explicit)");
});

test("malformed eve info JSON is unverifiable rather than guessed", () => {
  const result = parseEveManifestInspection("not json", "/agent");
  assert.equal(result.limit.status, "unverifiable");
  assert.match(formatSessionInputLimit(result.limit), /unverifiable/);
});

test("a missing compiled manifest is unverifiable rather than inherited", () => {
  const result = parseEveManifestInspection(info(), "/agent", () => {
    throw new Error("ENOENT");
  });
  assert.equal(result.limit.status, "unverifiable");
  assert.match(result.limit.reason, /ENOENT/);
});

test("exe scaffolds freeze the 40M session cap while Vercel templates remain inherited", () => {
  const exe = hostAgentTs("exe", "openai/gpt-5");
  const vercel = hostAgentTs("vercel", "anthropic/claude-sonnet-5");
  assert.match(exe, /limits: \{ maxInputTokensPerSession: 40_000_000 \}/);
  assert.doesNotMatch(vercel, /maxInputTokensPerSession/);
});
