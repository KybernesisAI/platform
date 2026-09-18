import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { handleConnect, resolveIdentity, saveIdentity, storeKind, identityFilePath } from "../dist/index.js";

const { privateKey, publicKey } = await generateKeyPair("ES256");
const pub = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

/** Fake ARP Cloud: JWKS + bootstrap redemption (single use). */
function fakeIssuer() {
  const redeemed = new Set();
  const server = createServer(async (req, res) => {
    if (req.url === "/.well-known/jwks.json") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [pub] })); return; }
    if (req.url === "/agent-api/bootstrap" && req.method === "POST") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (redeemed.has(token)) { res.writeHead(409).end(JSON.stringify({ error: "token_used" })); return; }
      redeemed.add(token);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ did: "did:web:atlas.agent", issuer: base(), credential: "cred-" + "x".repeat(40), challenge: "chal-1" }));
      return;
    }
    res.writeHead(404).end();
  });
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  return { start: () => new Promise((r) => server.listen(0, "127.0.0.1", () => { port = server.address().port; r(base()); })), stop: () => server.close(), base };
}
async function mint(issuer, aud, extra = {}) {
  return new SignJWT({ kind: "arp-connect", did: "did:web:atlas.agent", url: `${aud}/eve/v1/arp`, challenge: "chal-1", ...extra })
    .setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(issuer).setAudience(aud).setSubject("did:web:atlas.agent").setJti("t1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

test("connect: verifies the token, redeems it, and persists the identity for auth + peers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arp-id-"));
  process.env.ARP_IDENTITY_FILE = join(dir, "arp-identity.json");
  delete process.env.ARP_AGENT_DID; delete process.env.ARP_AGENT_CREDENTIAL; delete process.env.AGENTID_CHALLENGE;
  const iss = fakeIssuer(); const issuer = await iss.start();
  process.env.ARP_ISSUER = issuer;
  try {
    assert.equal(resolveIdentity().did, "");
    const token = await mint(issuer, "https://atlas.example");
    const r = await handleConnect({ token, issuer }, "atlas.example");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, did: "did:web:atlas.agent", store: "file" });
    const saved = JSON.parse(readFileSync(identityFilePath(), "utf8"));
    assert.equal(saved.did, "did:web:atlas.agent");
    assert.equal(saved.credential.length, 45);
    const id = resolveIdentity();
    assert.equal(id.source, "file");
    assert.equal(id.challenge, "chal-1");
    assert.equal(id.issuer, issuer);
    // Env still wins over the file.
    process.env.ARP_AGENT_DID = "did:web:override.agent";
    assert.equal(resolveIdentity().did, "did:web:override.agent");
    assert.equal(resolveIdentity().source, "env");
    delete process.env.ARP_AGENT_DID;
    // A token for another host is refused; an unknown issuer is refused.
    const wrong = await handleConnect({ token: await mint(issuer, "https://other.example"), issuer }, "atlas.example");
    assert.equal(wrong.status, 401); assert.equal(wrong.body.error, "audience_mismatch");
    const unknown = await handleConnect({ token, issuer: "https://evil.example" }, "atlas.example");
    assert.equal(unknown.status, 403);
    // Replay: the issuer refuses the second redemption.
    const replay = await handleConnect({ token, issuer }, "atlas.example");
    assert.equal(replay.status, 502); assert.equal(replay.body.error, "token_used");
  } finally { iss.stop(); }
});

test("connect: an identity bound to another issuer is not overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arp-id-"));
  process.env.ARP_IDENTITY_FILE = join(dir, "arp-identity.json");
  saveIdentity({ did: "did:web:atlas.agent", issuer: "https://gateway.other", credential: "c", challenge: "x" });
  const iss = fakeIssuer(); const issuer = await iss.start(); process.env.ARP_ISSUER = issuer;
  try {
    const r = await handleConnect({ token: await mint(issuer, "https://atlas.example"), issuer }, "atlas.example");
    assert.equal(r.status, 409);
  } finally { iss.stop(); }
});

test("store: reports none when the identity file cannot be written", () => {
  process.env.ARP_IDENTITY_FILE = "/dev/null/impossible/arp-identity.json";
  assert.equal(storeKind(), "none");
  assert.throws(() => saveIdentity({ did: "d", issuer: "i", credential: "c", challenge: "x" }));
});
