import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentSessionFile, readCurrentSession } from "../dist/current-session.js";

test("management pointer reader ignores terminal runs and accepts live or unrecorded runs", () => {
  const root = mkdtempSync(join(tmpdir(), "kyb-manage-session-"));
  const runs = join(root, ".eve", ".workflow-data", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(currentSessionFile(root), JSON.stringify({ sessionId: "wrun_example", at: "now" }));
  assert.equal(readCurrentSession(root)?.sessionId, "wrun_example");
  for (const status of ["cancelled", "completed", "failed", "running"]) {
    writeFileSync(join(runs, "wrun_example.json"), JSON.stringify({ status }));
    assert.equal(readCurrentSession(root)?.sessionId, status === "running" ? "wrun_example" : undefined);
  }
});
