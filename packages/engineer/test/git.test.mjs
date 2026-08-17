import assert from "node:assert/strict";
import { test } from "node:test";

import { brokeredGitPolicy, httpsRemote, refuseBranch } from "../dist/git.js";

test("the credential rides on egress, not in the sandbox", () => {
  const policy = brokeredGitPolicy({ token: "ghs_secret" });
  const header = policy.allow["github.com"][0].transform[0].headers.Authorization;
  assert.match(header, /^Basic /);
  assert.equal(
    Buffer.from(header.slice("Basic ".length), "base64").toString(),
    "x-access-token:ghs_secret",
  );
  // General egress stays open, or the sandbox cannot install what it needs to
  // verify its own work.
  assert.deepEqual(policy.allow["*"], []);
});

test("only the named host is brokered", () => {
  const policy = brokeredGitPolicy({ token: "t", host: "git.internal" });
  assert.ok(policy.allow["git.internal"], "the host asked for");
  assert.equal(policy.allow["github.com"], undefined, "and nothing else");
});

test("the username half is configurable, because it is not universal", () => {
  const policy = brokeredGitPolicy({ token: "t", username: "oauth2" });
  const header = policy.allow["github.com"][0].transform[0].headers.Authorization;
  assert.equal(Buffer.from(header.slice(6), "base64").toString(), "oauth2:t");
});

test("the remote is named literally, never as origin", () => {
  assert.equal(httpsRemote("acme/widgets"), "https://github.com/acme/widgets.git");
  assert.equal(httpsRemote("acme/widgets", "git.internal"), "https://git.internal/acme/widgets.git");
});

test("the default branch is refused outright", () => {
  assert.match(refuseBranch("main"), /not allowed/);
  assert.match(refuseBranch("master"), /not allowed/);
  assert.equal(refuseBranch("feature/add-search"), null);
});

test("a protected branch cannot be reached under another name", () => {
  assert.match(refuseBranch("refs/heads/main"), /plain branch name/);
  assert.match(refuseBranch("HEAD"), /plain branch name/);
});

test("shell metacharacters never reach a command line", () => {
  for (const branch of ["a;rm -rf /", "a branch", "a$(id)", "a`id`", "--upload-pack=x", "a..b", "a//b"]) {
    assert.match(refuseBranch(branch), /not a valid branch name/, branch);
  }
});

test("what counts as protected is the caller's to decide", () => {
  assert.match(refuseBranch("release", { protect: ["release"] }), /not allowed/);
  assert.equal(refuseBranch("main", { protect: ["release"] }), null, "explicitly narrowed");
});
