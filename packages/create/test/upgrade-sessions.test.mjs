import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  buzzSessionsPath,
  confirmEveUpgrade,
  inspectBuzzSessions,
  inspectDurableRuns,
  reconcileEvalScript,
} from "../dist/upgrade-sessions.js";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-upgrade-sessions-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("durable inspection counts only readable exact-running records and reports malformed files", () => {
  const { dir, cleanup } = tempProject();
  try {
    const runs = join(dir, ".eve/.workflow-data/runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "running.json"), JSON.stringify({ runId: "run-running", status: "running" }));
    writeFileSync(join(runs, "completed.json"), JSON.stringify({ runId: "run-done", status: "completed" }));
    writeFileSync(join(runs, "case.json"), JSON.stringify({ runId: "run-case", status: "Running" }));
    writeFileSync(join(runs, "missing-id.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(runs, "broken.json"), "{");
    writeFileSync(join(runs, "ignored.txt"), JSON.stringify({ runId: "ignored", status: "running" }));

    const result = inspectDurableRuns(dir);
    assert.deepEqual(result.runningRunIds, ["run-running"]);
    assert.equal(result.inspectedRecords, 4);
    assert.equal(result.issues.length, 2);
    assert.match(result.issues.join("\n"), /broken\.json/);
    assert.match(result.issues.join("\n"), /no string runId/);
  } finally {
    cleanup();
  }
});

test("a missing durable store is a complete zero rather than an error", () => {
  const { dir, cleanup } = tempProject();
  try {
    assert.deepEqual(inspectDurableRuns(dir), { runningRunIds: [], inspectedRecords: 0, issues: [] });
  } finally {
    cleanup();
  }
});

test("Buzz session discovery follows explicit, legacy, then keyfile conventions and matches context", () => {
  const { dir, cleanup } = tempProject();
  try {
    const legacy = join(dir, ".buzz-sessions.json");
    writeFileSync(legacy, JSON.stringify({
      "wss://community.example|channel-7": { id: "run-7", streamIndex: 2, updated: Date.now() },
      "wss://community.example|channel-8": { id: "run-8", streamIndex: 4, updated: Date.now() },
    }));
    assert.equal(buzzSessionsPath(dir, {}), legacy);
    assert.equal(buzzSessionsPath(dir, { BUZZ_SESSIONS_FILE: "state/custom.json" }), join(dir, "state/custom.json"));
    unlinkSync(legacy);
    assert.equal(
      buzzSessionsPath(dir, { BUZZ_KEYFILE: ".buzz/agent.key" }),
      join(dir, ".buzz/buzz-sessions.json"),
    );

    writeFileSync(legacy, JSON.stringify({
      "wss://community.example|channel-7": { id: "run-7", streamIndex: 2, updated: Date.now() },
      "wss://community.example|channel-8": { id: "run-8", streamIndex: 4, updated: Date.now() },
    }));
    const result = inspectBuzzSessions(dir, {}, ["run-7"]);
    assert.deepEqual(result.matches, [{
      runId: "run-7",
      community: "wss://community.example",
      channel: "channel-7",
    }]);
    assert.equal(result.issue, undefined);
  } finally {
    cleanup();
  }
});

test("Buzz metadata failures stay visible without changing the durable result", () => {
  const { dir, cleanup } = tempProject();
  try {
    const path = join(dir, ".buzz-sessions.json");
    writeFileSync(path, "not json");
    const result = inspectBuzzSessions(dir, {}, ["run-1"]);
    assert.deepEqual(result.matches, []);
    assert.match(result.issue, /could not read Buzz session metadata/);
  } finally {
    cleanup();
  }
});

test("eval script reconciliation preserves prefixes and arguments but refuses custom orchestration", () => {
  assert.deepEqual(
    reconcileEvalScript("ARCANA_COMPANY_WORKSPACE=x ARCANA_DM_WORKSPACE=x eve eval --strict --junit .eve/junit.xml"),
    {
      kind: "updated",
      script: "ARCANA_COMPANY_WORKSPACE=x ARCANA_DM_WORKSPACE=x kyb-eval --strict --junit .eve/junit.xml",
    },
  );
  assert.equal(reconcileEvalScript("kyb-eval --strict").kind, "current");
  assert.equal(reconcileEvalScript("node scripts/eval.mjs").kind, "custom");
  assert.equal(reconcileEvalScript("eve eval && npm run report").kind, "custom");
  assert.equal(reconcileEvalScript(undefined).kind, "missing");
});

test("destructive confirmation accepts --yes and fails closed without a TTY", async () => {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: false });
  assert.equal(await confirmEveUpgrade({ yes: true, input }), true);
  assert.equal(await confirmEveUpgrade({ yes: false, input }), false);
});

test("interactive destructive confirmation requires an explicit affirmative answer", async () => {
  for (const [answer, expected] of [["yes\n", true], ["no\n", false]]) {
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    input.end(answer);
    assert.equal(await confirmEveUpgrade({ yes: false, input, output }), expected);
  }
});
