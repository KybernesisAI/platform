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

// eve 1.0 (v27): a settled call names no tool, so the note marks itself in its output.
const settled = (output, outcome = "completed", callId = "call-1") => ({
  type: "call.settled",
  scope: { turnId: "turn-1" },
  data: { callId, outcome, output },
});
const NOTE = { sent: true, kind: "kybernesis.progress-note", message: "On it." };

test("v27: the chat channel handler posts the note once, on call.settled", async () => {
  const posted = [];
  const ctx = { channel: { thread: { post: async (m) => posted.push(m) } } };
  const events = progressEvents();
  await events["call.settled"](settled(NOTE), ctx);
  await events["call.settled"](settled(NOTE), ctx);
  await events["call.settled"](settled({ ok: true, message: "made a page" }, "completed", "call-2"), ctx);
  await events["call.settled"](settled(NOTE, "failed", "call-3"), ctx);
  assert.deepEqual(posted, ["On it."]);
});

test("v27: a post that fails never fails the turn", async () => {
  const ctx = { channel: { thread: { post: async () => { throw new Error("rate limited"); } } } };
  await progressEvents()["call.settled"](settled(NOTE), ctx);
});

test("v27: call.requested carries the note before the tool runs, under any namespace and through the catalogue", () => {
  const req = (name, input) => ({ callId: "c1", capability: { kind: "tool", name }, input });
  assert.deepEqual(progressNotes("call.requested", req("notify__working_on_it", { message: "On it." }), { turnId: "t1" }), [
    { callId: "c1", text: "On it.", turnId: "t1" },
  ]);
  assert.deepEqual(progressNotes("call.requested", req("eve__tool", { name: "notify__working_on_it", input: { message: "Via catalogue." } })), [
    { callId: "c1", text: "Via catalogue." },
  ]);
  assert.deepEqual(progressNotes("call.requested", req("artifacts__create", { message: "x" })), []);
});

test("the step chip reads Update", () => {
  assert.equal(chipFor("notify__working_on_it"), "Update");
});
