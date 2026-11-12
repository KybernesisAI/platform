import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bakedImageTag, bakeKey } from "../dist/index.js";
import { COMPUTER_USE_REVALIDATION_KEY, COMPUTER_VERSION } from "../dist/provider.js";

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

test("the computer-use stack revision matches the installed eve's", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("eve/package.json"));
  const source = readFileSync(join(root, "dist/src/computer-use/extension/lib/computer-use-sandbox.js"), "utf8");
  const found = source.match(/computer-use:[0-9.]+:[0-9-]+\.[0-9]+/)?.[0];
  assert.equal(COMPUTER_USE_REVALIDATION_KEY, found);
});
