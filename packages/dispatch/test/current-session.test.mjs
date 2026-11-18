import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchOnMessage } from "../dist/channel.js";
import { currentSessionFile, readCurrentSession, shouldRecordCurrentSession } from "../dist/current-session.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kyb-dispatch-session-"));
  mkdirSync(join(root, ".eve", ".workflow-data", "runs"), { recursive: true });
  const run = (id, value) => writeFileSync(join(root, ".eve", ".workflow-data", "runs", `${id}.json`),
    typeof value === "string" ? value : JSON.stringify(value));
  const pointer = currentSessionFile(root);
  const original = '{ "sessionId": "wrun_owner", "principalId": "owner", "at": "before" }\n';
  writeFileSync(pointer, original);
  return { root, run, pointer, original };
}

test("harness turns preserve pointer bytes, production turns update it without changing auth", () => {
  const { root, run, pointer, original } = fixture();
  const old = process.env.EVE_APP_DIR;
  process.env.EVE_APP_DIR = root;
  try {
    run("wrun_eval", { status: "running", deploymentId: "mvz1f7sy-092b724d" });
    run("wrun_prod", { status: "running", deploymentId: "dpl_local@5.1.0" });
    const caller = { principalId: "local-dev" };
    assert.deepEqual(dispatchOnMessage({ eve: { sessionId: "wrun_eval", caller } }), { auth: caller });
    assert.equal(readFileSync(pointer, "utf8"), original);
    assert.deepEqual(dispatchOnMessage({ eve: { sessionId: "wrun_prod", caller } }), { auth: caller });
    assert.equal(readCurrentSession(root)?.sessionId, "wrun_prod");
    assert.equal(readCurrentSession(root)?.principalId, "local-dev");
  } finally {
    if (old === undefined) delete process.env.EVE_APP_DIR;
    else process.env.EVE_APP_DIR = old;
  }
});

test("unknown, malformed, terminal, and dev/eval run metadata cannot overwrite pointer", () => {
  const { root, run, pointer, original } = fixture();
  run("wrun_bad", "not json");
  run("wrun_missing_deployment", { status: "running" });
  run("wrun_dead", { status: "cancelled", deploymentId: "dpl_local@5.1.0" });
  run("wrun_live", { status: "running", deploymentId: "dpl_local@5.1.0" });
  for (const id of ["wrun_unknown", "wrun_bad", "wrun_missing_deployment", "wrun_dead", "../outside"]) {
    assert.equal(shouldRecordCurrentSession(id, root), false, id);
  }
  const dev = process.env.EVE_DEV;
  const evalFlag = process.env.EVE_EVALUATION;
  try {
    process.env.EVE_DEV = "1";
    assert.equal(shouldRecordCurrentSession("wrun_live", root), false);
    delete process.env.EVE_DEV;
    process.env.EVE_EVALUATION = "1";
    assert.equal(shouldRecordCurrentSession("wrun_live", root), false);
  } finally {
    if (dev === undefined) delete process.env.EVE_DEV; else process.env.EVE_DEV = dev;
    if (evalFlag === undefined) delete process.env.EVE_EVALUATION; else process.env.EVE_EVALUATION = evalFlag;
  }
  assert.equal(readFileSync(pointer, "utf8"), original);
});

test("terminal pointers are absent, live pointers remain readable", () => {
  const { root, run } = fixture();
  for (const status of ["cancelled", "completed", "failed", "running"]) {
    run("wrun_owner", { status, deploymentId: "dpl_local@5.1.0" });
    assert.equal(readCurrentSession(root)?.sessionId, status === "running" ? "wrun_owner" : undefined);
  }
});
