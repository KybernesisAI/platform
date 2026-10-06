import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVaultItemPrompt, savedAnswer, vaultItemPrompt, vaultItemAsk, interpretVaultAnswer } from "../dist/index.js";

test("the prompt carries a marker a client can parse and a sentence every other surface can read", () => {
  const prompt = vaultItemPrompt({ kind: "login", site: "https://github.com", label: "GitHub", reason: "to open your pull requests", fields: ["username", "password"] });
  const parsed = parseVaultItemPrompt(prompt);
  assert.equal(parsed.ask.kind, "login");
  assert.equal(parsed.ask.site, "https://github.com");
  assert.deepEqual(parsed.ask.fields, ["username", "password"]);
  assert.match(parsed.text, /I need a login for https:\/\/github.com and there is nothing in your vault/);
  assert.match(parsed.text, /to open your pull requests\./);
  assert.equal(parseVaultItemPrompt("Deploy?"), null);
  assert.equal(savedAnswer("abc-123"), "vault:abc-123");
});

test("answers map to outcomes: a saved id, typing it yourself, or a cancel; nothing else counts as consent", () => {
  assert.equal(vaultItemAsk({ kind: "card" }).options.length, 2);
  assert.deepEqual(interpretVaultAnswer({ status: "answered", text: "vault:abc" }).item_id, "abc");
  assert.equal(interpretVaultAnswer({ status: "answered", optionId: "manual" }).status, "manual");
  assert.equal(interpretVaultAnswer({ status: "answered", optionId: "cancel" }).status, "cancelled");
  assert.equal(interpretVaultAnswer({ status: "dismissed" }).status, "cancelled");
  assert.equal(interpretVaultAnswer({ status: "unavailable" }).status, "unavailable");
  assert.equal(interpretVaultAnswer({ status: "answered", text: "here it is: hunter2" }).status, "cancelled");
});
