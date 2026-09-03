import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION,
  parseEveInfoInspection,
} from "../dist/agent-limits.js";
import { agentInputLimitDoctorCheck } from "../dist/doctor.js";
import { hostAgentTs } from "../dist/templates.js";
import { agentInputLimitUpgradeMessage } from "../dist/upgrade.js";

function inspect(config) {
  return parseEveInfoInspection(
    JSON.stringify({
      status: "ready",
      diagnostics: { errors: 0, warnings: 2 },
      artifacts: { compiledManifest: "/compiled/manifest.json" },
    }),
    () => JSON.stringify({ config }),
  );
}

test("the compiled root manifest classifies explicit numeric and uncapped policies", () => {
  assert.deepEqual(inspect({ limits: { maxInputTokensPerSession: 12_345 } }).limit, {
    kind: "explicit-numeric",
    value: 12_345,
  });
  assert.deepEqual(inspect({ limits: { maxInputTokensPerSession: false } }).limit, {
    kind: "explicit-uncapped",
  });
});

test("the certified 40M fallback applies only when the compiled root field is omitted", () => {
  assert.deepEqual(inspect({}).limit, {
    kind: "inherited",
    value: CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION,
  });
  assert.deepEqual(inspect({ limits: {} }).limit, {
    kind: "inherited",
    value: CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION,
  });
  assert.equal(inspect({ limits: { maxInputTokensPerSession: null } }).limit.kind, "unresolved");
});

test("missing or unreadable structured artifacts remain unresolved rather than guessed", () => {
  const missing = parseEveInfoInspection(JSON.stringify({ status: "failed", diagnostics: null, artifacts: null }));
  assert.equal(missing.limit.kind, "unresolved");
  assert.match(missing.limit.reason, /manifest path/);

  const unreadable = parseEveInfoInspection(
    JSON.stringify({ artifacts: { compiledManifest: "/gone" } }),
    () => { throw new Error("ENOENT"); },
  );
  assert.equal(unreadable.limit.kind, "unresolved");
  assert.match(unreadable.limit.reason, /ENOENT/);
});

test("doctor reports numeric, uncapped, inherited and unresolved ceilings distinctly", () => {
  assert.deepEqual(agentInputLimitDoctorCheck({ kind: "explicit-numeric", value: 1_000 }), {
    verdict: "pass",
    label: "Eve max input tokens/session: 1,000 (explicit)",
  });
  assert.match(agentInputLimitDoctorCheck({ kind: "explicit-uncapped" }).label, /uncapped \(explicit\)/);

  const inherited = agentInputLimitDoctorCheck({ kind: "inherited", value: 40_000_000 });
  assert.equal(inherited.verdict, "warn");
  assert.match(inherited.label, /40,000,000 \(inherited default\)/);
  assert.match(inherited.detail, /set limits\.maxInputTokensPerSession explicitly/);

  const unresolved = agentInputLimitDoctorCheck({ kind: "unresolved", reason: "no artifact" });
  assert.equal(unresolved.verdict, "warn");
  assert.match(unresolved.label, /unresolved/);
  assert.equal(unresolved.detail, "no artifact");
});

test("new exe agents author an explicit uncapped policy while metered hosts stay unchanged", () => {
  const exe = hostAgentTs("exe", { reach: "default", model: "openai/gpt-5.4" });
  const vercel = hostAgentTs("vercel", { reach: "default", model: "openai/gpt-5.4" });
  assert.match(exe, /limits: \{ maxInputTokensPerSession: false \}/);
  assert.match(exe, /long-lived self-hosted process/);
  assert.doesNotMatch(vercel, /maxInputTokensPerSession/);
});

test("upgrade reports inheritance read-only and preserves explicit classifications", () => {
  assert.match(
    agentInputLimitUpgradeMessage({ kind: "inherited", value: 40_000_000 }),
    /40,000,000 inherited.*will not rewrite authored source/,
  );
  assert.match(
    agentInputLimitUpgradeMessage({ kind: "explicit-numeric", value: 9_000 }),
    /9,000 \(explicit; unchanged\)/,
  );
  assert.match(
    agentInputLimitUpgradeMessage({ kind: "explicit-uncapped" }),
    /uncapped \(explicit; unchanged\)/,
  );
});
