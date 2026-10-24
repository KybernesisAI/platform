import assert from "node:assert/strict";
import { test } from "node:test";

import { card, cardMessage, hiddenCard, readHiddenCards, withoutHiddenCards, HIDDEN_CARD_MAX } from "../dist/index.js";

const stats = card("stats", { tiles: [{ label: "Visitors", value: "12,480", change: "+8%", tone: "good" }] }, { title: "This week", source: "Analytics" });

test("a hidden card reads back as the same card", () => {
  const message = cardMessage(stats);
  assert.ok(message.startsWith("This week (Analytics)"));
  assert.deepEqual(readHiddenCards(message), [stats]);
});

test("text with a double dash cannot close the comment early", () => {
  const tricky = card("checklist", { items: [{ text: "ship it --> now -- really ---", state: "done" }] });
  const hidden = hiddenCard(tricky);
  assert.equal(hidden.indexOf("-->"), hidden.length - 3);
  assert.equal(hidden.slice(4, -3).includes("--"), false);
  assert.deepEqual(readHiddenCards(`before\n\n${hidden}\n\nafter`), [tricky]);
});

test("several cards, a damaged one and plain comments", () => {
  const link = card("link", { url: "https://example.com/report", title: "Report" });
  const content = [cardMessage(stats), "<!-- kyb:card v1 {not json} -->", "<!-- buzz:wave:v1 -->", hiddenCard(link)].join("\n");
  assert.deepEqual(readHiddenCards(content), [stats, link]);
  assert.deepEqual(readHiddenCards("no cards here"), []);
});

test("a card too large to carry travels as its text", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `row ${i} ${"x".repeat(400)}` }));
  const big = card("table", { columns: [{ key: "name", label: "Name" }], rows }, { text: "A long table." });
  assert.equal(hiddenCard(big), null);
  assert.equal(cardMessage(big), "A long table.");
  assert.ok(HIDDEN_CARD_MAX > 1000);
});

test("withoutHiddenCards leaves only the words", () => {
  const words = cardMessage(stats).split("\n\n<!--")[0];
  assert.equal(withoutHiddenCards(`${cardMessage(stats)}\n\n\nMore.`), `${words}\n\nMore.`);
});
