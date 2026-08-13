import { test } from "node:test";
import assert from "node:assert/strict";
import { toolInputSchema } from "../dist/index.js";

/**
 * The broker's schema is the only precise thing in a tool payload. If it is
 * dropped or mistranslated the model guesses arguments — well enough to look
 * like it works, badly enough to fail on the third call.
 */
const gmailish = {
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Gmail search query" },
      max_results: { type: "integer" },
      include_spam: { type: "boolean" },
      label_ids: { type: "array", items: { type: "string" } },
      format: { type: "string", enum: ["full", "metadata", "minimal"] },
      payload: { type: "object", properties: { subject: { type: "string" } } },
      mystery: { type: "not-a-real-type" },
    },
  },
};

test("accepts a well-formed call", () => {
  const schema = toolInputSchema(gmailish);
  assert.ok(
    schema.safeParse({
      query: "from:npm",
      max_results: 5,
      label_ids: ["INBOX"],
      format: "metadata",
      payload: { subject: "hi" },
    }).success,
  );
});

test("required fields are required", () => {
  assert.equal(toolInputSchema(gmailish).safeParse({ max_results: 5 }).success, false);
});

test("optional fields may be omitted", () => {
  assert.ok(toolInputSchema(gmailish).safeParse({ query: "x" }).success);
});

test("enums are enforced", () => {
  assert.equal(toolInputSchema(gmailish).safeParse({ query: "x", format: "nope" }).success, false);
});

test("types are enforced", () => {
  assert.equal(toolInputSchema(gmailish).safeParse({ query: 5 }).success, false);
});

test("an unknown construct stays permissive rather than wrong", () => {
  // Better that the model can pass a field we did not understand than that we
  // invent a rule the service does not have.
  assert.ok(toolInputSchema(gmailish).safeParse({ query: "x", mystery: { any: "shape" } }).success);
});

test("no properties means open, not empty", () => {
  const open = toolInputSchema({ inputSchema: { type: "object" } });
  assert.ok(open.safeParse({ anything: 1 }).success);
});

test("a missing schema is open", () => {
  assert.ok(toolInputSchema({}).safeParse({ anything: 1 }).success);
});
