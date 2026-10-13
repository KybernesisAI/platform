import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bakedImageTag, bakeKey } from "../dist/index.js";
import { COMPUTER_VERSION } from "../dist/provider.js";

// The bake key carries the package version so an upgrade never reuses an old
// bake. The version is a source constant (eve bundles agent modules, so a
// runtime read of package.json fails); this keeps the two in step.
test("COMPUTER_VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(COMPUTER_VERSION, pkg.version);
});

test("the baked tag names the recipe and the bake key", () => {
  assert.match(bakedImageTag(), new RegExp(`^kybernesis/agent-computer:baked-[0-9a-f]{10}-${bakeKey()}$`));
});
