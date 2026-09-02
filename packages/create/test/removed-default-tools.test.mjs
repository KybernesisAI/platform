import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repairRemovedDefaultTools, scopeHasSandboxTools } from "../dist/removed-default-tools.js";

const DISABLE = 'import { disableTool } from "eve/tools";\nexport default disableTool();\n';

function agent(cwd, scope, files = {}) {
  const dir = scope === "." ? join(cwd, "agent") : join(cwd, "agent/subagents", scope);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "agent.ts"), "export default {}");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "tools", name), content);
  return dir;
}

test("a knowledge scope loses its disable files for tools eve no longer provides, and gets no opt-in", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-removed-tools-"));
  try {
    // Kyber's finance specialist, exactly as authored on 0.38.
    const finance = agent(cwd, "finance", {
      "bash.ts": DISABLE, "read_file.ts": DISABLE, "write_file.ts": DISABLE, "glob.ts": DISABLE, "grep.ts": DISABLE,
    });
    const result = repairRemovedDefaultTools(cwd);

    assert.deepEqual(result.removed.sort(), [
      "agent/subagents/finance/tools/glob.ts",
      "agent/subagents/finance/tools/grep.ts",
    ]);
    assert.deepEqual(result.optedIn, []);
    assert.equal(existsSync(join(finance, "tools/glob.ts")), false);
    // The disables that still mean something are untouched.
    assert.equal(readFileSync(join(finance, "tools/bash.ts"), "utf8"), DISABLE);
    assert.equal(scopeHasSandboxTools(finance), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a sandbox scope is opted back in, once, and an authored file at that path is left alone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-removed-tools-"));
  try {
    const root = agent(cwd, ".");
    const builder = agent(cwd, "builder", { "grep.ts": "export default myOwnGrep;\n" });

    const first = repairRemovedDefaultTools(cwd);
    assert.deepEqual(first.removed, []);
    assert.deepEqual(first.optedIn.sort(), [
      "agent/subagents/builder/tools/glob.ts",
      "agent/tools/glob.ts",
      "agent/tools/grep.ts",
    ]);
    assert.match(readFileSync(join(root, "tools/glob.ts"), "utf8"), /from "eve\/tools\/glob"/);
    assert.equal(readFileSync(join(builder, "tools/grep.ts"), "utf8"), "export default myOwnGrep;\n");

    const second = repairRemovedDefaultTools(cwd);
    assert.deepEqual(second, { removed: [], optedIn: [] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
