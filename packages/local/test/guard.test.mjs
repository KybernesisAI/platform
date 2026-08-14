import { test } from "node:test";
import assert from "node:assert/strict";
import { localReadTool, localShellTool } from "../dist/index.js";

/**
 * The guard has one job: refuse BEFORE the relay is contacted. A check that
 * runs after the request has already gone out is a log line pretending to be a
 * permission.
 */

const channel = { session: { auth: { current: { principalId: "u_1" } } } };

test("a throwing guard stops the call before any network attempt", async () => {
  // No credential is set, so if the guard did not fire first, the tool would
  // fail with the credential error instead — which is how we know the order.
  const previous = process.env.KYBERNESIS_AGENT_CREDENTIAL;
  delete process.env.KYBERNESIS_AGENT_CREDENTIAL;

  const originalFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = async () => {
    reached = true;
    throw new Error("the relay should never have been called");
  };

  try {
    const tool = localReadTool({
      guard: () => {
        throw new Error("This capability is private: ask in a direct message.");
      },
    });

    await assert.rejects(
      () => tool.execute({ path: "/etc/hosts" }, channel),
      /private: ask in a direct message/,
      "the guard's own message must reach the model, not a credential error",
    );
    assert.equal(reached, false, "nothing may leave the process when the guard refuses");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous !== undefined) process.env.KYBERNESIS_AGENT_CREDENTIAL = previous;
  }
});

test("no guard is the default, and the tools still work as before", async () => {
  const previous = process.env.KYBERNESIS_AGENT_CREDENTIAL;
  delete process.env.KYBERNESIS_AGENT_CREDENTIAL;
  try {
    const tool = localShellTool();
    // Reaches the credential check, which is the first thing past the guard.
    await assert.rejects(
      () => tool.execute({ command: "ls" }, channel),
      /KYBERNESIS_AGENT_CREDENTIAL is unset/,
    );
  } finally {
    if (previous !== undefined) process.env.KYBERNESIS_AGENT_CREDENTIAL = previous;
  }
});

test("the guard receives the context the tool was called with", async () => {
  let seen = null;
  const tool = localShellTool({ guard: (ctx) => { seen = ctx; throw new Error("stop"); } });
  await assert.rejects(() => tool.execute({ command: "ls" }, channel), /stop/);
  assert.equal(seen?.session?.auth?.current?.principalId, "u_1");
});
