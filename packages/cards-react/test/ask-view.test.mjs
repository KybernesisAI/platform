import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { askFrom, formPrompt } from "@kybernesis/cards";
import { AskView } from "../dist/index.js";

const ctx = { openUrl() {} };
const draw = (ask, extra = {}) => renderToStaticMarkup(createElement(AskView, { ask, ctx, onAnswer() {}, ...extra }));

const email = askFrom({
  requestId: "r1",
  kind: "tool-approval",
  prompt: "Approve tool call: gmail__send_email",
  options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
  action: { toolName: "gmail__send_email", input: { to: "dana@example.com", subject: "Q3 numbers", body: "The numbers are in." } },
});

test("an approval draws the email and its three answers", () => {
  const html = draw(email);
  for (const words of ["Send email · Gmail", "dana@example.com", "Q3 numbers", "The numbers are in.", "Send it", "Edit", "Don&#x27;t send"]) {
    assert.ok(html.includes(words), words);
  }
});

test("answered, it keeps the outcome instead of the buttons", () => {
  const html = draw(email, { answered: { optionId: "approve", label: "Approved" } });
  assert.ok(html.includes("Approved"));
  assert.ok(!html.includes("Send it"));
  assert.ok(draw(email, { answered: { optionId: "cancel", label: "Declined" } }).includes("Declined"));
});

test("a purchase shows the amount, Link, and the request's own options", () => {
  const html = draw(
    askFrom({
      requestId: "r2",
      prompt: `[kyb:spend-request] ${JSON.stringify({ id: "sr_1", amount: 2599, currency: "usd", merchant: "Paper Co", approval_url: "https://link.example/a", status: "pending" })}\nA purchase is waiting.`,
      options: [{ id: "approved", label: "I approved it in Link" }, { id: "cancel", label: "Cancel this purchase" }],
    }),
  );
  for (const words of ["$25.99", "Paper Co", "Approve in Link", "I approved it in Link", "Cancel this purchase"]) assert.ok(html.includes(words), words);
});

test("a vault request never offers a box to type the secret into", () => {
  const html = draw(
    askFrom({
      requestId: "r3",
      prompt: `[kyb:vault-item] {"kind":"login","site":"https://shop.example"}\nI need a login.`,
      allowFreeform: true,
      options: [{ id: "manual", label: "I'll type it myself on your screen" }, { id: "cancel", label: "Cancel" }],
    }),
  );
  assert.ok(html.includes("Needs a login"));
  assert.ok(html.includes("shop.example"));
  assert.ok(!html.includes("<input"));
});

test("a form draws its fields; a plain question its options and a box for words", () => {
  const form = draw(askFrom({ requestId: "r4", prompt: formPrompt([{ id: "name", label: "Name", kind: "text", required: true }], "Who is it for?") }));
  assert.ok(form.includes("Who is it for?"));
  assert.ok(form.includes("Name *"));
  const plain = draw(askFrom({ requestId: "r5", prompt: "Which one?", options: [{ id: "a", label: "First" }], allowFreeform: true }));
  assert.ok(plain.includes("First"));
  assert.ok(plain.includes("Your answer"));
});
