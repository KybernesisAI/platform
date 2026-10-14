import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretSpendRequestAnswer, spendRequestAsk } from "../dist/approve-ask.js";

const snapshot = { id: "lsrq_1", status: "pending_approval", amount: 100, currency: "usd", merchant: "A Store" };

test("the question takes a typed reply, so text-only channels can answer it", () => {
  const ask = spendRequestAsk(snapshot);
  assert.equal(ask.allowFreeform, true);
  assert.deepEqual(ask.options.map((o) => o.id), ["approved", "cancel"]);
  assert.match(ask.prompt, /Reply once you have approved it, or say cancel\.$/);
});

test("buttons and typed replies: only a no cancels, everything else checks Link", () => {
  assert.equal(interpretSpendRequestAnswer({ status: "answered", optionId: "approved" }), "check");
  assert.equal(interpretSpendRequestAnswer({ status: "answered", optionId: "cancel" }), "cancel");
  assert.equal(interpretSpendRequestAnswer({ status: "dismissed" }), "cancel");
  assert.equal(interpretSpendRequestAnswer({ status: "unavailable" }), "cancel");
  for (const text of ["Approve", "I approved it", "done", "yes go ahead", "ok", ""]) {
    assert.equal(interpretSpendRequestAnswer({ status: "answered", text }), "check", text);
  }
  for (const text of ["cancel", "No thanks", "don't buy it", "Stop", "never mind", "do not"]) {
    assert.equal(interpretSpendRequestAnswer({ status: "answered", text }), "cancel", text);
  }
});
