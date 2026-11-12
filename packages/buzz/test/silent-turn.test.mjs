import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionStore } from "../dist/sessions.js";
import { answerTurn, describeSilentTurn, failureFromEvent, silentTurnReply } from "../dist/turn.js";

/**
 * A turn with no text used to produce one sentence for three different
 * faults: every tool failed, the model call failed, or the completion was
 * genuinely empty. The stream carries the difference; the bridge now keeps it
 * and says it (KYB-529). Every name and message in a reply comes verbatim
 * from an event in the fake stream below.
 */

function storeWith(id = "session-1") {
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "buzz-silent-")), "sessions.json"));
  store.set("relay", "channel", { id, streamIndex: 1 });
  return store;
}

function clientAnswering(events) {
  return {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 2 },
          stream: async function* () {},
          send: async () => ({ sessionId: id, deliveryId: "d1", async *stream() { yield* events; } }),
        };
      },
      async create() { throw new Error("not expected"); },
    },
  };
}

let calls = 0;
/** eve 1.0: the call names its tool when requested and settles by id. */
const toolFailed = (toolName, message) => {
  const callId = `c${++calls}`;
  return [
    { type: "call.requested", data: { callId, owner: { runId: "r1" }, capability: { kind: "tool", name: toolName }, input: {} } },
    { type: "call.settled", data: { callId, outcome: "failed", error: { code: "tool_failed", message }, output: message } },
  ];
};
const settled = (outcome = "handled") => ({ type: "delivery.settled", data: { deliveryId: "d1", outcome } });

test("AC1: a turn whose only tool call fails names the tool and its error, verbatim", async () => {
  const events = [
    ...toolFailed("todoist_get_all_sections", "Tool TODOIST_GET_ALL_SECTIONS not found (404)"),
    ...toolFailed("todoist_get_all_sections", "Tool TODOIST_GET_ALL_SECTIONS not found (404)"),
    { type: "turn.settled", data: { turnId: "t", outcome: "completed" } },
    settled(),
  ];
  const result = await answerTurn(clientAnswering(events), storeWith(), "channel", "list my sections", "relay");
  assert.equal(result.message, "");
  assert.equal(result.failures.length, 2);
  const reply = silentTurnReply(result.failures);
  assert.match(reply, /`todoist_get_all_sections` 2 times/);
  assert.ok(reply.includes('"Tool TODOIST_GET_ALL_SECTIONS not found (404)"'));
  assert.doesNotMatch(reply, /ask me again and I'll retry/);
  assert.equal(describeSilentTurn(result.failures), "no text: tool failures (2)");
});

test("AC2: a failed model call is reported as such, with its code", async () => {
  const error = { code: "MODEL_CALL_FAILED", message: "AI_APICallError: Overloaded" };
  const events = [
    { type: "model.settled", data: { runId: "r1", outcome: "failed", error } },
    { type: "turn.settled", data: { turnId: "t", outcome: "failed", error } },
    settled("failed"),
  ];
  const result = await answerTurn(clientAnswering(events), storeWith(), "channel", "hello", "relay");
  assert.equal(result.status, "failed");
  const reply = silentTurnReply(result.failures);
  assert.match(reply, /The model call failed \(MODEL_CALL_FAILED: AI_APICallError: Overloaded\)/);
  assert.equal(describeSilentTurn(result.failures), "no text: model error (MODEL_CALL_FAILED, MODEL_CALL_FAILED)");
});

test("AC3: an empty completion with no failures keeps the existing sentence", async () => {
  const events = [
    { type: "call.requested", data: { callId: "c9", owner: { runId: "r1" }, capability: { kind: "tool", name: "arcana_recall" }, input: {} } },
    { type: "call.settled", data: { callId: "c9", outcome: "completed", output: "nothing" } },
    { type: "turn.settled", data: { turnId: "t", outcome: "completed" } },
    settled(),
  ];
  const result = await answerTurn(clientAnswering(events), storeWith(), "channel", "hello", "relay");
  assert.deepEqual(result.failures, []);
  assert.equal(silentTurnReply(result.failures), "I didn't get an answer back for that one — ask me again and I'll retry.");
  assert.equal(describeSilentTurn(result.failures), "no text: empty completion");
});

test("AC4 on eve 1.0: a rejected call names its tool from the call that requested it", () => {
  const calls = new Map([["c1", { name: "gh_merge" }]]);
  assert.equal(failureFromEvent({ type: "call.settled", data: { callId: "c1", outcome: "completed", output: "ok" } }, calls), null);
  const f = failureFromEvent({ type: "call.settled", data: { callId: "c1", outcome: "rejected", output: { reason: "approval denied" } } }, calls);
  assert.deepEqual(f, { kind: "tool", toolName: "gh_merge", message: '{"reason":"approval denied"}' });
  assert.equal(failureFromEvent({ type: "call.settled", data: { callId: "zz", outcome: "failed", error: { message: "x" } } }).toolName, "a tool");
});

test("AC4: nothing in the reply is invented; unknown events are ignored", () => {
  assert.equal(failureFromEvent({ type: "message.appended", data: { delta: "hi" } }), null);
  assert.equal(failureFromEvent({ type: "action.result", data: { status: "completed", result: { toolName: "x", output: "ok" } } }), null);
  const f = failureFromEvent({ type: "action.result", data: { status: "rejected", result: { toolName: "gh_merge", output: { reason: "approval denied" } } } });
  assert.deepEqual(f, { kind: "tool", toolName: "gh_merge", message: '{"reason":"approval denied"}' });
  const reply = silentTurnReply([f, { kind: "tool", toolName: "gh_merge", message: '{"reason":"approval denied"}' }]);
  assert.match(reply, /`gh_merge` 2 times/);
});
