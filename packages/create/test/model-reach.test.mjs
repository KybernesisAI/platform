import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseEveInfoInspection } from "../dist/agent-limits.js";
import { modelReachDoctorCheck } from "../dist/doctor.js";
import {
  CLAUDE_SUBSCRIPTION_MODEL,
  classifyModelReach,
  resolveModelReach,
  resolveModelScaffold,
} from "../dist/model-reach.js";
import {
  engineerPlan,
  envExample,
  hostAgentTs,
  hostSteps,
  subagentAgentTs,
} from "../dist/templates.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const defaultExe = { reach: "default", model: "anthropic/claude-sonnet-5" };
const claudeSub = { reach: "claude-sub", model: CLAUDE_SUBSCRIPTION_MODEL };

function compiledRouting(routing) {
  return parseEveInfoInspection(
    JSON.stringify({
      status: "ready",
      diagnostics: { errors: 0, warnings: 0 },
      artifacts: { compiledManifest: "/compiled/manifest.json" },
    }),
    () => JSON.stringify({ config: { model: { routing } } }),
  ).modelRouting;
}

test("model reach resolves CLI over Factory env and preserves the existing default", () => {
  assert.equal(resolveModelReach(undefined, undefined), "default");
  assert.equal(resolveModelReach(undefined, "claude-sub"), "claude-sub");
  assert.equal(resolveModelReach("claude-sub", "unsupported-factory-value"), "claude-sub");
  assert.throws(() => resolveModelReach("gateway", undefined), /Unsupported model reach/);
  assert.throws(() => resolveModelReach("", "claude-sub"), /Unsupported model reach/);
});

test("claude-sub is exe-only, normalizes the known gateway prefix, and rejects uncertified models", () => {
  assert.deepEqual(resolveModelScaffold({ host: "exe", cliReach: "claude-sub" }), claudeSub);
  assert.deepEqual(
    resolveModelScaffold({ host: "exe", envReach: "claude-sub", model: "anthropic/claude-opus-5" }),
    claudeSub,
  );
  assert.throws(
    () => resolveModelScaffold({ host: "vercel", cliReach: "claude-sub" }),
    /requires --host=exe/,
  );
  assert.throws(
    () => resolveModelScaffold({ host: "exe", cliReach: "claude-sub", model: "claude-sonnet-5" }),
    /certified context-window constant/,
  );
});

test("subscription templates route root, departments, and builder through the same provider shape", () => {
  const sources = [
    hostAgentTs("exe", claudeSub),
    subagentAgentTs("finance", "exe", claudeSub),
    engineerPlan("exe", claudeSub).files.find((file) => file.path === "agent/subagents/builder/agent.ts").content,
  ];
  for (const source of sources) {
    assert.match(source, /createAnthropic/);
    assert.match(source, /claudeSubscription\(\{ model: "claude-opus-5", createAnthropic \}\)/);
    assert.match(source, /CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW/);
    assert.doesNotMatch(source, /exeModel/);
    assert.doesNotMatch(source, /EXE_MODEL/);
    assert.doesNotMatch(source, /anthropic\/claude-opus-5/);
  }
});

test("ordinary exe and Vercel templates retain their existing route shapes", () => {
  const exe = hostAgentTs("exe", defaultExe);
  const vercel = hostAgentTs("vercel", { reach: "default", model: "openai/gpt-5.4" });
  assert.match(exe, /exeModel\(\{ model: process\.env\.EXE_MODEL/);
  assert.match(exe, /modelContextWindowTokens: 200_000/);
  assert.match(vercel, /model: "openai\/gpt-5.4"/);
  assert.doesNotMatch(vercel, /@kybernesis\/exe/);
});

test("subscription env and host steps omit gateway configuration and explain the proxy", () => {
  const subscriptionEnv = envExample("acme", [], "https://issuer.example", [], "exe", claudeSub);
  const ordinaryEnv = envExample("acme", [], "https://issuer.example", [], "exe", defaultExe);
  assert.doesNotMatch(subscriptionEnv, /^EXE_MODEL=/m);
  assert.match(subscriptionEnv, /^EXE_VM_NAME="acme"$/m);
  assert.match(ordinaryEnv, /^EXE_MODEL="anthropic\/claude-sonnet-5"$/m);

  const subscriptionSteps = hostSteps("exe", "acme", claudeSub).join("\n");
  assert.match(subscriptionSteps, /claude-subscription\.sh up/);
  assert.match(subscriptionSteps, /claude-subscription\.sh login/);
  assert.match(subscriptionSteps, /claude-subscription\.sh status/);
  assert.doesNotMatch(subscriptionSteps, /integrations edit llm/);
});

test("doctor uses authored helpers first and Eve routing only for generic routes", () => {
  assert.deepEqual(
    classifyModelReach("model: claudeSubscription({ model, createAnthropic })", { kind: "external", provider: "anthropic" }),
    { kind: "claude-sub" },
  );
  assert.deepEqual(
    classifyModelReach("model: exeModel({ model, createOpenAI })", { kind: "external", provider: "openai" }),
    { kind: "exe" },
  );
  assert.deepEqual(classifyModelReach(null, compiledRouting({ kind: "gateway", target: "anthropic" })), {
    kind: "gateway",
  });
  assert.deepEqual(classifyModelReach(null, compiledRouting({ kind: "external", provider: "anthropic" })), {
    kind: "direct-provider",
    provider: "anthropic",
  });
  assert.match(modelReachDoctorCheck(null, { kind: "unresolved", reason: "no manifest" }).label, /unresolved/);
});

test("invalid reaches and incompatible hosts fail before eve scaffolding starts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-model-reach-invalid-"));
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "init", "should-not-exist", "--host=vercel", "--model-reach=claude-sub", "--yes"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --host=exe/);
    assert.equal(result.stdout.includes("Scaffolding eve agent"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("init help documents the flag, Factory env, bare model rule, and proxy route", () => {
  const result = spawnSync(process.execPath, [cli, "init", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--model-reach=<reach>/);
  assert.match(result.stdout, /KYB_MODEL_REACH=claude-sub/);
  assert.match(result.stdout, /bare claude-opus-5/);
  assert.match(result.stdout, /loopback OAuth proxy/);
});
