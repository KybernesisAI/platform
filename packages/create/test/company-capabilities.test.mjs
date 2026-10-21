import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINEER_EXTENSION_PINS } from "../dist/capabilities.js";
import { wireArpAuth } from "../dist/init.js";
import {
  builderArcanaTs,
  builderInstructionsMd,
  dispatchEveChannelTs,
  dispatchPeersTs,
  engineerPlan,
} from "../dist/templates.js";

test("the dispatch door admits people, granted agents and the local runner", () => {
  const channel = dispatchEveChannelTs();
  assert.match(channel, /export default dispatchChannel\(\{\n\s+governed: \{/);
  assert.match(channel, /kybernesisAuth\(\{/);
  assert.match(channel, /localDev\(\),\n\s+\],/);
  assert.match(channel, /agent: process\.env\.KYBERNESIS_AGENT!/);
  // The identity item's auth slots into the same walk.
  const withArp = wireArpAuth(channel);
  assert.ok(withArp);
  assert.match(withArp, /arpAuth\(\),\n\s+kybernesisAuth\(/);
  assert.match(dispatchPeersTs(), /^export default governedPeers\(\);$/m);
});

test("the builder is a declared subagent with its own instructions and the company brain", () => {
  for (const host of ["exe", "vercel"]) {
    const paths = engineerPlan(host, { reach: "default", model: "model" }).files.map((file) => file.path);
    for (const path of [
      "agent/subagents/builder/agent.ts",
      "agent/subagents/builder/instructions.md",
      "agent/subagents/builder/connections/arcana.ts",
      "agent/subagents/builder/extensions/engineer.ts",
      "agent/subagents/builder/sandbox/sandbox.ts",
      "agent/tools/deliver.ts",
    ]) {
      assert.ok(paths.includes(path), `${host}: ${path}`);
    }
  }
  const arcana = builderArcanaTs();
  assert.match(arcana, /ARCANA_BUILDER_WORKSPACE \?\? process\.env\.ARCANA_COMPANY_WORKSPACE/);
  assert.match(arcana, /"X-Kyberagent-Agent": async \(\) => workspace/);
});

test("agent-facing builder text names no agent and uses no em dashes", () => {
  const text = builderInstructionsMd();
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b(Kyber|Sid|Ava|Foreman|Kybernesis)\b/);
});

test("the engineer pins the third-party extensions to releases the certified eve accepts", () => {
  assert.deepEqual([...ENGINEER_EXTENSION_PINS], ["@github-tools/eve-extension@0.8.1"]);
});
