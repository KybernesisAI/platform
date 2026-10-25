import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { artifactCard, createArtifact, shareLink, updateArtifact, wantsLink } from "../dist/index.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const ctx = (attributes) => ({
  session: { auth: { current: { principalId: "user_dana", authenticator: "kybernesis", principalType: "user", attributes } } },
});
const dana = { person: "user_dana", manages: false };

test("only a text-only surface asks for a link, read from the verified attributes", () => {
  assert.equal(wantsLink(ctx({ surface: "linq" })), true);
  assert.equal(wantsLink(ctx({ surface: "studio" })), false);
  assert.equal(wantsLink(ctx({ surface: "dm" })), false);
  assert.equal(wantsLink(ctx({})), false);
  assert.equal(wantsLink({}), false);
});

test("a link is made once per owner and version, in the layout manage serves", () => {
  const dir = tmp("artifacts-");
  const sharesDir = tmp("shares-");
  const options = { dir, sharesDir, publicUrl: "https://agent.example.com/" };
  const meta = createArtifact({ title: "Day plan", content: "<h1>Today</h1>", owner: "user_dana" }, { dir });

  const url = shareLink(meta, options);
  assert.match(url, /^https:\/\/agent\.example\.com\/eve\/v1\/kyb\/artifact-shares\/[0-9a-f]{32}$/);
  assert.equal(shareLink(meta, options), url, "same version, same link");

  const [file] = readdirSync(sharesDir);
  const share = JSON.parse(readFileSync(join(sharesDir, file), "utf8"));
  assert.deepEqual(
    { token: share.token, artifactId: share.artifactId, version: share.version, userId: share.userId },
    { token: url.split("/").at(-1), artifactId: meta.id, version: 1, userId: "user_dana" },
  );

  const next = updateArtifact({ id: meta.id, content: "<h1>Today, again</h1>" }, dana, { dir });
  assert.notEqual(shareLink(next, options), url, "a new version gets its own link");
});

test("no link without a public address or an owner", () => {
  const dir = tmp("artifacts-");
  const sharesDir = tmp("shares-");
  const saved = { ...process.env };
  delete process.env.EVE_PUBLIC_URL;
  delete process.env.EXE_VM_NAME;
  try {
    const owned = createArtifact({ title: "Mine", content: "x", owner: "user_dana" }, { dir });
    assert.equal(shareLink(owned, { dir, sharesDir }), undefined);
    process.env.EXE_VM_NAME = "agent-host";
    assert.match(shareLink(owned, { dir, sharesDir }), /^https:\/\/agent-host\.exe\.xyz\/eve\/v1\/kyb\/artifact-shares\//);
    const unowned = createArtifact({ title: "Routine", content: "x", owner: null }, { dir });
    assert.equal(shareLink(unowned, { dir, sharesDir }), undefined);
  } finally {
    process.env = saved;
  }
});

test("the card carries the link and says it in its text", () => {
  const meta = createArtifact({ title: "Day plan", content: "x", owner: "user_dana" }, { dir: tmp("artifacts-") });
  const card = artifactCard(meta, "https://agent.example.com/eve/v1/kyb/artifact-shares/abc");
  assert.equal(card.data.url, "https://agent.example.com/eve/v1/kyb/artifact-shares/abc");
  assert.equal(card.text, "Day plan: https://agent.example.com/eve/v1/kyb/artifact-shares/abc");
  assert.equal(artifactCard(meta).data.url, undefined);
});
