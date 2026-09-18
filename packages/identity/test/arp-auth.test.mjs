import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { arpAuth } from "../dist/index.js";

const ISSUER = "https://gateway.test";
const AGENT = "did:web:atlas.agent";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input) === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    return new Response("", { status: 404 });
  };
  const sign = (claims, opts = {}) =>
    new SignJWT({ kind: "arp-push", peer_did: "did:web:ghost.agent", connection_id: "c1", msg_id: "m1", thid: "m1", purpose: "test", obligations: [{ type: "redact_fields", params: { fields: ["ssn"] } }], ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AGENT)
      .setSubject("did:web:ghost.agent")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { sign, restore: () => (globalThis.fetch = realFetch), privateKey };
}

const req = (token) => new Request("https://agent.test/eve/v1/session", { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("accepts a gateway-signed push token for this agent and exposes the peer as the principal", async () => {
  const { sign, restore } = await setup();
  try {
    const auth = arpAuth({ issuer: ISSUER, agentDid: AGENT });
    const session = await auth(req(await sign()));
    assert.equal(session.principalType, "agent");
    assert.equal(session.authenticator, "arp");
    assert.equal(session.principalId, "did:web:ghost.agent");
    assert.equal(session.subject, "arp:did:web:ghost.agent");
    assert.equal(session.attributes.peerName, "ghost");
    assert.equal(session.attributes.connectionId, "c1");
    assert.deepEqual(session.attributes.obligationTypes, ["redact_fields"]);
  } finally {
    restore();
  }
});

test("skips (null) for no token, non-ARP tokens, wrong audience, and wrong issuer; never throws", async () => {
  const { sign, restore } = await setup();
  try {
    const auth = arpAuth({ issuer: ISSUER, agentDid: AGENT });
    assert.equal(await auth(req(null)), null);
    assert.equal(await auth(req("not.a.jwt")), null);
    assert.equal(await auth(req(await sign({}, { audience: "did:web:other.agent" }))), null);
    assert.equal(await auth(req(await sign({}, { issuer: "https://evil.test" }))), null);
    assert.equal(await auth(req(await sign({ kind: "something-else" }))), null);
  } finally {
    restore();
  }
});

test("rejects a token signed by another key", async () => {
  const a = await setup();
  const { privateKey: other } = await generateKeyPair("ES256");
  try {
    const forged = await new SignJWT({ kind: "arp-push", peer_did: "did:web:ghost.agent" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(ISSUER).setAudience(AGENT).setSubject("did:web:ghost.agent").setIssuedAt().setExpirationTime("5m").sign(other);
    const auth = arpAuth({ issuer: ISSUER, agentDid: AGENT });
    assert.equal(await auth(req(forged)), null);
  } finally {
    a.restore();
  }
});
