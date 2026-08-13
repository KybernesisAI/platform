import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpInputSchema } from "../dist/index.js";

/**
 * These cases are Plaud's actual published schemas, copied from a live
 * `tools/list`. The resolver used to discard them and hand the model an open
 * object; the model then spent nine calls guessing the name of an argument the
 * server had declared, with a description, all along.
 */

test("a required argument is required", () => {
  // Plaud's get_file, verbatim.
  const schema = mcpInputSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { file_id: { type: "string", description: "The file ID to retrieve" } },
    required: ["file_id"],
  });

  assert.equal(schema.safeParse({}).success, false, "an empty call must not pass");
  assert.equal(schema.safeParse({ file_id: "abc" }).success, true);
});

test("a server that declares no properties keeps an open door", () => {
  // Plaud's login takes no declared arguments. An empty object schema would
  // assert it accepts nothing, which is a stronger claim than the server made.
  const schema = mcpInputSchema({ type: "object", properties: {} });
  assert.equal(schema.safeParse({ anything: 1 }).success, true);
  assert.equal(mcpInputSchema(undefined).safeParse({ a: 1 }).success, true);
});

test("optional stays optional, and types are enforced", () => {
  // Plaud's list_files.
  const schema = mcpInputSchema({
    type: "object",
    properties: {
      page: { type: "number", default: 1, description: "Page number" },
      tags: { type: "array", items: { type: "string" } },
      starred: { type: "boolean" },
    },
  });

  assert.equal(schema.safeParse({}).success, true, "nothing is required");
  assert.equal(schema.safeParse({ tags: ["a"] }).success, true);
  assert.equal(schema.safeParse({ tags: [5] }).success, false, "array items are typed");
  assert.equal(schema.safeParse({ page: "2" }).success, false);
});

test("enums become choices, not free text", () => {
  const schema = mcpInputSchema({
    type: "object",
    properties: { order: { type: "string", enum: ["asc", "desc"] } },
  });
  assert.equal(schema.safeParse({ order: "asc" }).success, true);
  assert.equal(schema.safeParse({ order: "sideways" }).success, false);
});

test("nested objects survive, unknown constructs stay permissive", () => {
  const schema = mcpInputSchema({
    type: "object",
    required: ["filter"],
    properties: {
      filter: { type: "object", properties: { since: { type: "string" } } },
      // No type at all: a server telling us nothing must not become a wall.
      extra: {},
      // A union type; take the first and stay usable rather than refusing.
      id: { type: ["string", "number"] },
    },
  });

  assert.equal(schema.safeParse({ filter: { since: "2026-01-01" } }).success, true);
  assert.equal(schema.safeParse({ filter: {}, extra: { anything: true } }).success, true);
  assert.equal(schema.safeParse({}).success, false);
});

test("descriptions carry through — they are what the model reads", () => {
  const schema = mcpInputSchema({
    type: "object",
    properties: { file_id: { type: "string", description: "The file ID to retrieve" } },
    required: ["file_id"],
  });
  assert.equal(schema.shape.file_id.description, "The file ID to retrieve");
});
