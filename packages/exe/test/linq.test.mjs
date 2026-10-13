import { test } from "node:test";
import assert from "node:assert/strict";
import { linqSenderIdentity } from "../dist/linq.js";

/**
 * A text's sender decides whose memory, grants and vault a turn runs with, so
 * the gate is the security boundary of the iMessage line. Each case here is a
 * way a phone number could otherwise become somebody it is not.
 */

const ISSUER = "https://control.example.com";
const NUMBER = "+15555550100";

function fakeThread() {
  const posted = [];
  return { posted, thread: { post: async (text) => { posted.push(text); } } };
}

function resolverReturning(result, calls = []) {
  return { calls, resolve: async (...args) => { calls.push(args); return result; } };
}

const text = (userId = NUMBER, isBot = false) => ({ author: { userId, userName: userId, isBot } });

test("a linked sender runs as their control-plane person, never as the number", async () => {
  const identity = resolverReturning({
    linked: true,
    user: { id: "usr_1", email: "planner@example.com", displayName: "Planner" },
  });
  const { thread, posted } = fakeThread();
  const result = await linqSenderIdentity({ identity, issuer: ISSUER })({ thread }, text());
  assert.deepEqual(identity.calls, [["linq", NUMBER, NUMBER]]);
  assert.deepEqual(result, {
    auth: {
      authenticator: "kybernesis",
      issuer: ISSUER,
      principalId: "usr_1",
      principalType: "user",
      subject: "usr_1",
      attributes: { email: "planner@example.com", display_name: "Planner", surface: "linq", linq_user_id: NUMBER },
    },
  });
  assert.deepEqual(posted, []);
});

test("an unlinked number gets one claim text with its link and no turn", async () => {
  const link = `${ISSUER}/claim/abc123`;
  const identity = resolverReturning({ linked: false, reason: "not_linked", link });
  const { thread, posted } = fakeThread();
  const result = await linqSenderIdentity({ identity, issuer: ISSUER, agentName: "Planner" })({ thread }, text());
  assert.equal(result, null);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].includes(link));
  assert.ok(posted[0].startsWith("Hi, I'm Planner."));
});

test("the claim text can be replaced, and still carries the link", async () => {
  const link = `${ISSUER}/claim/xyz`;
  const identity = resolverReturning({ linked: false, reason: "not_linked", link });
  const { thread, posted } = fakeThread();
  await linqSenderIdentity({ identity, issuer: ISSUER, claimText: (l) => `Link here: ${l}` })({ thread }, text());
  assert.deepEqual(posted, [`Link here: ${link}`]);
});

for (const reason of ["agent_not_granted", "user_suspended", "unknown_user"]) {
  test(`a refused sender (${reason}) gets silence that reveals nothing`, async () => {
    const identity = resolverReturning({ linked: false, reason });
    const { thread, posted } = fakeThread();
    const result = await linqSenderIdentity({ identity, issuer: ISSUER })({ thread }, text());
    assert.equal(result, null);
    assert.deepEqual(posted, []);
  });
}

test("without an agent credential every message is dropped, loudly in the log", async () => {
  const logs = [];
  const { thread, posted } = fakeThread();
  const result = await linqSenderIdentity({ identity: null, issuer: ISSUER, log: (m) => logs.push(m) })({ thread }, text());
  assert.equal(result, null);
  assert.deepEqual(posted, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /KYBERNESIS_AGENT_CREDENTIAL/);
});

test("the agent's own outbound messages are ignored before any lookup", async () => {
  const identity = resolverReturning({ linked: false, reason: "not_linked", link: "x" });
  const { thread, posted } = fakeThread();
  const result = await linqSenderIdentity({ identity, issuer: ISSUER })({ thread }, text(NUMBER, true));
  assert.equal(result, null);
  assert.deepEqual(identity.calls, []);
  assert.deepEqual(posted, []);
});

test("an unreachable control plane throws, rather than reading as a refusal", async () => {
  const identity = { resolve: async () => { throw new Error("channel identity unavailable: 503"); } };
  const { thread, posted } = fakeThread();
  await assert.rejects(linqSenderIdentity({ identity, issuer: ISSUER })({ thread }, text()), /unavailable/);
  assert.deepEqual(posted, []);
});
