import assert from "node:assert/strict";
import { test } from "node:test";
import { arpPeers, askPeer, discoverPeers, toolName } from "../dist/index.js";

const ISSUER = "https://gateway.test";
const calls = [];
const fetchImpl = async (input, init = {}) => {
  calls.push({ url: String(input), init });
  if (String(input) === `${ISSUER}/agent-api/connections`) {
    if (!init.headers?.authorization?.includes("good")) return new Response("{}", { status: 401 });
    return Response.json({ connections: [{ connection_id: "c1", peer_did: "did:web:ghost.agent", peer_name: "ghost", purpose: "research" }] });
  }
  if (String(input) === `${ISSUER}/agent-api/send`) {
    const body = JSON.parse(init.body);
    if (body.text === "deny me") return Response.json({ ok: false, error: "denied", reason: "not in scope" }, { status: 403 });
    if (body.text === "slow") return Response.json({ ok: true, reply: null, timed_out: true }, { status: 202 });
    return Response.json({ ok: true, reply: `pong: ${body.text}` });
  }
  return new Response("", { status: 404 });
};

test("tool names are stable slugs", () => {
  assert.equal(toolName("ghost"), "ask_ghost");
  assert.equal(toolName("Support Bot"), "ask_support_bot");
});

test("discovers peers with a credential and degrades to [] without one or on 401", async () => {
  assert.deepEqual(await discoverPeers({ issuer: ISSUER, credential: "", fetchImpl }), []);
  assert.deepEqual(await discoverPeers({ issuer: ISSUER, credential: "bad", fetchImpl, cacheMs: 0 }), []);
  const peers = await discoverPeers({ issuer: ISSUER, credential: "good", fetchImpl, cacheMs: 0 });
  assert.deepEqual(peers, [{ connectionId: "c1", peerDid: "did:web:ghost.agent", name: "ghost", purpose: "research" }]);
});

test("askPeer returns the reply, a decline for 403, and a pending note on timeout", async () => {
  const peer = { connectionId: "c1", peerDid: "did:web:ghost.agent", name: "ghost", purpose: null };
  const o = { issuer: ISSUER, credential: "good", fetchImpl, timeoutMs: 1000 };
  assert.equal(await askPeer(o, peer, "ping"), "pong: ping");
  assert.match(await askPeer(o, peer, "deny me"), /declined: not in scope/);
  assert.match(await askPeer(o, peer, "slow"), /has not replied yet/);
  const sent = calls.filter((c) => c.url.endsWith("/agent-api/send")).at(-1);
  assert.equal(JSON.parse(sent.init.body).connection_id, "c1");
});

test("arpPeers exposes one ask_<peer> tool per connection on turn.started", async () => {
  const dyn = arpPeers({ issuer: ISSUER, credential: "good", fetchImpl, cacheMs: 0 });
  const handler = dyn.events?.["turn.started"] ?? dyn["turn.started"];
  assert.equal(typeof handler, "function");
  const tools = await handler({});
  assert.ok(tools && tools.ask_ghost, "ask_ghost tool present");
});
