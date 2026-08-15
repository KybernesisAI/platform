import { test } from "node:test";
import assert from "node:assert/strict";
import { toolNamesFor } from "../dist/index.js";

/**
 * Two accounts of one service produce two identical tool sets. If the agent is
 * handed one name for both, it acts as whichever the broker defaults to — and
 * mail sent from the wrong account is not a retryable error.
 */
test("a single account keeps the bare tool name", () => {
  assert.deepEqual(toolNamesFor("GMAIL_SEND_EMAIL", [{ id: "ca_1", label: null }]), [
    { name: "gmail_send_email", account: "ca_1" },
  ]);
});

test("no account at all is still the bare name", () => {
  assert.deepEqual(toolNamesFor("GMAIL_SEND_EMAIL", []), [
    { name: "gmail_send_email", account: undefined },
  ]);
});

test("two accounts become two addressable tools", () => {
  const names = toolNamesFor("GMAIL_SEND_EMAIL", [
    { id: "ca_1", label: "work" },
    { id: "ca_2", label: "personal" },
  ]);
  assert.deepEqual(names, [
    { name: "gmail_send_email_work", account: "ca_1" },
    { name: "gmail_send_email_personal", account: "ca_2" },
  ]);
});

test("every name is distinct and callable", () => {
  const names = toolNamesFor("GMAIL_SEND_EMAIL", [
    { id: "ca_1", label: "Ian's Work (Primary)" },
    { id: "ca_2", label: "ian@personal.com" },
    { id: "ca_3", label: null },
  ]);
  const bare = names.map((n) => n.name);
  assert.equal(new Set(bare).size, 3, "a collision would make one account unreachable");
  for (const n of bare) assert.match(n, /^[a-z0-9_]+$/, "tool names cannot carry punctuation");
});

test("each name carries the account it acts as", () => {
  const names = toolNamesFor("SLACK_POST", [
    { id: "ca_a", label: "acme" },
    { id: "ca_b", label: "client" },
  ]);
  assert.equal(names.find((n) => n.name.endsWith("_acme")).account, "ca_a");
  assert.equal(names.find((n) => n.name.endsWith("_client")).account, "ca_b");
});
