import assert from "node:assert/strict";
import { test } from "node:test";
import { registryItemRef } from "../dist/index.js";

test("a bare catalog name is installed from the Kybernesis registry; a scoped or path name is left alone", () => {
  assert.equal(registryItemRef("vault"), "@kybernesis/vault");
  assert.equal(registryItemRef(" payments "), "@kybernesis/payments");
  assert.equal(registryItemRef("@kybernesis/vault"), "@kybernesis/vault");
  assert.equal(registryItemRef("tool/ask_question"), "tool/ask_question");
});
