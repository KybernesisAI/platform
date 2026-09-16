import assert from "node:assert/strict";
import { test } from "node:test";

import { askingUser } from "../dist/index.js";

const person = (id, type) => ({ session: { id: "s1", auth: { current: { principalId: id, principalType: type } } } });

/**
 * A routine runs as the app, and `eve:app` is truthy — so it passed the hook's
 * `!user` guard and was POSTed to the control plane, which answered 500 on
 * every scheduled turn. The reference host showed 50 notifications delivered
 * for real users and three 500s, all routines. So a routine's completion never
 * reached anyone, and errored on the way to not reaching them.
 */
test("a schedule's app principal is nobody to notify", () => {
  assert.equal(askingUser(person("eve:app", "runtime")), undefined);
});

test("other machine principals are skipped too", () => {
  assert.equal(askingUser(person("eve:anything", undefined)), undefined, "framework namespace");
  assert.equal(askingUser(person("some-id", "agent")), undefined, "an agent is not a person");
  assert.equal(askingUser(person("some-id", "app")), undefined);
});

test("a real person is still notified", () => {
  assert.equal(askingUser(person("af509dae-386e-4fb6-8c76-3443082aaf6f", "user")), "af509dae-386e-4fb6-8c76-3443082aaf6f");
});

test("a person with no declared type is still a person", () => {
  assert.equal(askingUser(person("af509dae", undefined)), "af509dae");
});

test("absent, empty or anonymous principals yield nobody", () => {
  assert.equal(askingUser(undefined), undefined);
  assert.equal(askingUser({}), undefined);
  assert.equal(askingUser({ session: { id: "s", auth: null } }), undefined);
  assert.equal(askingUser(person("", "user")), undefined);
});
