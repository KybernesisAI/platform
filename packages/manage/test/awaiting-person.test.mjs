import assert from "node:assert/strict";
import { test } from "node:test";

import { awaitingPerson, sessionAwaitingPerson } from "../dist/awaiting-person.js";

/**
 * Why this exists: routines deliver into the same conversation the person types
 * in, and eve resolves a pending question with the NEXT message to arrive. A
 * routine firing on a timer would therefore answer a question meant for them,
 * with its own prompt, and the agent would treat that as consent.
 */
test("an unanswered question means the person is owed a reply", () => {
  assert.equal(awaitingPerson([{ type: "input.requested", batchId: "b1" }]), true);
});

test("an answered question does not block a routine", () => {
  assert.equal(
    awaitingPerson([
      { type: "input.requested", batchId: "b1" },
      { type: "input.resolved", batchId: "b1" },
    ]),
    false,
  );
});

test("only the unanswered batch counts when several have been asked", () => {
  assert.equal(
    awaitingPerson([
      { type: "input.requested", batchId: "b1" },
      { type: "input.resolved", batchId: "b1" },
      { type: "input.requested", batchId: "b2" },
    ]),
    true,
    "b2 is still open",
  );
});

test("batch ids are read from either shape the stream uses", () => {
  assert.equal(
    awaitingPerson([
      { type: "input.requested", data: { batchId: "b1" } },
      { type: "input.resolved", data: { batchId: "b1" } },
    ]),
    false,
  );
});

test("a request with no batch id still blocks — losing the id must not lose the guard", () => {
  assert.equal(awaitingPerson([{ type: "input.requested" }]), true);
  assert.equal(awaitingPerson([{ type: "input.requested" }, { type: "input.resolved" }]), false);
});

test("ordinary traffic is not mistaken for a pending question", () => {
  assert.equal(
    awaitingPerson([{ type: "text" }, { type: "tool.started" }, { type: "session.completed" }]),
    false,
  );
});

/** A stream that cannot be read must not silence every routine forever. */
test("an unreadable stream lets the routine through", async () => {
  const broken = {
    getStreamTailIndex: async () => {
      throw new Error("stream gone");
    },
    getEventStream: async () => {
      throw new Error("stream gone");
    },
  };
  assert.equal(await sessionAwaitingPerson(broken), false);
});

test("a live session's tail is read and a pending question is found", async () => {
  const events = [{ type: "text" }, { type: "input.requested", batchId: "b9" }];
  const session = {
    getStreamTailIndex: async () => events.length,
    getEventStream: async () =>
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(e);
          c.close();
        },
      }),
  };
  assert.equal(await sessionAwaitingPerson(session), true);
});
