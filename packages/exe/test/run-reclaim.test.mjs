import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { heldRunIds, reclaimAbandonedRuns, describeReclaim } from "../dist/run-reclaim.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");

/** A workflow-data directory with the runs and hooks a test names. */
function store(runs, hooks = []) {
  const root = mkdtempSync(join(tmpdir(), "reclaim-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(join(root, "hooks", "tokens"), { recursive: true });
  for (const [i, r] of runs.entries()) {
    writeFileSync(join(runsDir, `run${i}.json`), JSON.stringify(r));
  }
  for (const [i, h] of hooks.entries()) {
    writeFileSync(join(root, "hooks", "tokens", `hook${i}.json`), JSON.stringify(h));
  }
  return { root, runsDir };
}

const run = (o) => ({
  runId: o.id,
  status: o.status ?? "running",
  workflowName: `workflow//eve//${o.workflow ?? "turnWorkflow"}`,
  updatedAt: new Date(NOW.getTime() - (o.ageDays ?? 0) * DAY).toISOString(),
});

test("an abandoned run is retired, and a recent one is not", () => {
  const { runsDir } = store([run({ id: "old", ageDays: 5 }), run({ id: "fresh", ageDays: 0.5 })]);
  const r = reclaimAbandonedRuns({ runsDir, now: NOW });
  assert.equal(r.retired, 1);
  assert.equal(r.keptRecent, 1);
});

/**
 * The one that matters. A routine's session is a long-lived `running` run that
 * is idle between firings — a weekly routine for a whole week. Retiring it kills
 * the routine silently. This happened on a production agent: three of four.
 */
test("a run a hook still holds is never retired, however old", () => {
  const { root, runsDir } = store(
    [run({ id: "routine-session", ageDays: 30 }), run({ id: "genuinely-abandoned", ageDays: 30 })],
    [{ token: "routines:routine:gtm-morning", runId: "routine-session" }],
  );
  const held = heldRunIds(root);
  assert.ok(held.has("routine-session"));

  const r = reclaimAbandonedRuns({ runsDir, now: NOW, held, apply: true });
  assert.equal(r.keptHeld, 1, "the routine's session must survive");
  assert.equal(r.retired, 1, "the unheld one is still retired");

  const kept = JSON.parse(readFileSync(join(runsDir, "run0.json"), "utf8"));
  assert.equal(kept.status, "running", "held run must be untouched on disk");
});

test("a dry run changes nothing and still reports what it would do", () => {
  const { runsDir } = store([run({ id: "old", ageDays: 9 })]);
  const r = reclaimAbandonedRuns({ runsDir, now: NOW });
  assert.equal(r.retired, 1);
  assert.equal(JSON.parse(readFileSync(join(runsDir, "run0.json"), "utf8")).status, "running");
});

test("retiring marks cancelled rather than deleting, so the log still replays", () => {
  const { runsDir } = store([run({ id: "old", ageDays: 9 })]);
  reclaimAbandonedRuns({ runsDir, now: NOW, apply: true });
  const after = JSON.parse(readFileSync(join(runsDir, "run0.json"), "utf8"));
  assert.equal(after.status, "cancelled");
  assert.equal(after.completedAt, NOW.toISOString());
  assert.equal(after.runId, "old", "the run keeps its identity");
});

test("terminal runs are left alone and counted separately", () => {
  const { runsDir } = store([
    run({ id: "done", status: "completed", ageDays: 9 }),
    run({ id: "failed", status: "failed", ageDays: 9 }),
  ]);
  const r = reclaimAbandonedRuns({ runsDir, now: NOW });
  assert.equal(r.retired, 0);
  assert.equal(r.keptTerminal, 2);
});

test("an unparseable timestamp is not treated as abandoned", () => {
  const { runsDir } = store([{ runId: "weird", status: "running", workflowName: "workflow//eve//turnWorkflow", updatedAt: "not-a-date" }]);
  const r = reclaimAbandonedRuns({ runsDir, now: NOW });
  assert.equal(r.retired, 0);
  assert.equal(r.keptRecent, 1);
});

test("doctor says nothing when there is nothing to reclaim", () => {
  const { runsDir } = store([run({ id: "fresh", ageDays: 0 })]);
  assert.equal(describeReclaim(reclaimAbandonedRuns({ runsDir, now: NOW })), undefined);
});

test("doctor names the counts and that held runs were spared", () => {
  const { root, runsDir } = store(
    [run({ id: "a", ageDays: 9 }), run({ id: "b", ageDays: 9, workflow: "sessionTimeoutWorkflow" }), run({ id: "held", ageDays: 40 })],
    [{ token: "routines:routine:x", runId: "held" }],
  );
  const line = describeReclaim(reclaimAbandonedRuns({ runsDir, now: NOW, held: heldRunIds(root) }));
  assert.match(line, /2 abandoned durable run\(s\)/);
  assert.match(line, /turnWorkflow: 1/);
  assert.match(line, /1 held by a hook were left alone/);
});
