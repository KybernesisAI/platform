import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalSandboxCleanupHook } from "../dist/sandbox-cleanup.js";

function context({ deleteError, getError } = {}) {
  let deletes = 0;
  return {
    ctx: {
      agent: { name: "root" },
      channel: {},
      getSandbox: async () => {
        if (getError) throw getError;
        return {
          delete: async () => {
            deletes += 1;
            if (deleteError) throw deleteError;
          },
        };
      },
      session: { id: "session-123" },
    },
    deletes: () => deletes,
  };
}

for (const event of ["session.completed", "session.failed"]) {
  test(`${event} deletes the terminal sandbox exactly once`, async () => {
    const mock = context();
    await terminalSandboxCleanupHook.events[event]({ type: event }, mock.ctx);
    assert.equal(mock.deletes(), 1);
  });
}

test("resumable and non-terminal events have no cleanup handler", () => {
  for (const event of ["session.waiting", "turn.completed", "turn.cancelled", "session.started"]) {
    assert.equal(terminalSandboxCleanupHook.events[event], undefined);
  }
});

for (const failure of ["getSandbox", "delete"]) {
  test(`${failure} failure is warned and swallowed`, async () => {
    const error = new Error(`${failure} failed`);
    const mock = context(failure === "getSandbox" ? { getError: error } : { deleteError: error });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await terminalSandboxCleanupHook.events["session.failed"]({ type: "session.failed" }, mock.ctx);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /leaving it protected/);
    assert.equal(warnings[0][1].sessionId, "session-123");
    assert.equal(warnings[0][1].agent, "root");
  });
}
