import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ClientError } from "eve/client";
import { SessionStore } from "../dist/sessions.js";
import { answerTurn, isSessionGone } from "../dist/turn.js";

/**
 * A session that ended (eve answers 409 session_not_active, "The session is
 * no longer active.") must be replaced, exactly like an unknown one (404).
 * Keeping it means every later message in that channel fails the same way
 * until a person edits the store. That happened on 2026-09-03 after a turn
 * failed at the gateway. Errors that say nothing about the session's life
 * still keep the mapping.
 */

function storeWith(id = "session-dead") {
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "buzz-dead-")), "sessions.json"));
  store.set("relay", "channel", { id, streamIndex: 3 });
  return store;
}

function completed(id) {
  return { sessionId: id, async *[Symbol.asyncIterator]() {
    yield { type: "message.completed", data: { finishReason: "stop", message: "fresh answer" } };
    yield { type: "session.completed", data: {} };
  } };
}

test("isSessionGone: 404, and 409 session_not_active, mean gone; everything else does not", () => {
  assert.equal(isSessionGone(new ClientError(404, "session not found")), true);
  const gone = new ClientError(409, JSON.stringify({ code: "session_not_active", error: "The session is no longer active.", ok: false }));
  assert.equal(isSessionGone(gone), true, "409 session_not_active");
  assert.equal(isSessionGone(new ClientError(409, "The session is no longer active.")), true, "409 by message");
  assert.equal(isSessionGone(new ClientError(409, "another turn is in flight")), false);
  assert.equal(isSessionGone(new ClientError(400, "Unsupported message part type")), false);
  assert.equal(isSessionGone(new ClientError(500, "boom")), false);
  assert.equal(isSessionGone(new TypeError("fetch failed")), false);
});

test("a 409 'no longer active' on send replaces the session and the reply comes from the new one", async () => {
  const store = storeWith();
  const logs = [];
  let created = 0;
  const client = {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 3 },
          stream: async function* () {},
          send: async () => { throw new ClientError(409, JSON.stringify({ code: "session_not_active", error: "The session is no longer active.", ok: false })); },
        };
      },
      async create() {
        created += 1;
        return { response: completed("session-new"), session: { state: { sessionId: "session-new", streamIndex: 1 } } };
      },
    },
  };
  const result = await answerTurn(client, store, "channel", "hey", "relay", (m) => logs.push(m));
  assert.equal(created, 1);
  assert.equal(result.message, "fresh answer");
  assert.equal(store.get("relay", "channel").id, "session-new");
  assert.ok(logs.some((m) => m.includes("could not continue") && m.includes("no longer active")));
});

test("a 400 on send still keeps the session", async () => {
  const store = storeWith("session-alive");
  const client = {
    sessions: {
      attach(id) {
        return { state: { sessionId: id, streamIndex: 3 }, stream: async function* () {}, send: async () => { throw new ClientError(400, "Unsupported message part type"); } };
      },
      async create() { throw new Error("must not create"); },
    },
  };
  await assert.rejects(() => answerTurn(client, store, "channel", "hey", "relay"), (e) => e instanceof ClientError && e.status === 400);
  assert.equal(store.get("relay", "channel").id, "session-alive");
});

/**
 * A stored run that died under a runtime upgrade answers nothing when its
 * backlog is read — no events, no error, no end. Found on Kyber on 2026-10-05
 * after the eve 0.68 cutover: every message in #general sat at "typing"
 * because the drain waited on a stream that never finished and never
 * reached the agent. The backlog read has its own short bound; when it
 * trips, the conversation is replaced like a 404 would be.
 */
test("a backlog that never finishes is skipped; the dead run's own answer replaces the session", async () => {
  const store = storeWith("session-zombie");
  const logs = [];
  let created = 0;
  const client = {
    sessions: {
      attach(id) {
        return {
          state: { sessionId: id, streamIndex: 3 },
          stream: async function* ({ signal }) {
            await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          },
          // eve answers a dead run's send the way it answers an ended one.
          send: async () => { throw new ClientError(409, JSON.stringify({ code: "session_not_active", error: "The session is no longer active.", ok: false })); },
        };
      },
      async create() {
        created += 1;
        return { response: completed("session-new"), session: { state: { sessionId: "session-new", streamIndex: 1 } } };
      },
    },
  };
  const started = Date.now();
  const result = await answerTurn(client, store, "channel", "hey", "relay", (m) => logs.push(m), 5 * 60_000, 60 * 60_000, 200);
  assert.ok(Date.now() - started < 5_000, "gave up on the backlog quickly");
  assert.equal(created, 1, "a fresh session was created");
  assert.equal(result.message, "fresh answer");
  assert.equal(store.get("relay", "channel")?.id, "session-new");
  assert.ok(logs.some((m) => /did not finish reading in 200ms/.test(m)), logs.join("\n"));
});
