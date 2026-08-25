import assert from "node:assert/strict";
import { test } from "node:test";

import { speakerCredentials } from "../dist/credentials.js";

/**
 * The failure this guards against arrived only after a different bug was fixed.
 *
 * An identity token lives about five minutes. While turns ended early nothing
 * ever outlived one. Once they ran to completion, a six-minute turn reconnected
 * its stream with the token it started with and the agent answered
 * "Authorization is required for this route" — after every tool call had
 * already succeeded. In a channel that looks like the agent typing for five
 * minutes and then saying nothing.
 */

test("every request resolves the credential again, so a long turn stays authorized", async () => {
  let minted = 0;
  const resolve = async () => ({
    linked: true,
    token: `token-${++minted}`,
    bundle: "bundle",
    user: { id: "u1", email: "someone@example.com", displayName: "Someone" },
  });
  const credentials = speakerCredentials(resolve)("npub-1");

  // Three HTTP calls across one long turn: the POST, then two stream reconnects.
  assert.equal(await credentials.bearer(), "token-1");
  assert.equal(await credentials.bearer(), "token-2");
  assert.equal(await credentials.bearer(), "token-3");
  assert.equal(minted, 3, "captured once would have reused token-1 until it expired");
});

test("headers travel with the token they belong to", async () => {
  const resolve = async () => ({
    linked: true,
    token: "t",
    bundle: "bundle-9",
    user: { id: "u1", email: "someone@example.com", displayName: "Someone" },
  });
  const credentials = speakerCredentials(resolve)("npub-1");

  assert.deepEqual(await credentials.headers(), { "x-kybernesis-bundle": "bundle-9" });
});

test("access withdrawn mid-turn stops the next request", async () => {
  let calls = 0;
  const resolve = async () =>
    ++calls === 1
      ? {
          linked: true,
          token: "t",
          bundle: "b",
          user: { id: "u1", email: "someone@example.com", displayName: "Someone" },
        }
      : { linked: false, reason: "agent_not_granted" };
  const credentials = speakerCredentials(resolve)("npub-1");

  assert.equal(await credentials.bearer(), "t");
  // The point of a five-minute token: revocation lands during the turn, not
  // after it. Finishing with a withdrawn credential would be the worse outcome.
  await assert.rejects(() => credentials.bearer(), /no longer authorized \(agent_not_granted\)/);
});
