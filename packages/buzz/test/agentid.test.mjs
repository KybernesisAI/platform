import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nameFromDid,
  profileDocumentUrl,
  profileFromName,
  syncProfileFromName,
} from "../dist/agentid.js";

/**
 * Reported from a live deployment: after the names moved to agentid.dev, Kyber's
 * profile in Buzz still pointed its picture at the old address, which had
 * started returning 404, so the workspace showed no picture. The profile had
 * been copied from the name once, by hand, from a host that was no longer
 * where names lived. The bridge now keeps it in step with the name on its own.
 */

const KEY = { publicKey: "p", secretKey: new Uint8Array(32), npub: "npub1test" };
const DOC = {
  name: "Kyber",
  description: "Kybernesis' shared company agent.",
  picture: "https://kyber.agentid.dev/avatar.png",
  nip05: "_@kyber.agent",
};

function fakeFetch(doc, status = 200) {
  const asked = [];
  const impl = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, asked };
}

test("a name is read from its DID, its domain, or itself", () => {
  assert.equal(nameFromDid("did:web:kyber.agent"), "kyber");
  assert.equal(nameFromDid("kyber.agent"), "kyber");
  assert.equal(nameFromDid("Kyber"), "kyber");
  assert.equal(nameFromDid("did:web:example.com"), null);
});

test("the profile document is fetched from the name's agentid.dev address", () => {
  const saved = process.env.AGENTID_MIRROR_SUFFIX;
  delete process.env.AGENTID_MIRROR_SUFFIX;
  try {
    assert.equal(profileDocumentUrl("kyber"), "https://kyber.agentid.dev/.well-known/agent-profile.json");
    process.env.AGENTID_MIRROR_SUFFIX = "staging.example.com";
    assert.equal(profileDocumentUrl("kyber"), "https://kyber.staging.example.com/.well-known/agent-profile.json");
  } finally {
    if (saved === undefined) delete process.env.AGENTID_MIRROR_SUFFIX;
    else process.env.AGENTID_MIRROR_SUFFIX = saved;
  }
});

test("a stale picture is replaced, a matching community is left alone, and other fields survive", async () => {
  const wanted = profileFromName("kyber", DOC);
  const stored = {
    "wss://stale": { ...wanted, picture: "https://kyber.agent.arp.run/avatar.png", lud16: "kyber@example.com" },
    "wss://current": { ...wanted },
  };
  const writes = [];
  const { impl, asked } = fakeFetch(DOC);
  const outcomes = await syncProfileFromName({
    name: "kyber",
    relays: Object.keys(stored),
    key: KEY,
    fetch: impl,
    read: async (url) => stored[url] ?? null,
    write: async (url, _key, profile) => { writes.push([url, profile]); },
  });
  assert.equal(asked[0], "https://kyber.agentid.dev/.well-known/agent-profile.json");
  assert.deepEqual(outcomes.map((o) => [o.relay, o.outcome]), [["wss://stale", "updated"], ["wss://current", "unchanged"]]);
  assert.equal(writes.length, 1, "only the community whose copy differs is written");
  const [url, written] = writes[0];
  assert.equal(url, "wss://stale");
  assert.equal(written.picture, "https://kyber.agentid.dev/avatar.png");
  assert.equal(written.lud16, "kyber@example.com", "fields the name does not decide are kept");
  assert.equal(written.bot, true);
});

test("one community refusing does not stop the others", async () => {
  const { impl } = fakeFetch(DOC);
  const outcomes = await syncProfileFromName({
    name: "kyber",
    relays: ["wss://not-yet", "wss://down", "wss://fine"],
    key: KEY,
    fetch: impl,
    read: async (url) => {
      if (url === "wss://down") throw new Error("could not reach wss://down");
      return null;
    },
    write: async (url) => {
      if (url === "wss://not-yet") throw new Error("not a relay member");
    },
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["not-member", "failed", "updated"]);
});

test("a name with no profile document yet is an error, not an empty profile", async () => {
  const { impl } = fakeFetch({}, 404);
  await assert.rejects(
    syncProfileFromName({ name: "nobody", relays: ["wss://x"], key: KEY, fetch: impl, read: async () => null, write: async () => {} }),
    /no profile document yet \(404/,
  );
});
