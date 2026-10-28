import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ROUTINE_TOOL_FILES, repairRoutineTools } from "../dist/routine-tools.js";

const registry = join(import.meta.dirname, "..", "..", "..", "registry");

test("the routine tools kyb upgrade adds are exactly what the manage registry item writes", () => {
  const item = JSON.parse(readFileSync(join(registry, "r", "manage.json"), "utf8"));
  for (const file of ROUTINE_TOOL_FILES) {
    const entry = item.files.find((f) => f.target === file.target);
    assert.ok(entry, `${file.target} is in the manage item`);
    assert.equal(file.content, readFileSync(join(registry, entry.path), "utf8"), file.target);
  }
  assert.deepEqual(
    ROUTINE_TOOL_FILES.map((f) => f.target).sort(),
    item.files.map((f) => f.target).filter((t) => t !== "agent/channels/kyb.ts").sort(),
  );
});

test("an agent with manage and no create_routine gets the routine tools; one with its own is left alone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "routine-tools-"));
  assert.deepEqual(repairRoutineTools(cwd, {}), [], "nothing without manage");
  const written = repairRoutineTools(cwd, { "@kybernesis/manage": "^0.31.0" });
  assert.deepEqual(written, ROUTINE_TOOL_FILES.map((f) => f.target));
  assert.ok(existsSync(join(cwd, "agent/tools/create_routine.ts")));
  assert.deepEqual(repairRoutineTools(cwd, { "@kybernesis/manage": "^0.31.0" }), [], "once");

  const own = mkdtempSync(join(tmpdir(), "routine-tools-"));
  mkdirSync(join(own, "agent/tools"), { recursive: true });
  writeFileSync(join(own, "agent/tools/create_routine.ts"), "// hand-made\n");
  assert.deepEqual(repairRoutineTools(own, { "@kybernesis/manage": "^0.31.0" }), []);
  assert.equal(existsSync(join(own, "agent/lib/routines.ts")), false);
});
