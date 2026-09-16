import assert from "node:assert/strict";
import { test } from "node:test";

import { newestOnLine, rangeContains, versionCompare } from "../dist/on-line-version.js";

/**
 * Real published data. @kybernesis packages ship one build per eve line and the
 * versions are NOT ordered by line: voice 0.1.2 is the eve 0.49 build and was
 * published AFTER 0.1.1, the 0.51 build. npm's `latest` is therefore routinely
 * the wrong package, and installing it puts an agent on a build compiled
 * against an eve API it is not running — silently, until one path breaks.
 */
const voice = [
  { version: "0.1.0", peer: ">=0.51.0 <0.52.0" },
  { version: "0.1.1", peer: ">=0.51.0 <0.52.0" },
  { version: "0.1.2", peer: ">=0.49.0 <0.50.0" },
];
const manage = [
  { version: "0.8.0", peer: ">=0.49.0 <0.50.0" },
  { version: "0.8.1", peer: ">=0.49.0 <0.50.0" },
  { version: "0.8.2", peer: ">=0.53.0 <0.54.0" },
  { version: "0.8.3", peer: ">=0.51.0 <0.52.0" },
  { version: "0.8.6", peer: ">=0.51.0 <0.52.0" },
  { version: "0.8.7", peer: ">=0.49.0 <0.50.0" },
];

test("latest is not the answer: an 0.49 host gets the 0.49 build", () => {
  assert.equal(newestOnLine(voice, "0.49.0"), "0.1.2", "not 0.1.1, which npm calls latest");
  assert.equal(newestOnLine(manage, "0.49.0"), "0.8.7", "not 0.8.6");
});

test("an 0.51 host gets the newest 0.51 build, skipping higher-numbered 0.49 ones", () => {
  assert.equal(newestOnLine(voice, "0.51.1"), "0.1.1");
  assert.equal(newestOnLine(manage, "0.51.1"), "0.8.6", "0.8.7 is higher but is the 0.49 build");
});

/**
 * voice had NO 0.49 build for weeks while two agents on 0.49 ran its 0.51 one.
 * "None" is a real answer that must be surfaced, never smoothed into latest.
 */
test("no supported build yields undefined rather than a wrong one", () => {
  const only51 = voice.filter((v) => v.peer.includes("0.51"));
  assert.equal(newestOnLine(only51, "0.49.0"), undefined);
});

test("an unparseable or absent range is never treated as support", () => {
  assert.equal(rangeContains(undefined, "0.49.0"), false);
  assert.equal(rangeContains("", "0.49.0"), false);
  assert.equal(rangeContains("workspace:*", "0.49.0"), false, "unknown syntax must not read as yes");
  assert.equal(newestOnLine([{ version: "1.0.0" }], "0.49.0"), undefined, "no peer, no claim");
});

test("bounded ranges are exclusive at the top and inclusive at the bottom", () => {
  assert.equal(rangeContains(">=0.49.0 <0.50.0", "0.49.0"), true);
  assert.equal(rangeContains(">=0.49.0 <0.50.0", "0.49.9"), true);
  assert.equal(rangeContains(">=0.49.0 <0.50.0", "0.50.0"), false);
  assert.equal(rangeContains(">=0.49.0 <0.50.0", "0.48.9"), false);
});

test("caret on 0.x is minor-locked, as npm treats it", () => {
  assert.equal(rangeContains("^0.49.0", "0.49.5"), true);
  assert.equal(rangeContains("^0.49.0", "0.50.0"), false);
});

test("versions sort numerically, not as strings", () => {
  assert.ok(versionCompare("0.8.10", "0.8.9") > 0, "10 beats 9");
  assert.ok(versionCompare("0.1.2-rc.1", "0.1.2") < 0, "a prerelease is below its release");
});
