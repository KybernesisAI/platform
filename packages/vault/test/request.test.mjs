import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVaultItemPrompt, savedAnswer, vaultItemPrompt, requestVaultItemTool } from "../dist/index.js";

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

test("the tool is a workflow tool (it must park durably while the person answers)", () => {
  const tool = requestVaultItemTool();
  assert.ok(tool);
  assert.match(tool.description, /vault/i);
});
