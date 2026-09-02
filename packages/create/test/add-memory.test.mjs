import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addMemory } from "../dist/add.js";

function agent(withExtension) {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-add-memory-"));
  mkdirSync(join(cwd, "agent"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), "{}");
  if (withExtension) {
    mkdirSync(join(cwd, "agent/extensions"), { recursive: true });
    writeFileSync(join(cwd, "agent/extensions/arcana.ts"), "export default {}");
  }
  return cwd;
}

test("kyb add memory writes an Arcana slot once, and leaves the tools to the extension when it is mounted", () => {
  const withExt = agent(true);
  const without = agent(false);
  const quiet = console.log;
  console.log = () => {};
  try {
    addMemory(withExt);
    const slot = readFileSync(join(withExt, "agent/memory/arcana.ts"), "utf8");
    assert.match(slot, /from "@kybernesis\/arcana\/memory"/);
    assert.match(slot, /scope: byPrincipal/);
    assert.match(slot, /tools: false/);
    assert.match(slot, /ARCANA_COMPANY_WORKSPACE/);

    writeFileSync(join(withExt, "agent/memory/arcana.ts"), "authored");
    addMemory(withExt);
    assert.equal(readFileSync(join(withExt, "agent/memory/arcana.ts"), "utf8"), "authored");

    addMemory(without);
    assert.doesNotMatch(readFileSync(join(without, "agent/memory/arcana.ts"), "utf8"), /tools: false/);

    // eve allows agent/memory.ts OR agent/memory/*.ts, never both.
    const single = agent(false);
    writeFileSync(join(single, "agent/memory.ts"), "export default {}");
    addMemory(single);
    assert.equal(existsSync(join(single, "agent/memory/arcana.ts")), false);
    rmSync(single, { recursive: true, force: true });
  } finally {
    console.log = quiet;
    rmSync(withExt, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});
