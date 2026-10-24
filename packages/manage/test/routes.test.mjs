import { test } from "node:test";
import assert from "node:assert/strict";
import { manageChannel } from "../dist/index.js";

// eve refuses a channel whose routes overlap: same method, same number of
// segments, and every segment equal or a parameter on either side
// (`artifacts/shared/:token` and `artifacts/:id/shares` are one route to it).
// The agent then fails to build, which unit tests of each route never show.
const isParameter = (segment) => segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment);
const split = (path) => path.replace(/^\/+|\/+$/g, "").split("/");
const overlap = (a, b) => {
  if (a.method !== b.method && a.method !== "ALL" && b.method !== "ALL") return false;
  const x = split(a.path);
  const y = split(b.path);
  return x.length === y.length && x.every((s, i) => isParameter(s) || isParameter(y[i]) || s === y[i]);
};

test("no two management routes are the same route to eve", () => {
  const { routes } = manageChannel({});
  assert.ok(routes.some((r) => r.path.includes("/artifact-shares/")), "share routes are mounted");
  const clashes = [];
  routes.forEach((a, i) => {
    for (const b of routes.slice(i + 1)) if (overlap(a, b)) clashes.push(`${a.method} ${a.path} ~ ${b.method} ${b.path}`);
  });
  assert.deepEqual(clashes, []);
});
