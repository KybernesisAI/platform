import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { STUDIO_CORE, ignoreMagicState, magicSurfacesLinqTs, missingStudioCore, planStudioCore, wireMagicLinq } from "../dist/studio-core.js";

test("cards, artifacts and magic are core on every agent with manage, and only there", () => {
  assert.deepEqual(STUDIO_CORE.map((c) => c.item), ["cards", "artifacts", "magic"]);
  assert.deepEqual(missingStudioCore({ "@kybernesis/enterprise": "^0.10.0" }), []);
  assert.deepEqual(missingStudioCore({ "@kybernesis/manage": "^0.25.0" }).map((c) => c.item), ["cards", "artifacts", "magic"]);
  assert.deepEqual(
    missingStudioCore({ "@kybernesis/manage": "^0.25.0", "@kybernesis/cards": "^0.1.0", "@kybernesis/magic": "^0.1.0" }).map((c) => c.item),
    ["artifacts"],
  );
});

test("--check lists each missing one at the build that would install, and drops one with no build", () => {
  const deps = { "@kybernesis/manage": "^0.25.0", "@kybernesis/cards": "^0.1.0" };
  const plan = planStudioCore(deps, (pkg) => (pkg === "@kybernesis/artifacts" ? "0.1.0" : undefined));
  assert.deepEqual(plan, [{ name: "@kybernesis/artifacts", from: "none", to: "0.1.0" }]);
  assert.deepEqual(planStudioCore({ "@kybernesis/enterprise": "^0.10.0" }, () => "9.9.9"), []);
});

test("magic delivers into Linq threads only on an agent with a Linq channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-studio-core-"));
  try {
    mkdirSync(join(dir, "agent/lib"), { recursive: true });
    mkdirSync(join(dir, "agent/channels"), { recursive: true });
    writeFileSync(join(dir, "agent/lib/magic-surfaces.ts"), "registry default\n");
    assert.equal(wireMagicLinq(dir), false);
    assert.equal(readFileSync(join(dir, "agent/lib/magic-surfaces.ts"), "utf8"), "registry default\n");
    writeFileSync(join(dir, "agent/channels/linq.ts"), "export default {};\n");
    assert.equal(wireMagicLinq(dir), true);
    const wired = readFileSync(join(dir, "agent/lib/magic-surfaces.ts"), "utf8");
    assert.equal(wired, magicSurfacesLinqTs());
    assert.match(wired, /import linq from "\.\.\/channels\/linq\.js"/);
    assert.match(wired, /startsWith\("linq:"\)/);
    assert.match(wired, /to\(kyb, \{ routine: "magic" \}\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("magic's per-person state is ignored by git once", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-studio-core-"));
  try {
    assert.equal(ignoreMagicState(dir), true);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".kyb\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env.local");
    assert.equal(ignoreMagicState(dir), true);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n.env.local\n.kyb\n");
    assert.equal(ignoreMagicState(dir), false);
    writeFileSync(join(dir, ".gitignore"), ".kyb/\n");
    assert.equal(ignoreMagicState(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
