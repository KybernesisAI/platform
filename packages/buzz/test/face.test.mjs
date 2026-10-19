import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { resolveFace, syncProfile } from "../dist/face.js";

/**
 * Reported from a live deployment: the owner gave the agent a new name and picture in the
 * app, and Buzz kept showing the bare registered name and no picture. Joining published only
 * the name, nothing ever sent the owner's choice, and the `.agent` name sync would have put
 * the old picture back anyway. The bridge now reads the face its owner set.
 */

const KEY = { publicKey: "p", secretKey: new Uint8Array(32), npub: "npub1test" };
// A 1x1 transparent PNG with no metadata chunks, so stripping leaves it unchanged.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_SHA = createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex");
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

function routes(map) {
  const asked = [];
  const impl = async (url, init) => {
    asked.push([String(url), init?.headers?.authorization ?? null]);
    const hit = Object.entries(map).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return new Response("{}", { status: 404 });
    const [status, body] = hit[1];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, asked };
}

const NAME_DOC = { name: "Planner", description: "Plans the week.", picture: "https://planner.agentid.dev/a.png", nip05: "_@planner.agent" };

test("the owner's name and picture win over the .agent name, which fills the gaps", async () => {
  const { impl, asked } = routes({
    "https://cp.example/api/agent/profile": [200, { agent: "planner", displayName: "Pip", picture: DATA_URL, about: null, nip05: null }],
    "https://planner.agentid.dev/": [200, NAME_DOC],
  });
  const face = await resolveFace({ name: "planner", issuer: "https://cp.example/", credential: "cred", fetch: impl });
  assert.deepEqual(face, { handle: "planner", displayName: "Pip", picture: DATA_URL, about: "Plans the week.", nip05: "_@planner.agent" });
  assert.deepEqual(asked[0], ["https://cp.example/api/agent/profile", "Bearer cred"]);
});

test("an older control plane without the route still syncs from the .agent name", async () => {
  const { impl } = routes({ "https://planner.agentid.dev/": [200, NAME_DOC] });
  const face = await resolveFace({ name: "planner", issuer: "https://cp.example", credential: "cred", fetch: impl });
  assert.equal(face.displayName, "Planner");
  assert.equal(face.picture, "https://planner.agentid.dev/a.png");
});

test("an agent with no .agent name takes its handle from its registered name, and nothing chosen stays unset", async () => {
  const { impl } = routes({
    "https://cp.example/api/agent/profile": [200, { agent: "Field Ops", displayName: null, picture: null, about: null, nip05: null }],
  });
  const face = await resolveFace({ name: null, issuer: "https://cp.example", credential: "cred", fetch: impl });
  assert.deepEqual(face, { handle: "field-ops", displayName: null, picture: null, about: null, nip05: null });
});

test("no source at all is an error, not an empty profile", async () => {
  const { impl } = routes({});
  await assert.rejects(resolveFace({ name: null, issuer: "https://cp.example", credential: "cred", fetch: impl }), /404/);
});

test("a data URL picture is uploaded once, used everywhere, and the name lands with it", async () => {
  const stored = {
    "wss://a": { name: "planner", display_name: "planner", lud16: "x@example.com" },
    "wss://b": null,
  };
  const uploads = [];
  const writes = [];
  const outcomes = await syncProfile({
    face: { handle: "planner", displayName: "Pip", picture: DATA_URL, about: null, nip05: null },
    relays: Object.keys(stored),
    key: KEY,
    read: async (url) => stored[url],
    write: async (url, _key, profile) => writes.push([url, profile]),
    upload: async (url, _key, bytes, mediaType) => {
      uploads.push([url, mediaType, bytes.length]);
      return `https://a.example/${PNG_SHA}.png`;
    },
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["updated", "updated"]);
  assert.equal(uploads.length, 1, "uploaded to the first community only");
  assert.equal(uploads[0][1], "image/png");
  for (const [, profile] of writes) {
    assert.equal(profile.display_name, "Pip");
    assert.equal(profile.picture, `https://a.example/${PNG_SHA}.png`);
    assert.equal(profile.bot, true);
  }
  assert.equal(writes[0][1].lud16, "x@example.com", "fields the face does not decide are kept");
});

test("a community already showing this picture and name is left alone, with no upload", async () => {
  const current = { name: "planner", display_name: "Pip", picture: `https://a.example/${PNG_SHA}.png`, bot: true };
  let uploaded = false;
  let written = false;
  const outcomes = await syncProfile({
    face: { handle: "planner", displayName: "Pip", picture: DATA_URL, about: null, nip05: null },
    relays: ["wss://a"],
    key: KEY,
    read: async () => current,
    write: async () => {
      written = true;
    },
    upload: async () => {
      uploaded = true;
      return "never";
    },
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["unchanged"]);
  assert.equal(uploaded, false);
  assert.equal(written, false);
});

test("nothing chosen keeps a name and picture someone set there by hand", async () => {
  const writes = [];
  await syncProfile({
    face: { handle: "planner", displayName: null, picture: null, about: null, nip05: null },
    relays: ["wss://a"],
    key: KEY,
    read: async () => ({ name: "planner", display_name: "Hand set", picture: "https://x.example/p.png" }),
    write: async (_url, _key, profile) => writes.push(profile),
  });
  assert.equal(writes[0].display_name, "Hand set");
  assert.equal(writes[0].picture, "https://x.example/p.png");
});

test("a picture no community takes still sends the name, and says so", async () => {
  const writes = [];
  const outcomes = await syncProfile({
    face: { handle: "planner", displayName: "Pip", picture: DATA_URL, about: null, nip05: null },
    relays: ["wss://a", "wss://not-yet"],
    key: KEY,
    read: async (url) => {
      if (url === "wss://not-yet") throw new Error("not a relay member");
      return { name: "planner", display_name: "planner", picture: "https://old.example/p.png" };
    },
    write: async (_url, _key, profile) => writes.push(profile),
    upload: async () => {
      throw new Error("the community refused the image: 413");
    },
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["updated", "not-member"]);
  assert.match(outcomes[0].detail, /picture not sent: .*413/);
  assert.equal(writes[0].display_name, "Pip");
  assert.equal(writes[0].picture, "https://old.example/p.png");
});
