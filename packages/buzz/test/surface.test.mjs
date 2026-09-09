import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSurfaceManifest, surfaceWriter } from "../dist/surface.js";

test("a bridge declares itself in a manifest with a heartbeat, and removes it when it stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
  let conversations = 2;
  const w = surfaceWriter({ relays: ["wss://one.example", "wss://two.example"], npub: "npub1abcdefgh12345678", conversations: () => conversations, dir });
  w.start();
  const m = readSurfaceManifest(w.file);
  assert.equal(m?.kind, "buzz");
  assert.deepEqual(m?.relays, ["wss://one.example", "wss://two.example"]);
  assert.equal(m?.conversations, 2, "counts the live conversations");
  assert.ok(Date.now() - Date.parse(m.heartbeatAt) < 5_000, "the heartbeat is now");
  conversations = 3;
  w.update({});
  assert.equal(readSurfaceManifest(w.file)?.conversations, 3, "an update rewrites the count");
  w.stop();
  assert.equal(existsSync(w.file), false, "a stopped bridge leaves no manifest to mistake for a stale one");
});

test("a file that is not a manifest reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
  const file = join(dir, "x.json");
  writeFileSync(file, "{}");
  assert.equal(readSurfaceManifest(file), null);
  assert.equal(readSurfaceManifest(join(dir, "missing.json")), null);
});
