import assert from "node:assert/strict";
import { test } from "node:test";

import { applySettlements, formatInputRequests, isAsker, notTheAskerReply, settlementsFor, settleRemaining } from "../dist/hitl.js";
import { readHiddenAsks, readSettledAsks } from "@kybernesis/cards";

/**
 * In a shared channel, an approval is for the person who asked, and once it
 * ends everyone sees how. Found live: a teammate with the plugin still saw
 * Send it on an email that had already gone, and could have pressed it first.
 */

const PLANNER = { key: "a".repeat(64), userId: "user-planner", name: "Planner" };
const OTHER = "b".repeat(64);

const approval = {
  action: { callId: "call-2", input: { to: ["dana@example.com"], subject: "Q3 numbers", body: "The numbers are in." }, kind: "tool-call", toolName: "gmail__send_email" },
  kind: "tool-approval",
  options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
  prompt: "Approve tool call: gmail__send_email",
  requestId: "request-2",
};
const question = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
  kind: "question",
  options: [{ id: "eu", label: "Europe" }, { id: "us", label: "United States" }],
  prompt: "Which region?",
  requestId: "request-1",
};

test("a question carries who it is for, and says so to people reading the words", () => {
  const rendered = formatInputRequests([approval], { carry: true, asker: PLANNER, askerOnly: true });
  assert.match(rendered, /Planner, reply to this message/);
  const [ask] = readHiddenAsks(rendered);
  assert.deepEqual(ask.asker, { key: PLANNER.key, name: "Planner" });
  assert.equal(ask.askerOnly, true);
  // The account id stays with the bridge.
  assert.ok(!rendered.includes("user-planner"));
});

test("with anyone allowed to answer, the question names who asked but nobody is shut out", () => {
  const rendered = formatInputRequests([approval], { carry: true, asker: PLANNER, askerOnly: false });
  assert.match(rendered, /\nReply to this message/);
  assert.equal(readHiddenAsks(rendered)[0].askerOnly, undefined);
});

test("the asker is known by key, or by account on another device", () => {
  assert.equal(isAsker(PLANNER, PLANNER.key), true);
  assert.equal(isAsker(PLANNER, OTHER, "user-planner"), true);
  assert.equal(isAsker(PLANNER, OTHER, "user-other"), false);
  assert.equal(isAsker({ key: PLANNER.key }, OTHER, undefined), false);
  assert.equal(notTheAskerReply(PLANNER), "Only Planner can answer this one. I can take something new once it's answered.");
  assert.match(notTheAskerReply({ key: PLANNER.key }), /^Only the person who asked can answer/);
});

test("answers settle their requests: approvals by outcome, questions by what was said", () => {
  const settled = settlementsFor(
    [{ requestId: "request-2", optionId: "approve" }, { requestId: "request-1", optionId: "eu" }, { requestId: "gone", optionId: "x" }],
    [approval, question],
    "Planner",
    7,
  );
  assert.deepEqual(Object.fromEntries(settled), {
    "request-2": { outcome: "approved", by: "Planner", at: 7 },
    "request-1": { outcome: "answered", by: "Planner", answer: "Europe", at: 7 },
  });
  assert.equal(settlementsFor([{ requestId: "request-2", optionId: "cancel", text: "Shorter, please" }], [approval]).get("request-2").outcome, "changes");
});

test("a settled prompt is edited to how it ended, with nothing left to press", () => {
  const prompt = { eventId: "e1", requests: [approval], asker: PLANNER };
  const { edits, open } = applySettlements([prompt], new Map([["request-2", { outcome: "declined", by: "Planner" }]]), { carry: true, askerOnly: true });
  assert.equal(open.length, 0);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].eventId, "e1");
  const content = edits[0].content;
  assert.match(content, /^Not sent: declined by Planner\.\n\nSend email · Gmail\nTo: dana@example\.com/);
  assert.ok(!content.includes("Reply to this message"));
  assert.deepEqual(readHiddenAsks(content), []);
  const [ask] = readSettledAsks(content);
  assert.deepEqual(ask.settled, { outcome: "declined", by: "Planner" });
  assert.equal(ask.card.data.subject, "Q3 numbers");
});

test("a prompt with two questions keeps the open one answerable until it too ends", () => {
  const prompt = { eventId: "e1", requests: [question, approval], asker: PLANNER };
  const first = applySettlements([prompt], new Map([["request-1", { outcome: "answered", by: "Planner", answer: "Europe" }]]), { carry: true, askerOnly: true });
  assert.equal(first.open.length, 1);
  assert.match(first.edits[0].content, /^Question 1: Answered by Planner: Europe/);
  assert.match(first.edits[0].content, /Question 2: Send email/);
  assert.equal(readHiddenAsks(first.edits[0].content).length, 1);
  assert.equal(readSettledAsks(first.edits[0].content).length, 1);

  // Settling the same request again changes nothing.
  assert.equal(applySettlements(first.open, new Map([["request-1", { outcome: "withdrawn" }]]), { carry: true }).edits.length, 0);

  const rest = settleRemaining(first.open, { outcome: "withdrawn" });
  assert.deepEqual([...rest.keys()], ["request-2"]);
  const second = applySettlements(first.open, rest, { carry: true, askerOnly: true });
  assert.equal(second.open.length, 0);
  assert.match(second.edits[0].content, /Question 2: No longer waiting on this\./);
  assert.equal(readHiddenAsks(second.edits[0].content).length, 0);
});

test("without the plugin's comments, the edit is the words alone", () => {
  const { edits } = applySettlements([{ eventId: "e1", requests: [approval] }], new Map([["request-2", { outcome: "approved" }]]), { carry: false });
  assert.match(edits[0].content, /^Approved\.\n\nSend email/);
  assert.ok(!edits[0].content.includes("<!--"));
});
