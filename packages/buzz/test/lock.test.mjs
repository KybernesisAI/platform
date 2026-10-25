import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireBridgeLock, lockPathFor } from "../dist/lock.js";

const keyFile = () => join(mkdtempSync(join(tmpdir(), "buzz-lock-")), "agent-key.json");

test("one bridge per key: a second waits while the first answers, and takes over when it stops", () => {
  const key = keyFile();
  const alive = new Set([101]);
  const first = acquireBridgeLock(key, 101, (pid) => alive.has(pid));
  assert.ok("release" in first);
  const second = acquireBridgeLock(key, 202, (pid) => alive.has(pid));
  assert.deepEqual(second, { heldBy: { pid: 101 } });

  first.release();
  assert.equal(existsSync(lockPathFor(key)), false);
  assert.ok("release" in acquireBridgeLock(key, 202, (pid) => alive.has(pid)));
});

test("a lock left by a bridge that is gone (a crash, a reboot) is taken over", () => {
  const key = keyFile();
  writeFileSync(lockPathFor(key), "4242");
  const lock = acquireBridgeLock(key, 303, () => false);
  assert.ok("release" in lock);
  // Releasing only removes our own lock.
  writeFileSync(lockPathFor(key), "999");
  lock.release();
  assert.equal(existsSync(lockPathFor(key)), true);
});
