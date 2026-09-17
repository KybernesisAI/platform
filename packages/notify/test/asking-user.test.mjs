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

/**
 * These are the literal principals eve's own `localDev()` and `none()` install,
 * read out of the 0.51.1 runtime — note that neither type appears in eve's
 * declared `RuntimeSessionPrincipalType` union, which is why enumerating the
 * machine types could never have been complete.
 *
 * `local-dev` is the principal on EVERY `eve dev` turn and every eval turn. The
 * first version of this guard listed the machine types and treated the rest as
 * people, so it POSTed `local-dev` and took a 500 back once per turn.
 */
test("eve's own dev and anonymous principals are nobody", () => {
  assert.equal(askingUser(person("local-dev", "local-dev")), undefined, "every eve dev and eval turn");
  assert.equal(askingUser(person("anonymous", "anonymous")), undefined);
});

/** The rest of eve's declared principal type union. None of them is a person. */
test("service, runtime and unknown principals are nobody", () => {
  assert.equal(askingUser(person("svc-7", "service")), undefined);
  assert.equal(askingUser(person("rt-7", "runtime")), undefined);
  assert.equal(askingUser(person("who-7", "unknown")), undefined);
});

test("a real person is still notified", () => {
  assert.equal(askingUser(person("af509dae-386e-4fb6-8c76-3443082aaf6f", "user")), "af509dae-386e-4fb6-8c76-3443082aaf6f");
});

/**
 * Real people reach an agent through more than one authenticator — `kybernesis`
 * from Studio and the clients, `slack-webhook` from a Slack sender, and a
 * client's own provider on a self-hosted deployment. The type is the test; the
 * authenticator's name is not, or the next client's provider stops ringing.
 */
test("a person is a person whatever authenticated them", () => {
  const via = (authenticator) => ({
    session: { id: "s1", auth: { current: { authenticator, principalId: "p-1", principalType: "user" } } },
  });
  for (const authenticator of ["kybernesis", "slack-webhook", "better-auth:vercel"]) {
    assert.equal(askingUser(via(authenticator)), "p-1", authenticator);
  }
});

/**
 * Default-deny. An untyped principal used to count as a person, which is the
 * polarity that let `local-dev` through. eve declares `principalType` as
 * required, so an absent one means we are looking at something we do not
 * understand — and the cost of guessing wrong is a 500 per turn.
 */
test("an untyped principal is not assumed to be a person", () => {
  assert.equal(askingUser(person("af509dae", undefined)), undefined);
});

test("absent, empty or anonymous principals yield nobody", () => {
  assert.equal(askingUser(undefined), undefined);
  assert.equal(askingUser({}), undefined);
  assert.equal(askingUser({ session: { id: "s", auth: null } }), undefined);
  assert.equal(askingUser(person("", "user")), undefined);
});
