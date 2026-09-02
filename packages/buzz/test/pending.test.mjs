import assert from "node:assert/strict";
import { test } from "node:test";

import { followPendingSession } from "../dist/pending.js";

const request = {
  requestId: "request-1",
  kind: "question",
  prompt: "Continue?",
  action: { kind: "tool-call", callId: "call-1", toolName: "ask_question", input: {} },
  options: [{ id: "yes", label: "Yes" }],
};
const nextRequest = {
  ...request,
  requestId: "request-2",
  prompt: "Choose again",
};
const meta = { id: "event", at: "2026-09-02T00:00:00.000Z" };

function clientWith(events, calls) {
  return {
    sessions: {
      attach(id, options) {
        calls.attach = { id, options };
        return {
          async *stream(options) {
            calls.stream = options;
            for (const event of events) yield event;
          },
        };
      },
    },
  };
}

test("follower starts at the durable cursor and delivers an out-of-band answer once", async () => {
  const calls = {};
  const progress = [];
  const messages = [];
  const result = await followPendingSession({
    client: clientWith([
      { type: "input.resolved", data: { resolutions: [], sequence: 1, stepIndex: 1, turnId: "turn" }, meta },
      { type: "message.completed", data: { message: "resumed answer", finishReason: "stop", sequence: 1, stepIndex: 2, turnId: "turn" }, meta },
      { type: "session.waiting", data: { continuationToken: "session", wait: "next-user-message" }, meta },
    ], calls),
    session: { id: "session", streamIndex: 7, pending: [request], speaker: "speaker", updated: 1 },
    signal: new AbortController().signal,
    onProgress: (value) => progress.push(value),
    onPrompt: () => assert.fail("no new prompt expected"),
    onMessage: (message) => messages.push(message),
  });

  assert.equal(result, "settled");
  assert.deepEqual(calls.attach, { id: "session", options: { streamIndex: 7 } });
  assert.equal(calls.stream.startIndex, 7);
  assert.equal(calls.stream.follow, true);
  assert.deepEqual(messages, ["resumed answer"]);
  assert.equal(progress.at(-1).streamIndex, 10);
});

test("a repeated HITL park restarts at its cursor and later delivers out of band", async () => {
  const prompts = [];
  const messages = [];
  const pendingStates = [];
  const starts = [];
  const streams = [
    [
      { type: "input.resolved", data: { resolutions: [], sequence: 1, stepIndex: 1, turnId: "turn-1" }, meta },
      { type: "input.requested", data: { requests: [nextRequest], sequence: 1, stepIndex: 2, turnId: "turn-1" }, meta },
      { type: "session.waiting", data: { continuationToken: "session", wait: "next-user-message" }, meta },
    ],
    [
      { type: "input.resolved", data: { resolutions: [], sequence: 2, stepIndex: 1, turnId: "turn-2" }, meta },
      { type: "message.completed", data: { message: "answer after second park", finishReason: "stop", sequence: 2, stepIndex: 2, turnId: "turn-2" }, meta },
      { type: "session.waiting", data: { continuationToken: "session", wait: "next-user-message" }, meta },
    ],
  ];
  let durable = { id: "session", streamIndex: 2, pending: [request], speaker: "speaker", updated: 1 };
  const client = {
    sessions: {
      attach() {
        const events = streams.shift();
        assert.ok(events, "the follower must attach once for each parked boundary");
        return {
          async *stream(options) {
            starts.push(options.startIndex);
            for (const event of events) yield event;
          },
        };
      },
    },
  };
  const follow = () => followPendingSession({
    client,
    session: durable,
    signal: new AbortController().signal,
    onProgress: ({ streamIndex, pending }) => {
      pendingStates.push(pending);
      durable = { ...durable, streamIndex, pending };
    },
    onPrompt: (requests) => prompts.push(requests),
    onMessage: (message) => {
      messages.push(message);
      durable = { ...durable, pending: [] };
    },
  });

  assert.equal(await follow(), "parked");
  assert.deepEqual(durable.pending, [nextRequest]);
  assert.deepEqual(prompts, [[nextRequest]]);

  assert.equal(await follow(), "settled");
  assert.deepEqual(starts, [2, 5]);
  assert.deepEqual(messages, ["answer after second park"]);
  assert.equal(pendingStates.some((pending) => pending.length === 0), true);
  assert.deepEqual(durable.pending, []);
  assert.equal(streams.length, 0);
});

test("aborting a follower prevents later delivery", async () => {
  const controller = new AbortController();
  const messages = [];
  const client = {
    sessions: {
      attach() {
        return {
          async *stream({ signal }) {
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
              controller.abort();
            });
          },
        };
      },
    },
  };

  const result = await followPendingSession({
    client,
    session: { id: "session", streamIndex: 0, pending: [request], speaker: "speaker", updated: 1 },
    signal: controller.signal,
    onProgress: () => {},
    onPrompt: () => {},
    onMessage: (message) => messages.push(message),
  });
  assert.equal(result, "aborted");
  assert.deepEqual(messages, []);
});
