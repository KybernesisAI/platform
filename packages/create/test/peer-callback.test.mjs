import assert from "node:assert/strict";
import { test } from "node:test";

import { peerCallbackChecks } from "../dist/peer-callback.js";

/**
 * The live defect: a caller on an exe host asked a peer, the peer answered in
 * seconds, and the answer went to the peer's own localhost:3000. The asking
 * turn waited forever with nothing logged on its side.
 */
test("an old dispatch on an agent with peers fails", () => {
  const checks = peerCallbackChecks({
    dispatchVersion: "0.8.0",
    callsPeers: true,
    answersPeers: true,
    env: { EXE_VM_NAME: "planner" },
  });
  assert.equal(checks[0]?.verdict, "fail");
  assert.match(checks[0].fix ?? "", /0\.8\.1/);
  assert.equal(checks[1]?.verdict, "pass");
});

test("a caller with no public address fails, even on a current dispatch", () => {
  const checks = peerCallbackChecks({ dispatchVersion: "0.8.1", callsPeers: true, answersPeers: false, env: {} });
  assert.deepEqual(checks.map((c) => c.verdict), ["fail"]);
  assert.match(checks[0].fix ?? "", /EXE_VM_NAME/);
});

test("a receiver needs a current dispatch but no address of its own", () => {
  assert.deepEqual(peerCallbackChecks({ dispatchVersion: "0.9.0", callsPeers: false, answersPeers: true, env: {} }), []);
  assert.equal(
    peerCallbackChecks({ dispatchVersion: "0.7.0", callsPeers: false, answersPeers: true, env: {} })[0]?.verdict,
    "fail",
  );
});

test("nothing to say for agents without peers, or on Vercel", () => {
  assert.deepEqual(peerCallbackChecks({ dispatchVersion: "0.8.0", callsPeers: false, answersPeers: false, env: {} }), []);
  assert.deepEqual(peerCallbackChecks({ dispatchVersion: "0.8.0", callsPeers: true, answersPeers: true, env: { VERCEL: "1" } }), []);
});
