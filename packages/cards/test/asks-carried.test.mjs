import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answerMessage,
  askFrom,
  askText,
  cardPrompt,
  formPrompt,
  hiddenAsk,
  readHiddenAnswers,
  readHiddenAsks,
  withoutHiddenAsks,
  HIDDEN_CARD_MAX,
  card,
} from "../dist/index.js";

const approval = {
  requestId: "req_1",
  kind: "tool-approval",
  prompt: "Approve tool call: gmail__send_email",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { toolName: "gmail__send_email", input: { to: ["dana@example.com"], subject: "Q3 numbers", body: "Hi Dana -- the numbers are in.\n\nThanks" } },
};

test("an approval carries the email it would send", () => {
  const ask = askFrom(approval);
  assert.equal(ask.kind, "tool-approval");
  assert.equal(ask.card.card, "approval");
  assert.equal(ask.card.data.kind, "email");
  assert.deepEqual(ask.card.data.to, ["dana@example.com"]);
  assert.deepEqual(ask.options.map((o) => o.id), ["approve", "cancel"]);
  const text = askText(ask);
  assert.match(text, /^Send email · Gmail\nTo: dana@example\.com\nSubject: Q3 numbers\n\nHi Dana -- the numbers are in\.\n\nThanks$/);
});

test("a hidden ask reads back as the same ask, double dashes included", () => {
  const ask = askFrom(approval);
  const hidden = hiddenAsk(ask);
  assert.equal(hidden.slice(4, -3).includes("--"), false);
  assert.deepEqual(readHiddenAsks(`words\n\n${hidden}`), [ask]);
  assert.equal(withoutHiddenAsks(`words\n\n${hidden}`), "words");
});

test("questions carry their card, purchase or vault need, without the marker", () => {
  const form = askFrom({ requestId: "q1", kind: "question", prompt: formPrompt([{ id: "name", label: "Name", kind: "text" }], "Who is it for?"), allowFreeform: true });
  assert.equal(form.card.card, "form");
  assert.equal(form.text, "Who is it for?");
  assert.equal(form.allowFreeform, true);

  const spend = askFrom({
    requestId: "q2",
    prompt: `[kyb:spend-request] ${JSON.stringify({ id: "sr_1", amount: 2599, currency: "usd", merchant: "Paper Co", approval_url: "https://link.example/approve/sr_1", status: "pending" })}\nA purchase is waiting.`,
    options: [{ id: "approved", label: "I approved it in Link" }, { id: "cancel", label: "Cancel this purchase" }],
  });
  assert.deepEqual(spend.spend, { id: "sr_1", amount: 2599, currency: "usd", merchant: "Paper Co", approval_url: "https://link.example/approve/sr_1" });
  assert.equal(spend.text, "A purchase is waiting.");

  const vault = askFrom({ requestId: "q3", prompt: `[kyb:vault-item] {"kind":"login","site":"https://shop.example"}\nI need a login.` });
  assert.deepEqual(vault.vault, { kind: "login", site: "https://shop.example" });

  const carded = askFrom({ requestId: "q4", prompt: cardPrompt(card("link", { url: "https://example.com" }), "This one?") });
  assert.equal(carded.card.card, "link");
});

test("a card too large to carry is left out, the question still travels", () => {
  const ask = askFrom(approval);
  const big = { ...ask, card: { ...ask.card, data: { ...ask.card.data, body: "x".repeat(HIDDEN_CARD_MAX + 10) } } };
  const [read] = readHiddenAsks(hiddenAsk(big));
  assert.equal(read.card, undefined);
  assert.equal(read.requestId, "req_1");
  assert.deepEqual(read.options, ask.options);
  assert.ok(askText(big).length < 4_200);
});

test("an answer reads back, and only well-formed answers count", () => {
  const message = answerMessage({ requestId: "req_1", optionId: "cancel", text: "Not as written --> change it" }, "Sent back with changes");
  assert.ok(message.startsWith("Sent back with changes\n\n<!-- kyb:answer v1 "));
  assert.deepEqual(readHiddenAnswers(message), [{ requestId: "req_1", optionId: "cancel", text: "Not as written --> change it" }]);
  assert.deepEqual(readHiddenAnswers('<!-- kyb:answer v1 {"requestId":"r"} -->'), []);
  assert.deepEqual(readHiddenAnswers("<!-- kyb:answer v1 {nope} -->"), []);
  assert.deepEqual(readHiddenAnswers("plain words"), []);
});
