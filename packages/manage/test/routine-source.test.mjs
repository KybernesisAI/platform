import assert from "node:assert/strict";
import { test } from "node:test";

import { routineOwner, routineSource } from "../dist/routine-source.js";

/**
 * The bug this file exists to prevent: routines were scaffolded with eve's
 * `markdown` form, which eve documents as discarding the agent's output. Every
 * routine anyone created in Studio ran on schedule and threw its answer away.
 * These pin the shape that has a destination.
 */
test("a routine with no destination delivers through the manage channel", () => {
  const src = routineSource({
    name: "daily-good-morning",
    cron: "0 2 * * *",
    instruction: "Say good morning to Ian.",
    manageChannelModule: "kyb",
  });
  assert.match(src, /run:/, "must use the run form");
  assert.doesNotMatch(src, /markdown:/, "markdown discards the output — never scaffold it");
  assert.match(src, /import manage from "\.\.\/channels\/kyb\.js"/);
  assert.match(src, /to\(manage, \{ routine: "daily-good-morning" \}\)/);
  assert.match(src, /auth: appAuth/, "a schedule runs as the agent");
});

test("a named destination is used instead", () => {
  const src = routineSource({
    name: "sales-digest",
    cron: "0 9 * * 1",
    instruction: "Post the weekly digest.",
    manageChannelModule: "kyb",
    destination: { channel: "buzz", target: { channelId: "C123" } },
  });
  assert.match(src, /import target from "\.\.\/channels\/buzz\.js"/);
  assert.match(src, /to\(target, \{"channelId":"C123"\}\)/);
  assert.doesNotMatch(src, /channels\/kyb\.js/, "the manage channel is the fallback, not an extra hop");
});

test("an instruction cannot break out of the file", () => {
  const nasty = 'Say "hi"\nand: });\nconsole.log("owned")';
  const src = routineSource({
    name: "x",
    cron: "0 1 * * *",
    instruction: nasty,
    manageChannelModule: "kyb",
  });
  // Embedded as a JSON string literal, so the quotes and newlines cannot end it.
  assert.match(src, /\\n/, "newlines stay escaped");
  assert.doesNotMatch(src, /\n *console\.log\("owned"\)/, "must not become live code");
  assert.equal((src.match(/defineSchedule\(/g) ?? []).length, 1);
});

test("the agent's channel filename is configurable", () => {
  const src = routineSource({
    name: "r",
    cron: "0 1 * * *",
    instruction: "do it",
    manageChannelModule: "manage",
  });
  assert.match(src, /\.\.\/channels\/manage\.js/);
});

test("a routine someone asked for runs as them, and says it is a routine", () => {
  const owner = routineOwner(
    {
      authenticator: "kybernesis",
      issuer: "https://cp.test",
      principalId: "usr_1",
      principalType: "user",
      subject: "usr_1",
      attributes: { org: "org_1", email: "me@example.com", agentGrantLevel: "manage", surface: "voice", count: 3 },
    },
    "daily-calendar",
  );
  assert.deepEqual(owner.attributes, {
    org: "org_1",
    email: "me@example.com",
    agentGrantLevel: "manage",
    trigger: "routine",
    routine: "daily-calendar",
  }, "where the asking turn came from is not where the routine runs");
  const src = routineSource({ name: "daily-calendar", cron: "0 0 * * *", instruction: "Refresh it.", manageChannelModule: "kyb", owner });
  assert.doesNotMatch(src, /appAuth/, "not the agent's own principal");
  assert.match(src, /"principalId":"usr_1"/);
  assert.match(src, /"trigger":"routine"/);
  assert.match(src, /run: \(\{ to, waitUntil \}\)/);
});

test("nobody to run as: not a person, or a framework principal", () => {
  assert.equal(routineOwner({ principalId: "eve:app", principalType: "runtime" }, "r"), undefined);
  assert.equal(routineOwner({ principalId: "eve:local-dev", principalType: "user" }, "r"), undefined);
  assert.equal(routineOwner(undefined, "r"), undefined);
  assert.equal(routineOwner({ principalId: "agent-1", principalType: "agent" }, "r"), undefined);
});
