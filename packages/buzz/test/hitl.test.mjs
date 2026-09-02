import assert from "node:assert/strict";
import { test } from "node:test";

import {
  followPendingConversation,
  formatInputRequests,
  invalidInputReply,
  resolveInputReply,
  respondToPendingConversation,
} from "../dist/hitl.js";

const request = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
  allowFreeform: false,
  display: "select",
  kind: "question",
  options: [
    { id: "safe", label: "Continue safely", description: "Keep the current session" },
    { id: "reset", label: "Start over", description: "Open a fresh session" },
  ],
  prompt: "How should I continue?",
  requestId: "request-1",
};

function event(type, data = {}) {
  return { type, data, meta: { at: new Date(0).toISOString(), id: `${type}-1` } };
}

function fakeSession(events, startIndex = 7) {
  let index = startIndex;
  return {
    get state() {
      return { sessionId: "session-1", streamIndex: index };
    },
    async *stream(options) {
      assert.equal(options.follow, true);
      assert.equal(options.startIndex, startIndex);
      for (const item of events) {
        index += 1;
        yield item;
      }
    },
  };
}

test("HITL prompts show numbered labels, stable IDs, descriptions and reply instructions", () => {
  const rendered = formatInputRequests([request]);
  assert.match(rendered, /How should I continue\?/);
  assert.match(rendered, /1\. Continue safely \[safe\] — Keep the current session/);
  assert.match(rendered, /2\. Start over \[reset\]/);
  assert.match(rendered, /option number, option ID, or exact label/);
});

test("option ID, exact label and 1-based number use Eve response resolution", () => {
  assert.deepEqual(resolveInputReply("safe", [request]), [{ requestId: "request-1", optionId: "safe" }]);
  assert.deepEqual(resolveInputReply("Continue safely", [request]), [{ requestId: "request-1", optionId: "safe" }]);
  assert.deepEqual(resolveInputReply("2", [request]), [{ requestId: "request-1", optionId: "reset" }]);
});

test("empty and invalid closed-choice replies stay pending with actionable instructions", () => {
  assert.equal(resolveInputReply("", [request]), null);
  assert.equal(resolveInputReply("something else", [request]), null);
  assert.match(invalidInputReply([request]), /still need a valid answer/);
  assert.match(invalidInputReply([request]), /1\. Continue safely/);
});

test("freeform requests accept text while multiple requests require a response for every request", () => {
  const freeform = { ...request, requestId: "free", options: undefined, allowFreeform: true };
  assert.deepEqual(resolveInputReply("my own answer", [freeform]), [{ requestId: "free", text: "my own answer" }]);
  assert.equal(resolveInputReply("safe", [request, freeform])?.length, 2);
  assert.equal(resolveInputReply("my own answer", [request, freeform]), null);
});

test("the follower persists cursors and is the publisher for out-of-band resumed output", async () => {
  const states = [];
  const messages = [];
  const prompts = [];
  const session = fakeSession([
    event("input.resolved", { resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }] }),
    event("message.completed", { finishReason: "stop", message: "Resumed answer", sequence: 2, stepIndex: 1, turnId: "turn-1" }),
    event("turn.completed", { sequence: 3, turnId: "turn-1" }),
  ]);

  await followPendingConversation(
    session,
    { id: "session-1", streamIndex: 7, pendingInputRequests: [request], speakerPublicKey: "speaker" },
    {
      onState: (state) => states.push(structuredClone(state)),
      onInputRequested: (requests) => prompts.push(requests),
      onMessage: (message) => messages.push(message),
    },
    new AbortController().signal,
  );

  assert.deepEqual(messages, ["Resumed answer"]);
  assert.deepEqual(prompts, []);
  assert.equal(states.at(-1).streamIndex, 10);
  assert.equal(states.at(-1).pendingInputRequests, undefined);
  assert.equal(states.at(-1).speakerPublicKey, "speaker");
});

test("the follower handles another HITL round and does not terminate at its waiting boundary", async () => {
  const second = { ...request, requestId: "request-2", prompt: "One more choice?" };
  const states = [];
  const prompts = [];
  const session = fakeSession([
    event("input.resolved", { resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }] }),
    event("input.requested", { requests: [second], sequence: 2, stepIndex: 1, turnId: "turn-1" }),
    event("session.waiting", { continuationToken: "session-1", wait: "next-user-message" }),
  ]);

  await followPendingConversation(
    session,
    { id: "session-1", streamIndex: 7, pendingInputRequests: [request], speakerPublicKey: "speaker" },
    {
      onState: (state) => states.push(structuredClone(state)),
      onInputRequested: (requests) => prompts.push(requests),
      onMessage: () => assert.fail("a repeated HITL round has no assistant reply yet"),
    },
    new AbortController().signal,
  );

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0].requestId, "request-2");
  assert.equal(states.at(-1).pendingInputRequests[0].requestId, "request-2");
});


test("submitting a channel reply uses ClientSession.respond without consuming duplicate output", async () => {
  const calls = [];
  const session = {
    async respond(responses, options) {
      calls.push({ responses, options });
      return { result: () => assert.fail("the follower, not respond(), must publish resumed output") };
    },
  };
  const responses = [{ requestId: "request-1", optionId: "safe" }];

  await respondToPendingConversation(session, responses, "relay-a", "channel-1");

  assert.deepEqual(calls, [{
    responses,
    options: {
      clientContext: { buzzCommunity: "relay-a", buzzChannel: "channel-1" },
      streamReconnectPolicy: { reconnect: false },
    },
  }]);
});
