import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "artifacts-"));
process.env.ARTIFACT_SHARES_DIR = mkdtempSync(join(tmpdir(), "shares-"));
process.env.EXE_VM_NAME = "agent-host";
delete process.env.EVE_PUBLIC_URL;

const { default: create } = await import("../dist/extension/tools/create.mjs");
const { default: link } = await import("../dist/extension/tools/link.mjs");

const as = (person, surface) => ({
  session: {
    auth: {
      current: { principalId: person, authenticator: "kybernesis", principalType: "user", attributes: surface ? { surface } : {} },
    },
  },
});
const LINK = /^https:\/\/agent-host\.exe\.xyz\/eve\/v1\/kyb\/artifact-shares\/[0-9a-f]{32}$/;

test("on iMessage a new page comes with a link, and the model is told to send it", async () => {
  const out = await create.execute({ title: "Day plan", content: "<h1>Today</h1>" }, as("user_dana", "linq"));
  assert.match(out.url, LINK);
  assert.equal(out.kyb.data.url, out.url);
  assert.match(create.toModelOutput(out).value, /end your reply with the link/);
  assert.ok(create.toModelOutput(out).value.endsWith(out.url));
});

test("in the apps a new page has no link, and the model learns how to get one", async () => {
  const out = await create.execute({ title: "Day plan", content: "<h1>Today</h1>" }, as("user_dana", "studio"));
  assert.equal(out.url, undefined);
  assert.match(create.toModelOutput(out).value, /get one with link/);
});

test("link gives the owner a link to an earlier page, and nobody else", async () => {
  const made = await create.execute({ title: "Earlier", content: "x" }, as("user_dana", "studio"));
  const got = await link.execute({ id: made.artifactId }, as("user_dana", "linq"));
  assert.match(got.url, LINK);
  assert.deepEqual(await link.execute({ id: made.artifactId }, as("user_dana", "linq")), got, "same version, same link");
  assert.match(await link.execute({ id: made.artifactId }, as("user_sam", "linq")), /no artifact/);
  assert.match(await link.execute({ id: made.artifactId }, {}), /no artifact/);
  assert.match(await link.execute({ id: made.artifactId, version: 9 }, as("user_dana", "linq")), /no version 9/);
  assert.match(await link.execute({ id: "../../etc" }, as("user_dana", "linq")), /no artifact/);
});
