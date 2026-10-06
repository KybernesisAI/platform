import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions } from "../dist/index.js";

function appRoot(runs, buzz) {
  const root = mkdtempSync(join(tmpdir(), "kyb-sessions-"));
  const dir = join(root, ".eve", ".workflow-data", "runs");
  mkdirSync(dir, { recursive: true });
  for (const r of runs) writeFileSync(join(dir, `${r.runId}.json`), JSON.stringify(r));
  if (buzz) writeFileSync(join(root, ".buzz-sessions.json"), JSON.stringify(buzz));
  return root;
}
const session = (runId, title, trigger, extra = {}, status = "running", updatedAt = "2026-10-06T10:00:00Z") => ({
  runId, status, createdAt: "2026-10-06T09:00:00Z", updatedAt, workflowName: "workflow//eve//workflowEntry",
  attributes: { "$eve.type": "session", "$eve.title": title, "$eve.trigger": trigger, ...extra },
});

test("conversations are listed newest first with the surface they came from; turns and timeouts are not conversations", () => {
  const root = appRoot([
    session("wrun_chat", "Using Plaud, what was my most recent recording about?", "http", {}, "running", "2026-10-06T12:00:00Z"),
    session("wrun_text", "Hey", "channel:linq", {}, "running", "2026-10-06T13:00:00Z"),
    session("wrun_rout", "Remind Ian to take creatine", "http", { "$eve.schedule": "daily-creatine" }, "running", "2026-10-06T11:00:00Z"),
    session("wrun_buzz", "what's in #general", "http", {}, "completed", "2026-10-06T08:00:00Z"),
    session("wrun_dead", "old", "http", {}, "failed", "2026-09-01T08:00:00Z"),
    { runId: "wrun_turn", status: "completed", workflowName: "workflow//eve//turnWorkflow", attributes: { "$rootRunId": "wrun_chat" } },
  ], { "chan-1": { sessionId: "wrun_buzz" } });
  const all = listSessions(root);
  assert.deepEqual(all.map((s) => s.id), ["wrun_text", "wrun_chat", "wrun_rout", "wrun_buzz", "wrun_dead"]);
  assert.deepEqual(all.map((s) => s.surface), ["imessage", "chat", "routines", "buzz", "chat"]);
  assert.equal(all[2].routine, "daily-creatine");
  assert.equal(all[3].channel, "chan-1");
  assert.deepEqual(all.map((s) => s.status), ["alive", "alive", "alive", "ended", "failed"]);
  assert.deepEqual(listSessions(root, { includeEnded: false }).map((s) => s.id), ["wrun_text", "wrun_chat", "wrun_rout"]);
  assert.equal(listSessions(root, { limit: 2 }).length, 2);
});

test("the canonical pointer labels the routines conversation even before a schedule attribute lands", () => {
  const root = appRoot([session("wrun_canon", "Say good morning", "http")]);
  assert.equal(listSessions(root, { canonicalId: "wrun_canon" })[0].surface, "routines");
  assert.equal(listSessions(root)[0].surface, "chat");
});

test("no run store means no conversations, not an error", () => {
  assert.deepEqual(listSessions(mkdtempSync(join(tmpdir(), "kyb-sessions-empty-"))), []);
});
