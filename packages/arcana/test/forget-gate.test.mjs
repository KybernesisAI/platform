import assert from "node:assert/strict";
import { test } from "node:test";

import { forgetApproval, removes } from "../dist/extension/lib/forget-gate.mjs";

const session = (principalType) => ({ auth: { current: principalType ? { principalType, principalId: "p-1" } : null } });
const ask = (toolName, principalType) => forgetApproval({ toolName, session: session(principalType) });

test("removals park for a person's approval, matched by remote-name suffix", () => {
  for (const name of ["arcana__memory__arcana_forget", "brain__memory__arcana_brain_delete", "arcana_forget"]) {
    assert.equal(ask(name, "user"), "user-approval");
  }
});

test("removals are denied on any turn that is not a person's", () => {
  for (const type of [undefined, "agent", "service", "local-dev", "anonymous", "schedule"]) {
    const result = ask("arcana__memory__arcana_forget", type);
    assert.equal(result.type, "denied", `principalType ${type}`);
  }
});

test("everything else on the connection runs without a prompt", () => {
  for (const name of ["arcana__memory__arcana_find_memories", "arcana__memory__arcana_remember", "arcana__memory__arcana_brain_write", "arcana__memory__arcana_search"]) {
    assert.equal(ask(name, undefined), "not-applicable");
    assert.equal(removes(name), false);
  }
});
