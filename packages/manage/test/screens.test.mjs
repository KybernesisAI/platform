import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { screenRoutes } from "../dist/screens.js";

const DANA = "a".repeat(32);
const OTHER = "b".repeat(32);
const ROUTINE = "c".repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** The layout @kybernesis/computer writes. */
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "screens-"));
  const put = (id, owner) => {
    writeFileSync(join(dir, `${id}.png`), PNG);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, owner, takenAt: "2026-10-24T09:00:00.000Z" }));
  };
  put(DANA, "user_dana");
  put(OTHER, "user_other");
  put(ROUTINE, null);
  return dir;
}

const as = (userId, level = "use") => async () => ({ userId, level });
const get = (routes, id) => routes[0].handler(new Request(`http://x/eve/v1/kyb/screens/${id}`), { params: { id } });

test("a screenshot is served to the person it was taken for, as a private png", async () => {
  const routes = screenRoutes({ prefix: "/eve/v1/kyb", options: { dir: seed() }, identify: as("user_dana") });
  assert.equal(routes[0].path, "/eve/v1/kyb/screens/:id");
  for (const id of [DANA, `${DANA}.png`]) {
    const res = await get(routes, id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  }
});

test("anyone else's, a missing one, or a crafted id is a 404", async () => {
  const dir = seed();
  const dana = screenRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_dana") });
  for (const id of [OTHER, ROUTINE, "f".repeat(32), "../etc/passwd", `${DANA}.json`]) {
    assert.equal((await get(dana, id)).status, 404, id);
  }
  const manager = screenRoutes({ prefix: "/eve/v1/kyb", options: { dir }, identify: as("user_owner", "manage") });
  assert.equal((await get(manager, ROUTINE)).status, 200);
  assert.equal((await get(manager, DANA)).status, 404);
});

test("an unidentified caller gets the identify answer", async () => {
  const deny = async () => Response.json({ ok: false }, { status: 401 });
  const routes = screenRoutes({ prefix: "/eve/v1/kyb", options: { dir: seed() }, identify: deny });
  assert.equal((await get(routes, DANA)).status, 401);
});
