import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  repairTerminalSandboxCleanupHooks,
  sandboxCleanupScaffoldFiles,
  terminalSandboxCleanupHookTs,
} from "../dist/sandbox-cleanup.js";
import { engineerPlan } from "../dist/templates.js";

const managed = terminalSandboxCleanupHookTs();

test("exe scaffolds include root and every requested local subagent hook", () => {
  assert.deepEqual(
    sandboxCleanupScaffoldFiles("exe", ["sales", "support"]).map((file) => file.path),
    [
      "agent/hooks/sandbox-cleanup.ts",
      "agent/subagents/sales/hooks/sandbox-cleanup.ts",
      "agent/subagents/support/hooks/sandbox-cleanup.ts",
    ],
  );
  assert.deepEqual(sandboxCleanupScaffoldFiles("vercel", ["sales"]), []);
});

test("the exe engineer builder gets the hook without adding exe to Vercel", () => {
  const exe = engineerPlan("exe", { reach: "default", model: "model" });
  const vercel = engineerPlan("vercel", { reach: "default", model: "model" });
  assert.equal(exe.files.find((file) => file.path === "agent/subagents/builder/hooks/sandbox-cleanup.ts")?.content, managed);
  assert.equal(vercel.files.some((file) => file.path.includes("sandbox-cleanup")), false);
  assert.equal(vercel.deps.includes("@kybernesis/exe"), false);
});

test("upgrade repairs missing root and discovered local hooks idempotently", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-cleanup-"));
  try {
    mkdirSync(join(cwd, "agent/subagents/sales"), { recursive: true });
    mkdirSync(join(cwd, "agent/subagents/group/support"), { recursive: true });
    writeFileSync(join(cwd, "agent/agent.ts"), "root");
    writeFileSync(join(cwd, "agent/subagents/sales/agent.ts"), "sales");
    writeFileSync(join(cwd, "agent/subagents/group/support/agent.ts"), "support");

    // A scope that has switched its sandbox off never gets the hook.
    mkdirSync(join(cwd, "agent/subagents/finance/tools"), { recursive: true });
    writeFileSync(join(cwd, "agent/subagents/finance/agent.ts"), "finance");
    writeFileSync(join(cwd, "agent/subagents/finance/tools/bash.ts"), 'import { disableTool } from "eve/tools";\nexport default disableTool();\n');

    const first = repairTerminalSandboxCleanupHooks(cwd);
    assert.equal(first.length, 3);
    assert.equal(first.some((file) => file.includes("finance")), false);
    for (const file of first) assert.equal(readFileSync(file, "utf8"), managed);
    assert.deepEqual(repairTerminalSandboxCleanupHooks(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("upgrade never overwrites a conflicting authored hook", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-cleanup-collision-"));
  try {
    const hooks = join(cwd, "agent/hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(cwd, "agent/agent.ts"), "root");
    const target = join(hooks, "sandbox-cleanup.ts");
    writeFileSync(target, "export default authoredHook;\n");

    assert.deepEqual(repairTerminalSandboxCleanupHooks(cwd), []);
    assert.equal(readFileSync(target, "utf8"), "export default authoredHook;\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
