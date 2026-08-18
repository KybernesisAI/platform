import assert from "node:assert/strict";
import { test } from "node:test";

import { assertedAsker } from "../dist/asked-by.js";

const sessionWith = (attributes) => ({ auth: { current: { attributes } } });

test("an id and a label both come through", () => {
  const asker = assertedAsker(
    sessionWith({ assertedAskerId: "usr_1", assertedAskerLabel: "ian@example.com" }),
  );
  assert.deepEqual(asker, { id: "usr_1", label: "ian@example.com" });
});

test("an id alone is enough — the label is what a caller may not have", () => {
  assert.deepEqual(assertedAsker(sessionWith({ assertedAskerId: "usr_1" })), { id: "usr_1" });
});

test("no assertion means nobody in particular asked", () => {
  assert.equal(assertedAsker(sessionWith({ kind: "a2a", callerAgent: "atlas" })), undefined);
});

test("an unattended turn has no principal at all, and must not throw", () => {
  assert.equal(assertedAsker({ auth: { current: null } }), undefined);
  assert.equal(assertedAsker({}), undefined);
  assert.equal(assertedAsker(undefined), undefined);
});

test("a non-string id is not an id", () => {
  // A caller controls this value, so the shape is checked rather than trusted:
  // an object here would otherwise reach a template as "[object Object]".
  assert.equal(assertedAsker(sessionWith({ assertedAskerId: { id: "usr_1" } })), undefined);
  assert.equal(assertedAsker(sessionWith({ assertedAskerId: "" })), undefined);
});

test("a non-string label is dropped, not carried", () => {
  assert.deepEqual(assertedAsker(sessionWith({ assertedAskerId: "usr_1", assertedAskerLabel: 42 })), {
    id: "usr_1",
  });
});
