import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionStore } from "../dist/sessions.js";
import { answerTurn } from "../dist/turn.js";

function storeWith() {
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "buzz-progress-")), "sessions.json"));
  store.set("relay", "channel", { id: "s1", streamIndex: 4 });
  return store;
}

const note = (callId, message, turnId = "t1") => ({
  type: "actions.requested",
  data: { turnId, actions: [{ callId, kind: "tool-call", toolName: "notify__working_on_it", input: { message } }] },
});

function clientStreaming(events) {
  return {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 5 },
          async *stream() {},
          async send() {
            return {
              sessionId: id,
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
            };
          },
        };
      },
      async create() {
        throw new Error("must continue the existing session");
      },
    },
  };
}

const run = (events, notes) =>
  answerTurn(clientStreaming(events), storeWith(), "channel", "make me a page", "relay", () => {}, 60_000, 60_000, 1_000, (text) =>
    notes.push(text),
  );

test("a long job's note is posted while the turn runs, once, and the answer stays the reply", async () => {
  const notes = [];
  let postedBeforeAnswer = false;
  const events = [
    { type: "turn.started", data: { turnId: "t1" } },
    note("c1", "On it. Building your daily calendar page now."),
    {
      type: "action.result",
      data: { turnId: "t1", status: "completed", result: { callId: "c1", toolName: "notify__working_on_it", output: { sent: true, message: "On it. Building your daily calendar page now." } } },
    },
    note("c2", "Still on it."),
    {
      type: "message.completed",
      get data() {
        postedBeforeAnswer = notes.length === 1;
        return { finishReason: "stop", message: "Here is your calendar page." };
      },
    },
    { type: "session.waiting", data: {} },
  ];
  const result = await run(events, notes);
  assert.deepEqual(notes, ["On it. Building your daily calendar page now."]);
  assert.equal(postedBeforeAnswer, true);
  assert.equal(result.message, "Here is your calendar page.");
});

test("a quick answer posts no note", async () => {
  const notes = [];
  await run(
    [
      { type: "turn.started", data: { turnId: "t1" } },
      { type: "message.completed", data: { finishReason: "stop", message: "391." } },
      { type: "session.waiting", data: {} },
    ],
    notes,
  );
  assert.deepEqual(notes, []);
});

test("an earlier turn's note on the stream's tail is not this turn's", async () => {
  const notes = [];
  await run(
    [
      { type: "session.waiting", data: {} },
      note("c0", "On it. The old job.", "t0"),
      { type: "turn.started", data: { turnId: "t1" } },
      note("c1", "On it. The new job."),
      { type: "message.completed", data: { finishReason: "stop", message: "Done." } },
      { type: "session.waiting", data: {} },
    ],
    notes,
  );
  assert.deepEqual(notes, ["On it. The new job."]);
});

test("a listener that throws never fails the turn", async () => {
  const result = await answerTurn(
    clientStreaming([
      { type: "turn.started", data: { turnId: "t1" } },
      note("c1", "On it."),
      { type: "message.completed", data: { finishReason: "stop", message: "Done." } },
      { type: "session.waiting", data: {} },
    ]),
    storeWith(),
    "channel",
    "go",
    "relay",
    () => {},
    60_000,
    60_000,
    1_000,
    () => {
      throw new Error("relay closed");
    },
  );
  assert.equal(result.message, "Done.");
});
