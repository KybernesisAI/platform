import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptCard } from "../dist/link-tools.js";

test("a receipt reads the merchant and the total from the spend request", () => {
  const made = receiptCard({ id: "lsrq_1", merchant_name: "Example Store", amount: 4299, currency: "usd", activity_url: "https://link.com/activity/1" });
  assert.equal(made.card, "receipt");
  assert.equal(made.id, "receipt-lsrq_1");
  assert.deepEqual(made.data, { merchant: "Example Store", amount: 4299, currency: "USD" });
  assert.deepEqual(made.actions, [{ label: "View in Link", url: "https://link.com/activity/1" }]);
  assert.match(made.text, /Example Store/);
});

test("the merchant falls back to the site, and a request without a total makes no receipt", () => {
  assert.equal(receiptCard({ id: "x", merchant_url: "https://shop.example/cart", amount: 100, currency: "eur" }).data.merchant, "shop.example");
  assert.equal(receiptCard({ id: "x", merchant_name: "Shop", currency: "usd" }), null);
  assert.equal(receiptCard({ id: "x", amount: 100, currency: "usd" }), null);
});
