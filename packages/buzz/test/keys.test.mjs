import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asHexPubkey, loadKey, loadOrCreateKey, npubEncode } from "../dist/keys.js";

const HEX = "1327dc9680d0160af5975fabe90ba9d53d6a793f79c0fb24a0b5228a07c093c4";

test("a public key is accepted in either form people have one in", () => {
  assert.equal(asHexPubkey(HEX), HEX);
  assert.equal(asHexPubkey(HEX.toUpperCase()), HEX);
  assert.equal(asHexPubkey(` ${HEX} `), HEX);
  assert.equal(asHexPubkey(npubEncode(HEX)), HEX);
});

test("anything that is not a public key is rejected rather than half-accepted", () => {
  assert.equal(asHexPubkey(""), null);
  assert.equal(asHexPubkey(undefined), null);
  assert.equal(asHexPubkey("nsec1abcdef"), null, "a SECRET key must never pass as a public one");
  assert.equal(asHexPubkey("not-a-key"), null);
  assert.equal(asHexPubkey(HEX.slice(0, 63)), null, "a truncated key is not a key");
});

test("a key is created once and then reused", () => {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-key-")), "agent.json");

  const first = loadOrCreateKey(file);
  assert.equal(first.created, true);
  assert.match(first.key.npub, /^npub1/);

  const second = loadOrCreateKey(file);
  assert.equal(second.created, false, "a second run must not mint a new identity");
  assert.equal(second.key.publicKey, first.key.publicKey);
  assert.equal(loadKey(file).publicKey, first.key.publicKey);
});

test("the key file is not readable by anyone else — it IS the agent", () => {
  const file = join(mkdtempSync(join(tmpdir(), "buzz-key-")), "agent.json");
  loadOrCreateKey(file);
  assert.equal(statSync(file).mode & 0o077, 0, "group and world must have no access");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).secretKey.length === 32);
});
