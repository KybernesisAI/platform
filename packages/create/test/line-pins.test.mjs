import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUZZ_PACKAGE } from "../dist/buzz.js";
import { DISPATCH_DEP, channelPlan } from "../dist/templates.js";
import { EVE_LINE_TAG, EVE_VERSION } from "../dist/util.js";

test("the line tag follows the certified eve", () => {
  const [major, minor] = EVE_VERSION.split(".");
  assert.equal(EVE_LINE_TAG, `eve-${major}.${minor}`);
});

test("dispatch, buzz and multiplayer install from the certified line", () => {
  assert.equal(DISPATCH_DEP, `@kybernesis/dispatch@${EVE_LINE_TAG}`);
  assert.equal(BUZZ_PACKAGE, `@kybernesis/buzz@${EVE_LINE_TAG}`);
  assert.ok(channelPlan("slack", "planner", "exe").deps.includes(`@kybernesis/multiplayer@${EVE_LINE_TAG}`));
});

// A version range written into the source outlives the eve line it was built
// for: at the 0.81 cutover dispatch ^0.7.0, buzz ^0.11.0 and multiplayer
// ^0.6.0 were all 0.68 builds that npm refuses beside eve 0.81.1, and every
// new agent failed its type-check. Specs go through linePackage() instead.
test("no @kybernesis install spec in the source carries a hand-written version", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const offenders = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(src, file), "utf8");
    for (const m of text.matchAll(/@kybernesis\/[a-z-]+@[\^~]?\d[^"'`\s]*/g)) offenders.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});
