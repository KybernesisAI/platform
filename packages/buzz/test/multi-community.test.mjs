import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buzzBridge } from "../dist/bridge.js";
import { loadOrCreateKey } from "../dist/keys.js";

const keyFile = join(mkdtempSync(join(tmpdir(), "buzz-multi-")), "agent.json");
loadOrCreateKey(keyFile);

const OPTIONS = {
  agentUrl: "http://127.0.0.1:8000",
  keyFile,
  issuer: "https://control.example.com",
  credential: "agent-cred",
};

test("one community is the ordinary case", () => {
  const bridge = buzzBridge({ ...OPTIONS, relay: "wss://one.example.com" });
  assert.deepEqual(bridge.relays, ["wss://one.example.com"]);
});

test("an agent can belong to several communities on one identity", () => {
  const bridge = buzzBridge({
    ...OPTIONS,
    relay: ["wss://one.example.com", "wss://two.example.com"],
  });
  // The same key in both: membership is the relay's to grant, so being in two
  // communities is two connections rather than two agents.
  assert.deepEqual(bridge.relays, ["wss://one.example.com", "wss://two.example.com"]);
  assert.match(bridge.npub, /^npub1/);
});

test("blank entries in a list are ignored rather than opened", () => {
  const bridge = buzzBridge({
    ...OPTIONS,
    relay: [" wss://one.example.com ", "", "   "],
  });
  assert.deepEqual(bridge.relays, ["wss://one.example.com"]);
});

test("no relay at all is refused, rather than starting a bridge to nowhere", () => {
  assert.throws(() => buzzBridge({ ...OPTIONS, relay: [] }), /relay is required/);
});

test("agent silence timeout must be finite and positive", () => {
  assert.throws(
    () => buzzBridge({ ...OPTIONS, relay: "wss://one.example.com", agentSilenceTimeoutMs: 0 }),
    /finite positive/,
  );
  const bridge = buzzBridge({
    ...OPTIONS,
    relay: "wss://one.example.com",
    agentSilenceTimeoutMs: 45_000,
  });
  assert.equal(bridge.relays.length, 1);
});
