import assert from "node:assert/strict";
import { test } from "node:test";

import {
  newStepState,
  openedRequests,
  readStep,
  replyText,
  settledRequestIds,
  streamEvents,
  toAnswers,
  turnEnd,
  waitsOnPerson,
} from "../dist/index.js";

// A v27 turn, as eve 1.0 writes it: event lines and progress records.
const V27 = [
  { at: "2026-11-12T19:00:00.000Z", facts: [
    { type: "session.started", data: {} },
    { type: "delivery.admitted", data: { deliveryId: "d1" } },
    { type: "turn.started", scope: { turnId: "turn_0" }, data: { turnId: "turn_0" } },
    { type: "delivery.consumed", scope: { turnId: "turn_0" }, data: { deliveryId: "d1", turnId: "turn_0", parts: [{ kind: "text", text: "hi" }] } },
  ] },
  { progress: { type: "content.delta", scope: { turnId: "turn_0", runId: "r1" }, data: { partId: "p0", kind: "text", delta: "Look" } } },
  { at: "2026-11-12T19:00:01.000Z", facts: [
    { type: "content.completed", scope: { turnId: "turn_0" }, data: { partId: "p0", kind: "text", phase: "narration", value: "Looking." } },
    { type: "call.requested", scope: { turnId: "turn_0" }, data: { callId: "c1", owner: {}, capability: { kind: "tool", name: "gmail_send_email", label: "Send email" }, input: { to: "a@b.c" } } },
  ] },
  { $eve: "heartbeat" },
  { at: "2026-11-12T19:00:02.000Z", facts: [
    { type: "interaction.opened", scope: { turnId: "turn_0" }, data: { interactionId: "i1", subject: {}, request: { kind: "approval", prompt: "Send it?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } } },
    { type: "turn.paused", scope: { turnId: "turn_0" }, data: { turnId: "turn_0", awaiting: ["i1"] } },
  ] },
  { at: "2026-11-12T19:00:03.000Z", facts: [
    { type: "interaction.settled", scope: { turnId: "turn_0" }, data: { interactionId: "i1", outcome: "accepted" } },
    { type: "call.started", scope: { turnId: "turn_0" }, data: { callId: "c1", clearedBy: { interactionId: "i1" } } },
  ] },
  { at: "2026-11-12T19:00:04.000Z", facts: [
    { type: "call.settled", scope: { turnId: "turn_0" }, data: { callId: "c1", outcome: "completed", output: { ok: true } } },
    { type: "content.completed", scope: { turnId: "turn_0" }, data: { partId: "p1", kind: "text", phase: "reply", value: "Sent." } },
    { type: "turn.settled", scope: { turnId: "turn_0" }, data: { turnId: "turn_0", outcome: "completed", reply: ["p1"] } },
  ] },
];

function read(lines) {
  const events = [];
  let line = 0;
  for (const record of lines) {
    const got = streamEvents(record, line);
    if (record.$eve) continue;
    events.push(...got);
    line++;
  }
  return events;
}

test("v27 lines become positioned events; transport records do not move the cursor", () => {
  const events = read(V27);
  assert.equal(events.length, 14);
  assert.deepEqual(events.at(-1).meta.position, { line: 5, index: 2 });
  assert.equal(events[0].meta.endOfLine, false);
  assert.equal(events[3].meta.endOfLine, undefined);
  assert.deepEqual(streamEvents({ $eve: "heartbeat" }, 9), []);
});

test("v27: the reply, the pause, the request and the end read the same as v26", () => {
  const events = read(V27);
  assert.deepEqual(events.map(replyText).filter(Boolean), ["Sent."]);
  assert.equal(events.filter(waitsOnPerson).length, 1);
  const opened = events.flatMap(openedRequests);
  assert.deepEqual(opened, [{ id: "i1", kind: "approval", prompt: "Send it?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], allowFreeform: false }]);
  assert.deepEqual(events.flatMap(settledRequestIds), ["i1"]);
  assert.deepEqual(events.map(turnEnd).filter(Boolean), ["completed"]);
});

test("v26 events still read", () => {
  const v26 = [
    { type: "input.requested", data: { requests: [{ requestId: "r1", kind: "tool-approval", prompt: "Ok?", options: [{ id: "approve", label: "Approve" }] }] } },
    { type: "turn.waiting", data: { on: "input" } },
    { type: "message.completed", data: { message: "Thinking", finishReason: "tool-calls" } },
    { type: "message.completed", data: { message: "Done.", finishReason: "stop" } },
    { type: "turn.completed", data: {} },
  ].flatMap((e) => streamEvents(e));
  assert.deepEqual(v26.map(replyText).filter(Boolean), ["Done."]);
  assert.equal(v26.filter(waitsOnPerson).length, 1);
  assert.equal(v26.flatMap(openedRequests)[0].id, "r1");
  assert.deepEqual(v26.map(turnEnd).filter(Boolean), ["completed"]);
});

test("v26 inputResponses become v27 answers; cancel is deny", () => {
  assert.deepEqual(
    toAnswers([
      { requestId: "r1", optionId: "cancel" },
      { requestId: "r2", optionId: "approve" },
      { interactionId: "i3", text: "blue" },
      { nope: true },
    ]),
    [
      { interactionId: "r1", optionId: "deny" },
      { interactionId: "r2", optionId: "approve" },
      { interactionId: "i3", text: "blue" },
    ],
  );
});

test("v27: the steps reader follows a call from request to settle", () => {
  const state = newStepState();
  for (const e of read(V27)) readStep(state, e.type, e.data, e.meta, e.scope);
  const steps = [...state.steps.values()];
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "Send email");
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].turnId, "turn_0");
});

test("v27: a task's step settles on call.settled, and task.ended closes one left running", () => {
  const state = newStepState();
  const ev = [
    { type: "call.requested", data: { callId: "c9", capability: { kind: "agent", name: "research" }, input: { message: "dig" } } },
    { type: "call.started", data: { callId: "c9", taskId: "t9" } },
    { type: "task.started", data: { taskId: "t9", startedBy: { callId: "c9" }, kind: "agent", name: "research" } },
    { type: "task.ended", data: { taskId: "t9", outcome: "failed" } },
  ];
  for (const e of ev) readStep(state, e.type, e.data);
  assert.equal(state.steps.get("c9").status, "failed");
  assert.equal(state.steps.get("c9").chip, "Research");
});
