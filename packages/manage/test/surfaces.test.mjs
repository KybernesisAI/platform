import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSurfaces } from "../dist/index.js";

test("surfaces read back with relay hosts, and a heartbeat older than three minutes is not live", () => {
  const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
  const now = Date.now();
  writeFileSync(join(dir, "buzz-a.json"), JSON.stringify({ kind: "buzz", name: "Buzz", relays: ["wss://kybernesis.communities.buzz.xyz"], heartbeatAt: new Date(now - 30_000).toISOString(), conversations: 4 }));
  writeFileSync(join(dir, "buzz-b.json"), JSON.stringify({ kind: "buzz", name: "Buzz", relays: ["wss://old.example"], heartbeatAt: new Date(now - 10 * 60_000).toISOString() }));
  writeFileSync(join(dir, "junk.json"), "{}");
  const s = readSurfaces(dir, now).sort((a, b) => a.detail.localeCompare(b.detail));
  assert.deepEqual(s.map((x) => [x.name, x.detail, x.live, x.conversations]), [["Buzz", "kybernesis.communities.buzz.xyz", true, 4], ["Buzz", "old.example", false, undefined]]);
  assert.deepEqual(readSurfaces(join(dir, "missing")), [], "a host with no surfaces has none, not an error");
});
