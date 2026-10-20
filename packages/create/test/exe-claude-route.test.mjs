import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repairExeClaudeRoute, withAnthropicFactory } from "../dist/exe-claude-route.js";

const openaiOnly = `import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { exeModel } from "@kybernesis/exe";

export default defineAgent({
  description: "Builds things.",
  model: exeModel({ model: process.env.EXE_MODEL ?? "anthropic/claude-sonnet-5", createOpenAI }),
});
`;

test("an exeModel call with only createOpenAI gets createAnthropic and its import", () => {
  const next = withAnthropicFactory(openaiOnly);
  assert.match(next, /exeModel\(\{ model: process\.env\.EXE_MODEL \?\? "anthropic\/claude-sonnet-5", createOpenAI, createAnthropic \}\)/);
  assert.match(next, /import \{ createOpenAI \} from "@ai-sdk\/openai";\nimport \{ createAnthropic \} from "@ai-sdk\/anthropic";\n/);
  assert.equal(withAnthropicFactory(next), next);
});

test("calls that already pass createAnthropic, and files without exeModel, are left alone", () => {
  const both = openaiOnly
    .replace('import { createOpenAI } from "@ai-sdk/openai";', 'import { createOpenAI } from "@ai-sdk/openai";\nimport { createAnthropic } from "@ai-sdk/anthropic";')
    .replace("createOpenAI })", "createOpenAI, createAnthropic })");
  assert.equal(withAnthropicFactory(both), both);
  const plain = 'export default defineAgent({ model: "openai/gpt-5" });\n';
  assert.equal(withAnthropicFactory(plain), plain);
});

test("an existing createAnthropic import is not duplicated", () => {
  const imported = openaiOnly.replace('import { exeModel }', 'import { createAnthropic } from "@ai-sdk/anthropic";\nimport { exeModel }');
  const next = withAnthropicFactory(imported);
  assert.equal(next.match(/@ai-sdk\/anthropic/g)?.length, 1);
  assert.match(next, /createOpenAI, createAnthropic \}/);
});

test("the repair walks agent/ and reports what it changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-claude-route-"));
  try {
    mkdirSync(join(dir, "agent/subagents/builder"), { recursive: true });
    writeFileSync(join(dir, "agent/subagents/builder/agent.ts"), openaiOnly);
    writeFileSync(join(dir, "agent/agent.ts"), 'export default {};\n');
    assert.deepEqual(repairExeClaudeRoute(dir), ["agent/subagents/builder/agent.ts"]);
    assert.match(readFileSync(join(dir, "agent/subagents/builder/agent.ts"), "utf8"), /createAnthropic \}/);
    assert.deepEqual(repairExeClaudeRoute(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
