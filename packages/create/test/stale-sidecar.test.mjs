import assert from "node:assert/strict";
import { test } from "node:test";

import { staleSidecars, describeStaleSidecar } from "../dist/stale-sidecar.js";

/**
 * Node loads a module once, at process start. Upgrading a package changes
 * nothing in a service already running — it keeps executing the old code from
 * memory while the new version sits on disk.
 *
 * On the reference fleet both Buzz bridges ran four days on buzz 0.9.2 while
 * 0.9.9 was installed, because deploy.sh restarts the agent and not the bridge.
 * Two fixes signed off as "deployed and verified" were live nowhere. Checking
 * the files is what hid it.
 */
const change = { at: new Date("2026-09-15T10:00:00Z"), name: "@kybernesis/buzz" };

test("a service started before the package changed is stale", () => {
  const stale = staleSidecars({
    started: new Map([["kyber-buzz-bridge", new Date("2026-09-11T08:20:00Z")]]),
    packageChange: change,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].service, "kyber-buzz-bridge");
});

test("a service started after the package changed is current", () => {
  const stale = staleSidecars({
    started: new Map([["kyber-agent", new Date("2026-09-15T10:05:00Z")]]),
    packageChange: change,
  });
  assert.deepEqual(stale, []);
});

/** An install restarts the agent itself; that restart must not look stale. */
test("a restart within the grace margin of the install is not stale", () => {
  const stale = staleSidecars({
    started: new Map([["kyber-agent", new Date("2026-09-15T09:59:30Z")]]),
    packageChange: change,
  });
  assert.deepEqual(stale, [], "30s before the package landed is the install's own restart");
});

test("the agent can be current while its sidecar is not — the case that bit us", () => {
  const stale = staleSidecars({
    started: new Map([
      ["kyber-agent", new Date("2026-09-15T10:30:00Z")],
      ["kyber-buzz-bridge", new Date("2026-09-11T08:20:00Z")],
    ]),
    packageChange: change,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].service, "kyber-buzz-bridge", "only the un-restarted sidecar is flagged");
});

test("with no packages installed nothing is claimed", () => {
  assert.deepEqual(
    staleSidecars({ started: new Map([["x", new Date(0)]]), packageChange: null }),
    [],
    "absence of evidence is not staleness",
  );
});

test("the message names the service, both times, and the fix", () => {
  const [stale] = staleSidecars({
    started: new Map([["ava-buzz-bridge", new Date("2026-09-11T08:26:00Z")]]),
    packageChange: change,
  });
  const line = describeStaleSidecar(stale);
  assert.match(line, /ava-buzz-bridge started 2026-09-11 08:26/);
  assert.match(line, /@kybernesis\/buzz changed 2026-09-15 10:00/);
  assert.match(line, /sudo systemctl restart ava-buzz-bridge/);
});
