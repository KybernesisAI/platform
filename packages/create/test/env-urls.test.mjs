import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEnvUrl, envUrlProblems, expectsUrl } from "../dist/env-urls.js";

/**
 * The live defect. `POSTHOG_HOST` without a scheme produced
 * "Failed to parse URL from <host>/batch/" once per turn on the reference
 * fleet — 121 of them — and dropped every analytics event, while the agent
 * reported healthy.
 */
test("a scheme-less base-url host is caught", () => {
  const problem = checkEnvUrl("POSTHOG_HOST", "eu.i.posthog.com");
  assert.equal(problem?.reason, "no scheme");
  assert.match(problem.fix, /https:\/\//);
});

test("the same host with a scheme is fine", () => {
  assert.equal(checkEnvUrl("POSTHOG_HOST", "https://eu.i.posthog.com"), undefined);
});

/**
 * The reason `_HOST` is an allowlist and not a rule. These hold bare hostnames
 * on purpose, and a doctor that flagged them would be telling clients their
 * correct config is broken.
 */
test("ordinary hostname vars are not treated as URLs", () => {
  for (const name of ["SMTP_HOST", "PGHOST", "REDIS_HOST", "DB_HOST"]) {
    assert.equal(expectsUrl(name), false, name);
  }
  assert.deepEqual(envUrlProblems("SMTP_HOST=smtp.example.com\nREDIS_HOST=10.0.0.4"), []);
});

test("names that are unambiguously whole URLs are checked", () => {
  for (const name of ["KYBERNESIS_ISSUER", "WEBHOOK_URL", "OTEL_EXPORTER_ENDPOINT"]) {
    assert.equal(expectsUrl(name), true, name);
  }
});

test("a non-http scheme is reported", () => {
  assert.equal(checkEnvUrl("SOME_URL", "ftp://files.example.com")?.reason, "not http(s)");
  assert.equal(checkEnvUrl("SOME_URL", "postgres://db/x")?.reason, "not http(s)");
});

test("junk is reported as not a url", () => {
  assert.equal(checkEnvUrl("SOME_URL", "<your endpoint here>")?.reason, "not a url");
});

test("an unset or empty value is somebody else's check", () => {
  assert.equal(checkEnvUrl("SOME_URL", ""), undefined);
  assert.equal(checkEnvUrl("SOME_URL", "   "), undefined);
});

/** These files are written with and without quotes; both must parse. */
test("quoted values are unwrapped before checking", () => {
  assert.equal(checkEnvUrl("SOME_URL", '"https://example.com"'), undefined);
  assert.equal(checkEnvUrl("SOME_URL", "'posthog.example.com'")?.reason, "no scheme");
});

test("comments and blank lines are skipped, and the value never leaks", () => {
  const problems = envUrlProblems(
    ["# a note", "", "POSTHOG_HOST=eu.i.posthog.com", "SECRET_TOKEN=sk-live-abcdef"].join("\n")
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, "POSTHOG_HOST");
  const rendered = JSON.stringify(problems);
  assert.ok(!rendered.includes("eu.i.posthog.com"), "the value must not appear in the report");
  assert.ok(!rendered.includes("sk-live"), "nor any neighbouring secret");
});
