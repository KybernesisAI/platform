import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactRoutes, visibleTo } from "../dist/artifacts.js";

const DANA = "a".repeat(32);
const OTHER = "b".repeat(32);
const ROUTINE = "c".repeat(32);

/** The layout @kybernesis/artifacts writes. */
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-"));
  const put = (id, owner, updatedAt, versions, format = "html") => {
    mkdirSync(join(dir, id));
    const ext = format === "markdown" ? "md" : "html";
    for (let v = 1; v <= versions; v++) writeFileSync(join(dir, id, `v${v}.${ext}`), `<p>${id.slice(0, 1)} v${v}</p>`);
    const meta = {
      id, title: `T ${id.slice(0, 1)}`, format, display: "document", owner, createdAt: updatedAt, updatedAt, version: versions,
      versions: Array.from({ length: versions }, (_, i) => ({ version: i + 1, createdAt: updatedAt, bytes: 10 })),
    };
    writeFileSync(join(dir, id, "meta.json"), JSON.stringify(meta));
  };
  put(DANA, "user_dana", "2026-10-23T09:00:00.000Z", 2);
  put(OTHER, "user_other", "2026-10-23T10:00:00.000Z", 1);
  put(ROUTINE, null, "2026-10-23T08:00:00.000Z", 1, "markdown");
  mkdirSync(join(dir, "not-an-id"));
  return dir;
}

const as = (userId, level = "use") => async () => ({ userId, level });
const route = (routes, path) => routes.find((r) => r.path === path);
const call = (r, url, params = {}) => r.handler(new Request(`http://x${url}`), { params });

test("visibility: the owner alone, or managers for what nobody owns", () => {
  assert.equal(visibleTo({ owner: "user_dana" }, { userId: "user_dana", level: "use" }), true);
  assert.equal(visibleTo({ owner: "user_dana" }, { userId: "user_owner", level: "manage" }), false);
  assert.equal(visibleTo({ owner: null }, { userId: "user_owner", level: "manage" }), true);
  assert.equal(visibleTo({ owner: null }, { userId: "user_dana", level: "use" }), false);
});

test("the list is the caller's own, newest first, without owner ids or history", async () => {
  const dir = seed();
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_dana") });
  const body = await (await call(route(routes, "/eve/v1/kyb/artifacts"), "/eve/v1/kyb/artifacts")).json();
  assert.deepEqual(body.artifacts.map((a) => a.id), [DANA]);
  assert.equal("owner" in body.artifacts[0], false);
  assert.equal("versions" in body.artifacts[0], false);

  const managerRoutes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_owner", "manage") });
  const managed = await (await call(route(managerRoutes, "/eve/v1/kyb/artifacts"), "/eve/v1/kyb/artifacts")).json();
  assert.deepEqual(managed.artifacts.map((a) => a.id), [ROUTINE]);
});

test("someone else's artifact is a 404, the same as a missing one", async () => {
  const dir = seed();
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_dana") });
  const one = route(routes, "/eve/v1/kyb/artifacts/:id");
  assert.equal((await call(one, "/", { id: OTHER })).status, 404);
  assert.equal((await call(one, "/", { id: "f".repeat(32) })).status, 404);
  assert.equal((await call(one, "/", { id: "../etc" })).status, 404);
  const mine = await (await call(one, "/", { id: DANA })).json();
  assert.equal(mine.artifact.version, 2);
  assert.equal(mine.artifact.versions.length, 2);
  assert.equal("owner" in mine.artifact, false);
});

test("content is served as text that never runs, latest or by version", async () => {
  const dir = seed();
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_dana") });
  const content = route(routes, "/eve/v1/kyb/artifacts/:id/content");
  const latest = await call(content, `/eve/v1/kyb/artifacts/${DANA}/content`, { id: DANA });
  assert.equal(latest.status, 200);
  assert.equal(await latest.text(), "<p>a v2</p>");
  assert.equal(latest.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(latest.headers.get("x-content-type-options"), "nosniff");
  assert.match(latest.headers.get("content-security-policy"), /sandbox/);
  assert.equal(latest.headers.get("x-artifact-version"), "2");
  assert.equal(latest.headers.get("x-artifact-format"), "html");

  const first = await call(content, `/eve/v1/kyb/artifacts/${DANA}/content?v=1`, { id: DANA });
  assert.equal(await first.text(), "<p>a v1</p>");
  for (const v of ["0", "3", "x", "1.5"]) {
    assert.equal((await call(content, `/eve/v1/kyb/artifacts/${DANA}/content?v=${v}`, { id: DANA })).status, 404, `v=${v}`);
  }
  assert.equal((await call(content, `/eve/v1/kyb/artifacts/${OTHER}/content`, { id: OTHER })).status, 404);
});

test("a refused caller gets the refusal", async () => {
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir: seed() }, identify: async () => new Response("no", { status: 401 }) });
  for (const r of routes) assert.equal((await r.handler(new Request("http://x/"), { params: { id: DANA } })).status, 401);
});

test("no directory means no artifacts, not an error", async () => {
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir: join(tmpdir(), "nope-artifacts-missing") }, identify: as("user_dana") });
  const body = await (await call(route(routes, "/eve/v1/kyb/artifacts"), "/eve/v1/kyb/artifacts")).json();
  assert.deepEqual(body, { ok: true, artifacts: [] });
});
