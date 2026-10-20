import { test } from "node:test";
import assert from "node:assert/strict";
import { boundResult, DEFAULT_MAX_RESULT_CHARS } from "../dist/index.js";

/**
 * A mail search once came back at 2.2M tokens and broke the conversation for
 * good: every later turn re-sent it. These cases are shaped like that payload,
 * with company-general content.
 */
const encoded = "QUJD".repeat(50_000); // 200k chars of base64
const html = "<div style=\"font-family:Arial\"><p>Quarterly planning notes</p></div>".repeat(2_000);

function mailbox(n) {
  return {
    successful: true,
    data: {
      messages: Array.from({ length: n }, (_, i) => ({
        messageId: `m-${i}`,
        subject: `Planning update ${i}`,
        sender: "planner@example.com",
        messageText: html,
        payload: { parts: [{ mimeType: "application/pdf", body: { data: encoded } }] },
      })),
    },
  };
}

const chars = (v) => JSON.stringify(v).length;

test("small results pass through untouched", () => {
  const small = { ok: true, items: [1, 2, 3] };
  assert.equal(boundResult(small), small);
});

test("a large mailbox fits the bound and keeps every message's opening", () => {
  const out = boundResult(mailbox(20));
  assert.ok(chars(out) <= DEFAULT_MAX_RESULT_CHARS + 400, `got ${chars(out)}`);
  assert.equal(typeof out, "object");
  assert.match(out._note, /shortened/);
  assert.equal(out.data.messages.length, 20);
  assert.equal(out.data.messages[19].subject, "Planning update 19");
  assert.match(out.data.messages[0].messageText, /^<div style/);
});

test("encoded data is dropped before any text is cut", () => {
  const out = boundResult({ text: "hello", file: encoded }, 1_000);
  assert.equal(out.text, "hello");
  assert.match(out.file, /characters of encoded data omitted/);
});

test("a single huge string is cut with a note", () => {
  const out = boundResult("word ".repeat(100_000), 5_000);
  assert.ok(chars(out) <= 5_400);
});

test("a custom bound is honoured", () => {
  const out = boundResult(mailbox(5), 10_000);
  assert.ok(chars(out) <= 10_400, `got ${chars(out)}`);
});

test("a long list keeps its first items", () => {
  const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: i, name: `row ${i}` }));
  const out = boundResult({ rows }, 5_000);
  assert.ok(chars(out) <= 5_400, `got ${chars(out)}`);
  assert.equal(out.rows[0].id, 0);
});
