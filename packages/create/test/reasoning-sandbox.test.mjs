import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { reasoningSandboxLibTs, reasoningSandboxReexportTs } from "../dist/templates.js";
import { reasoningSubagentsNeedingSandbox, writeReasoningSandboxes } from "../dist/upgrade.js";

function agent() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-reasoning-"));
  const sub = (name, { disable = true, sandbox = false, tools = true } = {}) => {
    const d = join(dir, "agent/subagents", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "agent.ts"), "export default {};\n");
    if (tools) {
      mkdirSync(join(d, "tools"), { recursive: true });
      for (const t of ["bash", "read_file", "write_file"]) {
        writeFileSync(join(d, "tools", `${t}.ts`), disable ? 'import { disableTool } from "eve/tools";\nexport default disableTool();\n' : "export default {};\n");
      }
    }
    if (sandbox) writeFileSync(join(d, "sandbox.ts"), "export default {};\n");
  };
  return { dir, sub, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("only reasoning-only subagents without a sandbox are selected", () => {
  const a = agent();
  try {
    a.sub("finance");                                   // disables all three, no sandbox → yes
    a.sub("strategy");                                  // → yes
    a.sub("builder", { disable: false, sandbox: true });// keeps tools + own sandbox → no
    a.sub("researcher", { disable: false });            // tools enabled → no
    a.sub("legal", { sandbox: true });                  // reasoning but already has a sandbox → no
    assert.deepEqual(reasoningSubagentsNeedingSandbox(a.dir), ["finance", "strategy"]);
  } finally {
    a.cleanup();
  }
});

test("no agent/subagents dir yields nothing, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-empty-"));
  try {
    assert.deepEqual(reasoningSubagentsNeedingSandbox(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writing is idempotent and never overwrites an existing sandbox.ts", () => {
  const a = agent();
  try {
    a.sub("finance");
    const first = writeReasoningSandboxes(a.dir, ["finance"]);
    assert.deepEqual(first.sort(), ["agent/lib/reasoning-sandbox.ts", "agent/subagents/finance/sandbox.ts"].sort());
    assert.equal(readFileSync(join(a.dir, "agent/lib/reasoning-sandbox.ts"), "utf8"), reasoningSandboxLibTs());
    assert.equal(readFileSync(join(a.dir, "agent/subagents/finance/sandbox.ts"), "utf8"), reasoningSandboxReexportTs());
    // second run writes nothing
    assert.deepEqual(writeReasoningSandboxes(a.dir, ["finance"]), []);
    // a custom sandbox is respected
    writeFileSync(join(a.dir, "agent/subagents/finance/sandbox.ts"), "// mine\n");
    writeReasoningSandboxes(a.dir, ["finance"]);
    assert.equal(readFileSync(join(a.dir, "agent/subagents/finance/sandbox.ts"), "utf8"), "// mine\n");
  } finally {
    a.cleanup();
  }
});

test("the re-export points at the shared lib the upgrade writes", () => {
  assert.match(reasoningSandboxReexportTs(), /from "\.\.\/\.\.\/lib\/reasoning-sandbox"/);
  assert.match(reasoningSandboxLibTs(), /justbash/);
  assert.match(reasoningSandboxLibTs(), /eve\/sandbox\/just-bash/);
});
