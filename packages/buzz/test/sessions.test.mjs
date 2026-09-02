import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../dist/sessions.js";

const dir = () => mkdtempSync(join(tmpdir(), "buzz-sessions-"));

/**
 * Reported from a live deployment: a DM held one conversation for half an hour,
 * the agent was restarted while skills were mounted, and the next message got
 * "I have no context". The eve session was intact on disk the whole time — what
 * did not survive was the bridge's knowledge of WHICH session belonged to that
 * channel, which lived only in memory. Durable on one side, ephemeral on the
 * other, and the join between them was the part that could not survive.
 */

test("a conversation survives the process that started it", () => {
  const file = join(dir(), "sessions.json");
  const first = new SessionStore(file);
  first.set("relay-a", "channel-1", { id: "wrun_abc", streamIndex: 12 });

  // The restart.
  const second = new SessionStore(file);
  assert.deepEqual(
    { id: second.get("relay-a", "channel-1")?.id, streamIndex: second.get("relay-a", "channel-1")?.streamIndex },
    { id: "wrun_abc", streamIndex: 12 },
  );
});

test("channels are scoped per community, because channel ids are issued per relay", () => {
  const file = join(dir(), "sessions.json");
  const store = new SessionStore(file);
  store.set("relay-a", "same-id", { id: "wrun_a", streamIndex: 1 });
  store.set("relay-b", "same-id", { id: "wrun_b", streamIndex: 2 });

  assert.equal(store.get("relay-a", "same-id")?.id, "wrun_a");
  assert.equal(store.get("relay-b", "same-id")?.id, "wrun_b");
});

test("a session the agent no longer holds can be forgotten, and stays forgotten", () => {
  const file = join(dir(), "sessions.json");
  const store = new SessionStore(file);
  store.set("relay-a", "channel-1", { id: "wrun_gone", streamIndex: 3 });
  store.delete("relay-a", "channel-1");

  assert.equal(new SessionStore(file).get("relay-a", "channel-1"), undefined);
});

test("a corrupt store costs history, not the agent", () => {
  const file = join(dir(), "sessions.json");
  writeFileSync(file, "{ this is not json");
  const errors = [];
  // Refusing to start would turn a lost mapping into a dead bridge.
  const store = new SessionStore(file, { onError: (message) => errors.push(message) });
  assert.equal(store.size, 0);
  assert.match(errors[0], /could not load Buzz session store/);
  store.set("relay-a", "channel-1", { id: "wrun_new", streamIndex: 0 });
  assert.equal(new SessionStore(file).get("relay-a", "channel-1")?.id, "wrun_new");
});

test("an unwritable store is reported while the bridge remains usable", () => {
  const blocker = join(dir(), "not-a-directory");
  writeFileSync(blocker, "file");
  const errors = [];
  const store = new SessionStore(join(blocker, "sessions.json"), {
    onError: (message) => errors.push(message),
  });
  store.set("relay-a", "channel-1", { id: "wrun_memory_only", streamIndex: 1 });

  assert.equal(store.get("relay-a", "channel-1")?.id, "wrun_memory_only");
  assert.match(errors[0], /could not write Buzz session store/);
});

test("conversations nobody has touched for a month are not carried forever", () => {
  const file = join(dir(), "sessions.json");
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  writeFileSync(
    file,
    JSON.stringify({
      "relay-a|stale": { id: "wrun_old", streamIndex: 1, updated: old },
      "relay-a|fresh": { id: "wrun_new", streamIndex: 1, updated: Date.now() },
    }),
  );
  const store = new SessionStore(file);
  assert.equal(store.get("relay-a", "stale"), undefined);
  assert.equal(store.get("relay-a", "fresh")?.id, "wrun_new");
});

test("the file is written atomically, so a restart mid-write cannot truncate it", () => {
  const file = join(dir(), "sessions.json");
  const store = new SessionStore(file);
  store.set("relay-a", "channel-1", { id: "wrun_abc", streamIndex: 5 });
  // The temp file must not survive: a leftover means the rename never happened.
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.equal(existsSync(file), true);
});

test("pending HITL state and follower identity survive restart and can be enumerated", () => {
  const file = join(dir(), "sessions.json");
  const request = {
    requestId: "request-1",
    kind: "question",
    prompt: "Continue?",
    action: { kind: "tool-call", callId: "call-1", toolName: "ask_question", input: {} },
    options: [{ id: "yes", label: "Yes" }],
  };
  const first = new SessionStore(file);
  first.set("relay-a", "channel-1", {
    id: "wrun_pending",
    streamIndex: 12,
    pending: [request],
    speaker: "speaker-pubkey",
  });

  const second = new SessionStore(file);
  assert.equal(second.pending().length, 1);
  assert.equal(second.pending()[0].community, "relay-a");
  assert.equal(second.pending()[0].channel, "channel-1");
  assert.deepEqual(second.pending()[0].session.pending, [request]);
  assert.equal(second.pending()[0].session.speaker, "speaker-pubkey");
});

test("old session records without routing or pending fields remain readable", () => {
  const file = join(dir(), "sessions.json");
  writeFileSync(file, JSON.stringify({
    "relay-old|channel-old": { id: "wrun_old_shape", streamIndex: 3, updated: Date.now() },
  }));
  const store = new SessionStore(file);
  assert.equal(store.entries()[0].community, "relay-old");
  assert.equal(store.entries()[0].channel, "channel-old");
  assert.equal(store.pending().length, 0);
});
