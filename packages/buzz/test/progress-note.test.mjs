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

// eve 1.0: the note is a call the model requests, scoped to its turn.
const note = (callId, message, turnId = "t1") => ({
  type: "call.requested",
  data: { callId, owner: { runId: "r1" }, capability: { kind: "tool", name: "notify__working_on_it" }, input: { message } },
  scope: { turnId },
});
const reply = (value, turnId = "t1") => ({ type: "content.completed", data: { kind: "text", phase: "reply", value }, scope: { turnId } });
const consumed = (turnId = "t1") => ({ type: "delivery.consumed", data: { deliveryId: "d1", turnId, parts: [{ kind: "text", text: "go" }] } });
const settled = () => ({ type: "delivery.settled", data: { deliveryId: "d1", outcome: "handled", turnId: "t1" } });

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
              deliveryId: "d1",
              async *stream() {
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
    consumed(),
    note("c1", "On it. Building your daily calendar page now."),
    {
      type: "call.settled",
      data: { callId: "c1", outcome: "completed", output: { sent: true, kind: "kybernesis.progress-note", message: "On it. Building your daily calendar page now." } },
      scope: { turnId: "t1" },
    },
    note("c2", "Still on it."),
    {
      type: "content.completed",
      scope: { turnId: "t1" },
      get data() {
        postedBeforeAnswer = notes.length === 1;
        return { kind: "text", phase: "reply", value: "Here is your calendar page." };
      },
    },
    settled(),
  ];
  const result = await run(events, notes);
  assert.deepEqual(notes, ["On it. Building your daily calendar page now."]);
  assert.equal(postedBeforeAnswer, true);
  assert.equal(result.message, "Here is your calendar page.");
});

test("a quick answer posts no note", async () => {
  const notes = [];
  await run(
    [consumed(), reply("391."), settled()],
    notes,
  );
  assert.deepEqual(notes, []);
});

test("an earlier turn's note inside the window is not this turn's", async () => {
  const notes = [];
  await run(
    [
      // The turn this message cancelled, still settling inside this delivery's window.
      note("c0", "On it. The old job.", "t0"),
      { type: "turn.settled", data: { turnId: "t0", outcome: "cancelled" } },
      consumed(),
      note("c1", "On it. The new job."),
      reply("Done."),
      settled(),
    ],
    notes,
  );
  assert.deepEqual(notes, ["On it. The new job."]);
});

test("a listener that throws never fails the turn", async () => {
  const result = await answerTurn(
    clientStreaming([consumed(), note("c1", "On it."), reply("Done."), settled()]),
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
