import assert from "node:assert/strict";
import { test } from "node:test";

import { chipFor, progressEvents, progressGate, progressNotes, progressText } from "../dist/index.js";

const requested = (toolName, input, extra = {}) => ({
  turnId: "turn-1",
  actions: [{ callId: "call-1", kind: "tool-call", toolName, input, ...extra }],
});
const result = (toolName, output, status = "completed") => ({
  turnId: "turn-1",
  status,
  result: { callId: "call-1", toolName, output },
});

test("a note is read from the call, under any mount namespace", () => {
  const message = "On it. Building your daily calendar page now, I'll send it here in a minute.";
  assert.deepEqual(progressNotes("actions.requested", requested("notify__working_on_it", { message })), [
    { callId: "call-1", turnId: "turn-1", text: message },
  ]);
  assert.equal(progressNotes("actions.requested", requested("ops__working_on_it", { message })).length, 1);
  assert.equal(progressNotes("actions.requested", requested("working_on_it", { message })).length, 1);
});

test("a call through the catalogue names the real tool in its input", () => {
  const notes = progressNotes(
    "actions.requested",
    requested("eve__tool", { name: "notify__working_on_it", input: { message: "On it." } }),
  );
  assert.deepEqual(notes.map((n) => n.text), ["On it."]);
});

test("other tools, empty messages and failed results are not notes", () => {
  assert.deepEqual(progressNotes("actions.requested", requested("artifacts__create", { message: "x" })), []);
  assert.deepEqual(progressNotes("actions.requested", requested("not_working_on_it", { message: "x" })), []);
  assert.deepEqual(progressNotes("actions.requested", requested("notify__working_on_it", { message: "  " })), []);
  assert.deepEqual(progressNotes("action.result", result("notify__working_on_it", { message: "x" }, "failed")), []);
  assert.deepEqual(progressNotes("message.completed", { message: "On it." }), []);
});

test("a result carries the same text, for readers that only see results", () => {
  assert.deepEqual(progressNotes("action.result", result("notify__working_on_it", { sent: true, message: "On it." })), [
    { callId: "call-1", turnId: "turn-1", text: "On it." },
  ]);
});

test("a note is one line, and a long one is cut at a word", () => {
  assert.equal(progressText("On it.\n\nBack soon."), "On it. Back soon.");
  const long = progressText(`${"word ".repeat(100)}end`);
  assert.ok(long.length <= 280);
  assert.ok(long.endsWith("word…"));
});

test("one note per turn, and a replayed call is not posted twice", () => {
  const fresh = progressGate();
  assert.equal(fresh({ callId: "a", turnId: "t1", text: "On it." }), true);
  assert.equal(fresh({ callId: "b", turnId: "t1", text: "Still on it." }), false);
  assert.equal(fresh({ callId: "a", turnId: "t1", text: "On it." }), false);
  assert.equal(fresh({ callId: "c", turnId: "t2", text: "On it." }), true);
  assert.equal(fresh({ callId: "d", text: "No turn id." }), true);
  assert.equal(fresh({ callId: "d", text: "No turn id." }), false);
});

test("raised caps preserve call dedupe and report every refusal with its reason", () => {
  const refused = [];
  const fresh = progressGate({ notesPerTurn: 2, onRefused: (note, reason) => refused.push([note.callId, reason]) });
  const note = (callId) => ({ callId, turnId: "t", text: callId });
  assert.equal(fresh(note("a")), true);
  assert.equal(fresh(note("a")), false);
  assert.equal(fresh(note("b")), true);
  assert.equal(fresh(note("c")), false);
  assert.deepEqual(refused, [["a", "duplicate-call"], ["c", "turn-limit"]]);
  assert.equal(progressGate({ notesPerTurn: "unlimited" })(note("a")), true);
  const unlimited = progressGate({ notesPerTurn: "unlimited" });
  assert.equal(unlimited(note("a")), true);
  assert.equal(unlimited(note("b")), true);
  assert.equal(unlimited(note("a")), false);
});

test("eviction removes the call and its turn count together", () => {
  const fresh = progressGate({ retentionLimit: 1 });
  assert.equal(fresh({ callId: "a", turnId: "t", text: "a" }), true);
  assert.equal(fresh({ callId: "b", turnId: "other", text: "b" }), true);
  assert.equal(fresh({ callId: "c", turnId: "t", text: "c" }), true);
  assert.equal(progressGate(1)({ callId: "a", text: "a" }), true);
});

test("invalid caps and retention bounds fail fast", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => progressGate({ notesPerTurn: value }), /notesPerTurn/);
  }
  assert.throws(() => progressGate(0), /retentionLimit/);
});

test("chat channel refusals are visible at debug level", async () => {
  const lines = [];
  const original = console.debug;
  console.debug = (message) => lines.push(message);
  try {
    const events = progressEvents();
    const thread = { post: async () => {} };
    const data = result("notify__working_on_it", { message: "On it." });
    await events["action.result"](data, { thread });
    await events["action.result"](data, { thread });
    await events["action.result"]({ ...data, result: { ...data.result, callId: "call-2" } }, { thread });
    assert.deepEqual(lines, [
      "[progress] refused note callId=call-1 reason=duplicate-call",
      "[progress] refused note callId=call-2 reason=turn-limit",
    ]);
  } finally {
    console.debug = original;
  }
});

test("the chat channel handler posts the note once and passes a renderer chain on", async () => {
  const posted = [];
  const thread = { post: async (m) => posted.push(m) };
  const events = progressEvents();
  const data = result("notify__working_on_it", { sent: true, message: "On it." });
  await events["action.result"](data, { thread }, {});
  await events["action.result"](data, { thread }, {});
  await events["action.result"](result("artifacts__create", {}), { thread }, {});
  assert.deepEqual(posted, ["On it."]);

  let ran = false;
  await progressEvents()["action.result"](result("artifacts__create", {}), { thread }, {}, () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("a post that fails never fails the turn", async () => {
  const thread = { post: async () => { throw new Error("rate limited"); } };
  await progressEvents()["action.result"](result("notify__working_on_it", { message: "On it." }), { thread }, {});
});

test("the step chip reads Update", () => {
  assert.equal(chipFor("notify__working_on_it"), "Update");
});
