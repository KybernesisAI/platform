import assert from "node:assert/strict";
import { test } from "node:test";
import { listItems, personFromContext, sameSite, valuesOf } from "../dist/index.js";

test("only a control-plane-authenticated person owns a vault; eve's defaults and services do not", () => {
  assert.equal(personFromContext({ session: { auth: { current: { principalId: "u_1", authenticator: "kybernesis", principalType: "user" } } } }), "u_1");
  assert.equal(personFromContext({ session: { auth: { current: { principalId: "linq:+1555", authenticator: "linq-message", principalType: "user" } } } }), null);
  assert.equal(personFromContext({ session: { auth: { current: { principalId: "local", authenticator: "local-dev" } } } }), null);
  assert.equal(personFromContext({ session: { auth: { current: { principalId: "svc", authenticator: "kybernesis", principalType: "service" } } } }), null);
  assert.equal(personFromContext({}), null);
});

test("a login belongs to its site, including subdomains, and never to a look-alike", () => {
  assert.equal(sameSite("https://example.com", "https://accounts.example.com/login"), true);
  assert.equal(sameSite("https://accounts.example.com", "https://example.com/"), true);
  assert.equal(sameSite("https://example.com", "https://www.example.com/"), true);
  assert.equal(sameSite("https://example.com", "https://example.com.evil.net/"), false);
  assert.equal(sameSite("https://example.com", "https://examp1e.com/"), false);
  assert.equal(sameSite(null, "https://example.com/"), false);
});

test("a card's values include every expiry spelling a checkout might want", () => {
  const values = valuesOf({
    id: "i", kind: "card", label: "Visa", origin: null, updatedAt: "",
    summary: { brand: "visa", last4: "4242", cardholder: "Ian B", expMonth: 7, expYear: 2029 },
    secret: { number: "4242424242424242", cvc: "123" },
  });
  assert.equal(values.number, "4242424242424242");
  assert.equal(values.exp_month, "07");
  assert.equal(values.exp_year, "2029");
  assert.equal(values.expiration, "07/29");
  assert.equal(values.expiration_long, "07/2029");
  assert.equal(values.name, "Ian B");
});

test("the agent presents its own credential and names the person in the body", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ items: [{ id: "a", kind: "login", label: "Example", origin: "https://example.com", summary: { username: "ian" }, updatedAt: "" }] }), { status: 200 });
  };
  const items = await listItems({ issuer: "https://cp.test", credential: "cred_x", fetchImpl }, "u_1", "https://example.com/x");
  assert.equal(items.length, 1);
  assert.equal(seen.url, "https://cp.test/api/vault/items");
  assert.equal(seen.init.headers.authorization, "Bearer cred_x");
  assert.deepEqual(JSON.parse(seen.init.body), { user: "u_1", origin: "https://example.com/x" });
});
