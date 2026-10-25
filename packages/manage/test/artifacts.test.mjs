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

test("a refused caller gets the refusal, on every route but an open share link", async () => {
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir: seed() }, identify: async () => new Response("no", { status: 401 }) });
  const signedIn = routes.filter((r) => !(r.method === "GET" && r.path.startsWith("/eve/v1/kyb/artifact-shares/")));
  assert.equal(signedIn.length, routes.length - 1);
  for (const r of signedIn) assert.equal((await r.handler(new Request("http://x/"), { params: { id: DANA, token: "f".repeat(32) } })).status, 401);
});

test("no directory means no artifacts, not an error", async () => {
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir: join(tmpdir(), "nope-artifacts-missing") }, identify: as("user_dana") });
  const body = await (await call(route(routes, "/eve/v1/kyb/artifacts"), "/eve/v1/kyb/artifacts")).json();
  assert.deepEqual(body, { ok: true, artifacts: [] });
});

const post = (r, body, params) =>
  r.handler(new Request("http://x/", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), { params });

test("the owner shares a version by link; the link opens without sign-in, sandboxed", async () => {
  const dir = seed();
  const sharesDir = mkdtempSync(join(tmpdir(), "shares-"));
  const options = { dir, sharesDir, publicUrl: "https://agent.example/" };
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options, identify: as("user_dana") });
  const share = route(routes, "/eve/v1/kyb/artifacts/:id/share");

  const made = await (await post(share, { version: 1 }, { id: DANA })).json();
  assert.equal(made.ok, true);
  assert.equal(made.version, 1);
  assert.match(made.url, /^https:\/\/agent\.example\/eve\/v1\/kyb\/artifact-shares\/[0-9a-f]{32}$/);
  // The same version again is the same link.
  assert.equal((await (await post(share, { version: 1 }, { id: DANA })).json()).url, made.url);
  // Latest by default.
  assert.equal((await (await post(share, undefined, { id: DANA })).json()).version, 2);

  // Anyone holding the link, no identity at all.
  const open = route(artifactRoutes({ prefix: "/eve/v1/kyb", options, identify: async () => new Response("no", { status: 401 }) }), "/eve/v1/kyb/artifact-shares/:token");
  const page = await call(open, "/", { token: made.token });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<p>a v1</p>");
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy"), /^sandbox allow-scripts;/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /allow-same-origin/);
  assert.equal((await call(open, "/", { token: "f".repeat(32) })).status, 404);
  assert.equal((await call(open, "/", { token: "../x" })).status, 404);
  // A link texted over iMessage can arrive with the next word glued on.
  assert.equal((await call(open, "/", { token: `${made.token}I` })).status, 200);
  assert.equal((await call(open, "/", { token: `${made.token.toUpperCase()}` })).status, 200);
  assert.equal((await call(open, "/", { token: made.token.slice(0, 31) })).status, 404);
});

test("only the owner can share, and only the person who shared can withdraw", async () => {
  const dir = seed();
  const sharesDir = mkdtempSync(join(tmpdir(), "shares-"));
  const options = { dir, sharesDir, publicUrl: "https://agent.example" };
  const other = artifactRoutes({ prefix: "/eve/v1/kyb", options, identify: as("user_other") });
  assert.equal((await post(route(other, "/eve/v1/kyb/artifacts/:id/share"), {}, { id: DANA })).status, 404);

  const dana = artifactRoutes({ prefix: "/eve/v1/kyb", options, identify: as("user_dana") });
  const made = await (await post(route(dana, "/eve/v1/kyb/artifacts/:id/share"), {}, { id: DANA })).json();
  const withdraw = (routes) => routes.find((r) => r.path === "/eve/v1/kyb/artifact-shares/:token" && r.method === "DELETE");
  assert.equal((await withdraw(other).handler(new Request("http://x/", { method: "DELETE" }), { params: { token: made.token } })).status, 404);

  const listed = await (await call(route(dana, "/eve/v1/kyb/artifacts/:id/shares"), "/", { id: DANA })).json();
  assert.deepEqual(listed.shares.map((s) => s.token), [made.token]);

  assert.equal((await withdraw(dana).handler(new Request("http://x/", { method: "DELETE" }), { params: { token: made.token } })).status, 200);
  const open = dana.find((r) => r.path === "/eve/v1/kyb/artifact-shares/:token" && r.method === "GET");
  assert.equal((await call(open, "/", { token: made.token })).status, 404);
});

test("a markdown artifact is shared as a readable page, its text escaped", async () => {
  const dir = seed();
  writeFileSync(join(dir, ROUTINE, "v1.md"), "# Notes\n<script>alert(1)</script>");
  const sharesDir = mkdtempSync(join(tmpdir(), "shares-"));
  const options = { dir, sharesDir, publicUrl: "https://agent.example" };
  const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options, identify: as("user_owner", "manage") });
  const made = await (await post(route(routes, "/eve/v1/kyb/artifacts/:id/share"), {}, { id: ROUTINE })).json();
  const open = routes.find((r) => r.path === "/eve/v1/kyb/artifact-shares/:token" && r.method === "GET");
  const html = await (await call(open, "/", { token: made.token })).text();
  assert.match(html, /# Notes/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("without a public address there is no link to make", async () => {
  const dir = seed();
  const saved = { EVE_PUBLIC_URL: process.env.EVE_PUBLIC_URL, EXE_VM_NAME: process.env.EXE_VM_NAME };
  delete process.env.EVE_PUBLIC_URL;
  delete process.env.EXE_VM_NAME;
  try {
    const routes = artifactRoutes({ prefix: "/eve/v1/kyb", options: { dir, sharesDir: mkdtempSync(join(tmpdir(), "shares-")) }, identify: as("user_dana") });
    assert.equal((await post(route(routes, "/eve/v1/kyb/artifacts/:id/share"), {}, { id: DANA })).status, 409);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});
