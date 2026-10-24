import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askFrom,
  hiddenAsk,
  hiddenSettled,
  readHiddenAsks,
  readSettledAsks,
  settleWith,
  settledLabel,
  settledLine,
  withoutHiddenAsks,
} from "../dist/index.js";

const KEY = "a".repeat(64);

const approval = askFrom({
  requestId: "req_1",
  kind: "tool-approval",
  prompt: "Approve tool call: gmail__send_email",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { toolName: "gmail__send_email", input: { to: ["dana@example.com"], subject: "Q3 numbers", body: "Hi Dana" } },
});

test("an open question carries who asked and whether only they may answer", () => {
  const ask = { ...approval, asker: { key: KEY, name: "Planner" }, askerOnly: true };
  const [back] = readHiddenAsks(hiddenAsk(ask));
  assert.deepEqual(back.asker, { key: KEY, name: "Planner" });
  assert.equal(back.askerOnly, true);
});

test("an asker that is not a key is dropped, and askerOnly with it", () => {
  const [back] = readHiddenAsks(hiddenAsk({ ...approval, asker: { key: "not-a-key" }, askerOnly: true }));
  assert.equal(back.asker, undefined);
  assert.equal(back.askerOnly, undefined);
});

test("a settled question travels under its own marker, which open-question readers skip", () => {
  const settled = { ...approval, asker: { key: KEY, name: "Planner" }, askerOnly: true, settled: { outcome: "approved", by: "Planner", at: 1 } };
  const comment = hiddenSettled(settled);
  assert.match(comment, /^<!-- kyb:settled v1 /);
  assert.deepEqual(readHiddenAsks(comment), []);
  const [back] = readSettledAsks(comment);
  assert.deepEqual(back.settled, { outcome: "approved", by: "Planner", at: 1 });
  assert.equal(back.askerOnly, undefined);
  assert.equal(back.card.card, "approval");
  assert.equal(withoutHiddenAsks(`Approved by Planner.\n\n${comment}`), "Approved by Planner.");
});

test("an open question's comment never reads as settled", () => {
  const smuggled = hiddenAsk({ ...approval, settled: { outcome: "approved" } });
  assert.deepEqual(readSettledAsks(smuggled), []);
  assert.equal(readHiddenAsks(smuggled)[0].settled, undefined);
});

test("an approval settles as approved, declined, or sent back with changes", () => {
  assert.equal(settleWith(approval, { optionId: "approve" }, "Planner", 5).outcome, "approved");
  assert.equal(settleWith(approval, { optionId: "cancel" }).outcome, "declined");
  assert.equal(settleWith(approval, { optionId: "cancel", text: "Make it shorter" }).outcome, "changes");
  assert.deepEqual(settleWith(approval, { optionId: "approve" }, "Planner", 5), { outcome: "approved", by: "Planner", at: 5 });
});

test("any other question settles as answered, with what was said", () => {
  const question = askFrom({ requestId: "q", kind: "question", prompt: "Which region?", options: [{ id: "eu", label: "Europe" }] });
  assert.deepEqual(settleWith(question, { optionId: "eu" }, "Planner", 1), { outcome: "answered", by: "Planner", answer: "Europe", at: 1 });
  assert.equal(settleWith(question, { text: "Both" }).answer, "Both");
});

test("a settled question says how it ended in words", () => {
  const as = (outcome, extra = {}) => ({ ...approval, settled: { outcome, by: "Planner", ...extra } });
  assert.equal(settledLine(as("approved")), "Approved by Planner.");
  assert.equal(settledLabel(as("declined")), "Not sent");
  assert.equal(settledLine(as("declined")), "Not sent: declined by Planner.");
  assert.equal(settledLine(as("changes")), "Sent back with changes by Planner.");
  assert.equal(settledLine(as("withdrawn")), "No longer waiting on this.");
  assert.equal(settledLine({ settled: { outcome: "answered", by: "Planner", answer: "Europe" } }), "Answered by Planner: Europe");
});
