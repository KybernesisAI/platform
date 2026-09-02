import assert from "node:assert/strict";
import { test } from "node:test";

import {
  followPendingConversation,
  formatInputRequests,
  invalidInputReply,
  needsPendingFollower,
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


test("a disconnect after input.resolved keeps durable supervision until recovered output is published", async () => {
  let durable = {
    id: "session-1",
    streamIndex: 7,
    pendingInputRequests: [request],
    speakerPublicKey: "speaker",
  };
  const messages = [];
  const disconnected = {
    state: { sessionId: "session-1", streamIndex: 7 },
    async *stream() {
      yield event("input.resolved", {
        resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }],
      });
      throw new Error("stream disconnected");
    },
  };

  await assert.rejects(
    () => followPendingConversation(
      disconnected,
      durable,
      {
        onState: async (state) => { durable = structuredClone(state); },
        onInputRequested: () => assert.fail("the original request was already resolved"),
        onMessage: () => assert.fail("the stream disconnected before output"),
      },
      new AbortController().signal,
    ),
    /stream disconnected/,
  );

  assert.equal(durable.streamIndex, 8, "recovery resumes after the accepted input resolution");
  assert.equal(durable.pendingInputRequests, undefined);
  assert.equal(durable.resumeInFlight, true, "resolved input remains durably supervised");
  assert.equal(needsPendingFollower(durable), true);

  const recovered = fakeSession([
    event("message.completed", {
      finishReason: "stop",
      message: "Recovered resumed answer",
      sequence: 2,
      stepIndex: 1,
      turnId: "turn-1",
    }),
    event("turn.completed", { sequence: 3, turnId: "turn-1" }),
  ], durable.streamIndex);

  await followPendingConversation(
    recovered,
    durable,
    {
      onState: async (state) => { durable = structuredClone(state); },
      onInputRequested: () => assert.fail("recovery should continue the resolved turn"),
      onMessage: async (message) => {
        assert.equal(durable.resumeInFlight, true, "supervision clears only after publication succeeds");
        messages.push(message);
      },
    },
    new AbortController().signal,
  );

  assert.deepEqual(messages, ["Recovered resumed answer"]);
  assert.equal(durable.streamIndex, 10);
  assert.equal(durable.resumeInFlight, undefined);
  assert.equal(durable.pendingInputRequests, undefined);
  assert.equal(needsPendingFollower(durable), false, "a restart cannot publish the completed output again");
});

test("a failed relay publication retains resume supervision for another follower", async () => {
  let durable = {
    id: "session-1",
    streamIndex: 8,
    resumeInFlight: true,
    speakerPublicKey: "speaker",
  };
  const recovered = fakeSession([
    event("message.completed", {
      finishReason: "stop",
      message: "Retry this publication",
      sequence: 2,
      stepIndex: 1,
      turnId: "turn-1",
    }),
    event("turn.completed", { sequence: 3, turnId: "turn-1" }),
  ], durable.streamIndex);

  await assert.rejects(
    () => followPendingConversation(
      recovered,
      durable,
      {
        onState: async (state) => { durable = structuredClone(state); },
        onInputRequested: () => assert.fail("no new request expected"),
        onMessage: async () => { throw new Error("relay unavailable"); },
      },
      new AbortController().signal,
    ),
    /relay unavailable/,
  );

  assert.equal(durable.streamIndex, 8, "the unpublished message remains replayable");
  assert.equal(durable.resumeInFlight, true);
  assert.equal(needsPendingFollower(durable), true);
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

test("the follower awaits serialized durable state before any resumed publication", async () => {
  let releaseState;
  const stateStored = new Promise((resolve) => { releaseState = resolve; });
  let reachedState = false;
  let published = false;
  const run = followPendingConversation(
    fakeSession([
      event("input.resolved", {
        resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }],
      }),
      event("message.completed", {
        finishReason: "stop",
        message: "Ordered answer",
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-1",
      }),
      event("turn.completed", { sequence: 3, turnId: "turn-1" }),
    ]),
    { id: "session-1", streamIndex: 7, pendingInputRequests: [request], speakerPublicKey: "speaker" },
    {
      onState: async (state) => {
        if (state.resumeInFlight && !reachedState) {
          reachedState = true;
          await stateStored;
        }
      },
      onInputRequested: () => assert.fail("no repeated request expected"),
      onMessage: () => { published = true; },
    },
    new AbortController().signal,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reachedState, true);
  assert.equal(published, false, "publication cannot race ahead of serialized state persistence");
  releaseState();
  await run;
  assert.equal(published, true);
});

test("a resumed turn that ends more than one step with prose is published whole, once", async () => {
  const messages = [];
  const session = fakeSession([
    event("input.resolved", { resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }] }),
    event("message.completed", { finishReason: "stop", message: "The answer.", sequence: 2, stepIndex: 1, turnId: "turn-1" }),
    event("message.completed", { finishReason: "stop", message: "Standing by.", sequence: 3, stepIndex: 2, turnId: "turn-1" }),
    event("turn.completed", { sequence: 4, turnId: "turn-1" }),
  ]);

  await followPendingConversation(
    session,
    { id: "session-1", streamIndex: 7, pendingInputRequests: [request], speakerPublicKey: "speaker" },
    { onState: () => {}, onInputRequested: () => {}, onMessage: (message) => messages.push(message) },
    new AbortController().signal,
  );

  assert.deepEqual(messages, ["The answer.\n\nStanding by."]);
});
