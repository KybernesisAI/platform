import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  artifactCard,
  canSee,
  createArtifact,
  KEEP_VERSIONS,
  listArtifacts,
  MAX_BYTES,
  readArtifact,
  updateArtifact,
  viewerFromContext,
} from "../dist/index.js";

const store = () => ({ dir: mkdtempSync(join(tmpdir(), "artifacts-")) });
const ctx = (current) => ({ session: { auth: { current } } });
const dana = { person: "user_dana", manages: false };
const owner = { person: "user_owner", manages: true };
const nobody = { person: null, manages: false };

test("a person is only a principal the control plane signed in as a user", () => {
  assert.deepEqual(
    viewerFromContext(ctx({ principalId: "user_dana", authenticator: "kybernesis", principalType: "user", attributes: { agentGrantLevel: "use" } })),
    dana,
  );
  assert.deepEqual(
    viewerFromContext(ctx({ principalId: "user_owner", authenticator: "kybernesis", principalType: "user", attributes: { agentGrantLevel: "manage" } })),
    owner,
  );
  // eve's own principals, a routine's app principal, and unknown types are nobody.
  assert.deepEqual(viewerFromContext(ctx({ principalId: "eve:app", authenticator: "eve", principalType: "runtime" })), nobody);
  assert.deepEqual(viewerFromContext(ctx({ principalId: "local-dev", authenticator: "local-dev", principalType: "user" })), nobody);
  assert.deepEqual(viewerFromContext(ctx({ principalId: "peer", authenticator: "kybernesis", principalType: "agent" })), nobody);
  assert.deepEqual(viewerFromContext(ctx(null)), nobody);
  assert.deepEqual(viewerFromContext({}), nobody);
});

test("an artifact is its owner's alone; an unowned one is for the people who manage the agent", () => {
  assert.equal(canSee({ owner: "user_dana" }, dana), true);
  assert.equal(canSee({ owner: "user_dana" }, owner), false, "managing the agent does not open someone else's artifact");
  assert.equal(canSee({ owner: "user_dana" }, nobody), false);
  assert.equal(canSee({ owner: null }, owner), true);
  assert.equal(canSee({ owner: null }, dana), false);
  assert.equal(canSee({ owner: null }, nobody), true, "a routine can find what a routine made");
});

test("create, update and read keep one id across versions", () => {
  const options = store();
  const made = createArtifact({ title: "  Website,\n last 7 days ", content: "<h1>v1</h1>", owner: "user_dana" }, options);
  assert.match(made.id, /^[0-9a-f]{32}$/);
  assert.equal(made.title, "Website, last 7 days");
  assert.equal(made.format, "html");
  assert.equal(made.display, "document");
  assert.equal(made.version, 1);

  const next = updateArtifact({ id: made.id, content: "<h1>v2</h1>", note: "added   Thursday", display: "inline" }, dana, options);
  assert.equal(next.id, made.id);
  assert.equal(next.version, 2);
  assert.equal(next.display, "inline");
  assert.equal(next.versions[1].note, "added Thursday");

  assert.equal(readArtifact(made.id, dana, undefined, options).content, "<h1>v2</h1>");
  assert.equal(readArtifact(made.id, dana, 1, options).content, "<h1>v1</h1>");
  assert.equal(readArtifact(made.id, owner, undefined, options), null, "not the owner's to read");
  assert.throws(() => updateArtifact({ id: made.id, content: "x" }, owner, options), /no artifact/);
});

test("markdown keeps its format and file name", () => {
  const options = store();
  const made = createArtifact({ title: "Notes", content: "# Notes", format: "markdown", owner: null }, options);
  assert.ok(existsSync(join(options.dir, made.id, "v1.md")));
  const next = updateArtifact({ id: made.id, content: "# Notes 2" }, nobody, options);
  assert.equal(next.format, "markdown");
  assert.ok(existsSync(join(options.dir, made.id, "v2.md")));
});

test("list shows only what the viewer can see, newest first", () => {
  const options = store();
  let t = 0;
  const clock = { ...options, now: () => new Date(Date.UTC(2026, 9, 23, 9, t++)) };
  const a = createArtifact({ title: "A", content: "a", owner: "user_dana" }, clock);
  createArtifact({ title: "B", content: "b", owner: "user_other" }, clock);
  const c = createArtifact({ title: "C", content: "c", owner: null }, clock);
  updateArtifact({ id: a.id, content: "a2" }, dana, clock);
  assert.deepEqual(listArtifacts(dana, options).map((m) => m.title), ["A"]);
  assert.deepEqual(listArtifacts(owner, options).map((m) => m.title), ["C"]);
  assert.deepEqual(listArtifacts(nobody, options).map((m) => m.id), [c.id]);
  assert.deepEqual(listArtifacts(dana, { dir: join(options.dir, "missing") }), []);
});

test("ids from outside never reach the disk", () => {
  const options = store();
  for (const id of ["../etc", "..", "a".repeat(31), `${"a".repeat(32)}/x`, "A".repeat(32)]) {
    assert.equal(readArtifact(id, nobody, undefined, options), null);
    assert.throws(() => updateArtifact({ id, content: "x" }, nobody, options), /no artifact/);
  }
});

test("empty, oversized and untitled content is refused", () => {
  const options = store();
  assert.throws(() => createArtifact({ title: "x", content: "", owner: null }, options), /empty/);
  assert.throws(() => createArtifact({ title: "  ", content: "x", owner: null }, options), /title/);
  assert.throws(() => createArtifact({ title: "x", content: "a".repeat(MAX_BYTES + 1), owner: null }, options), /limit/);
});

test("old version files are pruned, their history kept", () => {
  const options = store();
  const made = createArtifact({ title: "x", content: "v1", owner: null }, options);
  let meta = made;
  for (let i = 2; i <= KEEP_VERSIONS + 3; i++) meta = updateArtifact({ id: made.id, content: `v${i}` }, nobody, options);
  const files = readdirSync(join(options.dir, made.id)).filter((f) => f.startsWith("v"));
  assert.equal(files.length, KEEP_VERSIONS);
  assert.equal(meta.versions.length, KEEP_VERSIONS + 3);
  assert.equal(readArtifact(made.id, nobody, 1, options), null);
  assert.equal(readArtifact(made.id, nobody, undefined, options).content, `v${KEEP_VERSIONS + 3}`);
});

test("the card uses the shared envelope and the artifact's id", () => {
  const options = store();
  const made = createArtifact({ title: "Funnel", content: "<p>x</p>", display: "inline", owner: "user_dana" }, options);
  const card = artifactCard(made);
  assert.equal(card.kyb, 1);
  assert.equal(card.card, "artifact");
  assert.equal(card.id, made.id);
  assert.deepEqual(card.data, { artifactId: made.id, version: 1, display: "inline", format: "html", updatedAt: made.updatedAt });
  assert.deepEqual(card.actions, [{ label: "Open", artifact: made.id }]);
  assert.match(card.text, /Funnel/);
  assert.equal("owner" in card.data, false, "the card never names the owner");
});
