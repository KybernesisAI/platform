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
          send: async () => ({ sessionId: id, async *[Symbol.asyncIterator]() { yield* events; } }),
        };
      },
      async create() { throw new Error("not expected"); },
    },
  };
}

const toolFailed = (toolName, message) => ({
  type: "action.result",
  data: { status: "failed", error: { code: "tool_failed", message }, result: { kind: "tool-result", callId: "c1", toolName, isError: true, output: message } },
});

test("AC1: a turn whose only tool call fails names the tool and its error, verbatim", async () => {
  const events = [
    toolFailed("todoist_get_all_sections", "Tool TODOIST_GET_ALL_SECTIONS not found (404)"),
    toolFailed("todoist_get_all_sections", "Tool TODOIST_GET_ALL_SECTIONS not found (404)"),
    { type: "message.completed", data: { finishReason: "stop", message: "" } },
    { type: "session.waiting", data: {} },
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
  const events = [
    { type: "step.failed", data: { code: "MODEL_CALL_FAILED", message: "AI_APICallError: Overloaded", stepIndex: 0 } },
    { type: "turn.failed", data: { code: "MODEL_CALL_FAILED", message: "AI_APICallError: Overloaded" } },
    { type: "session.failed", data: {} },
  ];
  const result = await answerTurn(clientAnswering(events), storeWith(), "channel", "hello", "relay");
  assert.equal(result.status, "failed");
  const reply = silentTurnReply(result.failures);
  assert.match(reply, /The model call failed \(MODEL_CALL_FAILED: AI_APICallError: Overloaded\)/);
  assert.equal(describeSilentTurn(result.failures), "no text: model error (MODEL_CALL_FAILED, MODEL_CALL_FAILED)");
});

test("AC3: an empty completion with no failures keeps the existing sentence", async () => {
  const events = [
    { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "c1", toolName: "arcana_recall", output: "nothing" } } },
    { type: "message.completed", data: { finishReason: "stop", message: "" } },
    { type: "session.completed", data: {} },
  ];
  const result = await answerTurn(clientAnswering(events), storeWith(), "channel", "hello", "relay");
  assert.deepEqual(result.failures, []);
  assert.equal(silentTurnReply(result.failures), "I didn't get an answer back for that one — ask me again and I'll retry.");
  assert.equal(describeSilentTurn(result.failures), "no text: empty completion");
});

test("AC4: nothing in the reply is invented; unknown events are ignored", () => {
  assert.equal(failureFromEvent({ type: "message.appended", data: { delta: "hi" } }), null);
  assert.equal(failureFromEvent({ type: "action.result", data: { status: "completed", result: { toolName: "x", output: "ok" } } }), null);
  const f = failureFromEvent({ type: "action.result", data: { status: "rejected", result: { toolName: "gh_merge", output: { reason: "approval denied" } } } });
  assert.deepEqual(f, { kind: "tool", toolName: "gh_merge", message: '{"reason":"approval denied"}' });
  const reply = silentTurnReply([f, { kind: "tool", toolName: "gh_merge", message: '{"reason":"approval denied"}' }]);
  assert.match(reply, /`gh_merge` 2 times/);
});
