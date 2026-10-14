import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { controlPlaneSlackCredentials, verifySlackSignature } from "../dist/control-plane.js";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
function signed(body, ts, secret = SECRET) {
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return new Headers({ "x-slack-request-timestamp": String(ts), "x-slack-signature": sig });
}

test("verifies a real Slack signature and refuses a wrong or stale one", async () => {
  const now = 1_800_000_000_000;
  const ts = now / 1000;
  const body = '{"type":"url_verification","challenge":"x"}';
  assert.equal(await verifySlackSignature(signed(body, ts), body, SECRET, now), true);
  assert.equal(await verifySlackSignature(signed(body, ts, "other"), body, SECRET, now), false);
  assert.equal(await verifySlackSignature(signed(body, ts - 600), body, SECRET, now), false);
  assert.equal(await verifySlackSignature(new Headers(), body, SECRET, now), false);
});

test("reads the app from the control plane with the agent credential and caches it", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.authorization]);
    return new Response(JSON.stringify({ signingSecret: SECRET, botToken: "xoxb-1", teamId: "T1", botUserId: "U1" }), { status: 200 });
  };
  const creds = controlPlaneSlackCredentials({ issuer: "https://cp.example/", credential: "cred", fetchImpl });
  assert.equal(await creds.botToken(), "xoxb-1");
  assert.equal(await creds.botToken(), "xoxb-1");
  assert.deepEqual(calls, [["https://cp.example/api/agent/slack", "Bearer cred"]]);
  const body = "{}";
  const req = new Request("https://agent/eve/v1/slack", { method: "POST", headers: signed(body, Math.floor(Date.now() / 1000)) });
  assert.equal(await creds.webhookVerifier(req, body), true);
});

test("before install: the verifier works, the token says what to do", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ signingSecret: SECRET, botToken: null }), { status: 200 });
  const creds = controlPlaneSlackCredentials({ credential: "cred", fetchImpl });
  await assert.rejects(creds.botToken(), /not installed/);
  const body = "{}";
  const req = new Request("https://agent/eve/v1/slack", { method: "POST", headers: signed(body, Math.floor(Date.now() / 1000)) });
  assert.equal(await creds.webhookVerifier(req, body), true);
});

test("no app at all refuses every request", async () => {
  const fetchImpl = async () => new Response("{}", { status: 404 });
  const creds = controlPlaneSlackCredentials({ credential: "cred", fetchImpl });
  const req = new Request("https://agent/eve/v1/slack", { method: "POST", headers: signed("{}", Math.floor(Date.now() / 1000)) });
  assert.equal(await creds.webhookVerifier(req, "{}"), false);
});
