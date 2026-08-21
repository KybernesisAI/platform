import assert from "node:assert/strict";
import { test } from "node:test";

import { channelIdentity } from "../dist/channel-identity.js";

const OPTIONS = { issuer: "https://control.example.com", credential: "agent-cred" };

/** A fetch stand-in that records calls and replays canned responses. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { impl, calls };
}

const LINKED = {
  status: 200,
  body: {
    ok: true,
    token: "tok",
    bundle: "bun",
    issuer: "https://control.example.com",
    expiresIn: 300,
    user: { id: "u1", email: "someone@example.com", displayName: "Someone" },
  },
};

test("a linked sender resolves to a session for that person", async () => {
  const { impl, calls } = fakeFetch([LINKED]);
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  const result = await identity.resolve("buzz", "abc123", "npub1…");

  assert.equal(result.linked, true);
  assert.equal(result.token, "tok");
  assert.equal(result.user.email, "someone@example.com");
  assert.equal(calls[0].url, "https://control.example.com/api/agent/identity");
  assert.deepEqual(calls[0].body, { provider: "buzz", externalId: "abc123", label: "npub1…" });
  assert.equal(calls[0].headers.authorization, "Bearer agent-cred");
});

test("a session is reused until it is nearly spent, and re-minted after", async () => {
  const { impl, calls } = fakeFetch([LINKED]);
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  await identity.resolve("buzz", "abc123");
  await identity.resolve("buzz", "abc123");
  assert.equal(calls.length, 1, "the second turn should not mint again");

  identity.forget("buzz", "abc123");
  await identity.resolve("buzz", "abc123");
  assert.equal(calls.length, 2);
});

test("a token about to expire is not handed out", async () => {
  // expiresIn below the refresh skew means it is already considered spent.
  const { impl, calls } = fakeFetch([{ ...LINKED, body: { ...LINKED.body, expiresIn: 10 } }]);
  const identity = channelIdentity({ ...OPTIONS, refreshSkewMs: 30_000, fetchImpl: impl });

  await identity.resolve("buzz", "abc123");
  await identity.resolve("buzz", "abc123");
  assert.equal(calls.length, 2, "a token inside the skew window must be re-minted");
});

test("an unlinked sender comes back with the link that fixes it", async () => {
  const expires = new Date(Date.now() + 900_000).toISOString();
  const { impl } = fakeFetch([
    { status: 404, body: { error: "not_linked", link: "https://control.example.com/link/xyz", expiresAt: expires } },
  ]);
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  const result = await identity.resolve("buzz", "abc123");

  assert.equal(result.linked, false);
  assert.equal(result.reason, "not_linked");
  assert.equal(result.link, "https://control.example.com/link/xyz");
});

test("refusals are reported as refusals, not as missing links", async () => {
  for (const reason of ["agent_not_granted", "user_suspended", "unknown_user"]) {
    const { impl } = fakeFetch([{ status: 403, body: { error: reason } }]);
    const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });
    const result = await identity.resolve("buzz", "abc123");
    assert.equal(result.linked, false);
    assert.equal(result.reason, reason);
    assert.equal("link" in result, false, "a refusal must not offer a link that cannot help");
  }
});

test("a control plane that is down throws, so a room is not locked out by a deploy", async () => {
  const { impl } = fakeFetch([{ status: 500, body: { error: "boom" } }]);
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  await assert.rejects(() => identity.resolve("buzz", "abc123"), /channel identity unavailable: 500/);
});

test("concurrent turns from one sender mint once", async () => {
  let started = 0;
  const impl = async () => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, status: 200, json: async () => LINKED.body };
  };
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  const [a, b, c] = await Promise.all([
    identity.resolve("buzz", "abc123"),
    identity.resolve("buzz", "abc123"),
    identity.resolve("buzz", "abc123"),
  ]);

  assert.equal(started, 1, "a busy room must not stampede the control plane");
  assert.equal(a.token, "tok");
  assert.equal(b.token, "tok");
  assert.equal(c.token, "tok");
});

test("different senders are never confused for each other", async () => {
  const bodies = {
    aaa: { ...LINKED.body, token: "tok-a", user: { id: "ua", email: "a@example.com", displayName: "A" } },
    bbb: { ...LINKED.body, token: "tok-b", user: { id: "ub", email: "b@example.com", displayName: "B" } },
  };
  const impl = async (_url, init) => {
    const { externalId } = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => bodies[externalId] };
  };
  const identity = channelIdentity({ ...OPTIONS, fetchImpl: impl });

  const a = await identity.resolve("buzz", "aaa");
  const b = await identity.resolve("buzz", "bbb");
  assert.equal(a.user.email, "a@example.com");
  assert.equal(b.user.email, "b@example.com");
  assert.equal((await identity.resolve("buzz", "aaa")).token, "tok-a");
});
