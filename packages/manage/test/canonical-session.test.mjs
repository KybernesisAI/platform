import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCanonicalSession, rememberCanonicalSession, runIsAlive } from "../dist/index.js";

function appRoot(runs = {}) {
  const root = mkdtempSync(join(tmpdir(), "kyb-canonical-"));
  mkdirSync(join(root, ".eve", ".workflow-data", "runs"), { recursive: true });
  for (const [id, status] of Object.entries(runs)) {
    writeFileSync(join(root, ".eve", ".workflow-data", "runs", `${id}.json`), JSON.stringify({ status }));
  }
  return root;
}

test("a canonical pointer at a live run is handed out", () => {
  const root = appRoot({ wrun_live: "running" });
  rememberCanonicalSession(root, "wrun_live", "digest");
  assert.equal(readCanonicalSession(root)?.sessionId, "wrun_live");
});

test("a pointer at a failed run is retired, not handed out (the Kyber flip)", () => {
  const root = appRoot({ wrun_dead: "failed" });
  rememberCanonicalSession(root, "wrun_dead", "eval-probe");
  assert.equal(readCanonicalSession(root), undefined);
  assert.equal(existsSync(join(root, ".eve", "canonical-session.json")), false, "pointer file retired");
  assert.equal(existsSync(join(root, ".eve", "canonical-session.json.retired")), true);
});

test("a pointer at a run the store has never heard of is treated as dead; no store at all means alive", () => {
  const root = appRoot({});
  assert.equal(runIsAlive(root, "wrun_unknown"), false);
  const hosted = mkdtempSync(join(tmpdir(), "kyb-canonical-hosted-"));
  assert.equal(runIsAlive(hosted, "wrun_anything"), true);
});

test("KYB_CANONICAL_SESSION=off keeps an eval run from becoming the conversation", () => {
  const root = appRoot({ wrun_eval: "running" });
  process.env.KYB_CANONICAL_SESSION = "off";
  try {
    rememberCanonicalSession(root, "wrun_eval", "eval-probe");
  } finally {
    delete process.env.KYB_CANONICAL_SESSION;
  }
  assert.equal(readCanonicalSession(root), undefined);
});
