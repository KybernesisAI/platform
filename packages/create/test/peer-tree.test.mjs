import assert from "node:assert/strict";
import { test } from "node:test";

import { assessPeerTree, staleRangeWarning } from "../dist/peer-tree.js";

// The shape npm actually prints, taken from kyber.exe.xyz on 2026-09-08, where
// this aborted an upgrade. The `invalid` string names the requiring package,
// and npm repeats it under every subtree, including packages of ours that are
// perfectly happy with the installed version.
const thirdPartyOnly = JSON.stringify({
  name: "kyber",
  version: "0.0.0",
  problems: ["invalid: eve@0.49.0 /home/exedev/kyber/node_modules/eve"],
  dependencies: {
    "@github-tools/eve-extension": {
      version: "0.7.0",
      dependencies: {
        "@github-tools/sdk": {
          version: "1.16.0",
          dependencies: {
            eve: {
              version: "0.49.0",
              invalid: '">=0.44.0 <0.48.0" from node_modules/@github-tools/eve-extension, ">=0.44.0 <0.48.0" from node_modules/@github-tools/sdk',
            },
          },
        },
        eve: { version: "0.49.0", invalid: '">=0.44.0 <0.48.0" from node_modules/@github-tools/eve-extension' },
      },
    },
    "@kybernesis/arcana": {
      version: "0.4.1",
      dependencies: {
        eve: { version: "0.49.0", invalid: '">=0.44.0 <0.48.0" from node_modules/@github-tools/eve-extension' },
      },
    },
  },
});

test("a third-party range that trails the framework warns and lets the upgrade run", () => {
  const verdict = assessPeerTree(thirdPartyOnly);
  assert.equal(verdict.ok, false, "there is a real objection, so this is not a clean tree");
  assert.equal(verdict.fatal, false, "but nothing of ours objects, so it must not stop the upgrade");
  assert.deepEqual(verdict.offenders, ["@github-tools/eve-extension", "@github-tools/sdk"]);
});

test("an objection from one of our own packages still stops everything", () => {
  const ours = JSON.stringify({
    name: "kyber",
    dependencies: {
      "@kybernesis/buzz": {
        version: "0.9.6",
        dependencies: {
          eve: { version: "0.52.2", invalid: '">=0.49.0 <0.50.0" from node_modules/@kybernesis/buzz' },
        },
      },
    },
  });
  const verdict = assessPeerTree(ours);
  assert.equal(verdict.fatal, true);
  assert.deepEqual(verdict.offenders, ["@kybernesis/buzz"]);
});

test("a mixed tree is fatal, because ours is among the objectors", () => {
  const mixed = JSON.stringify({
    name: "kyber",
    dependencies: {
      a: { dependencies: { eve: { invalid: '">=0.44.0 <0.48.0" from node_modules/@github-tools/sdk' } } },
      b: { dependencies: { eve: { invalid: '">=0.49.0 <0.50.0" from node_modules/@kybernesis/exe' } } },
    },
  });
  const verdict = assessPeerTree(mixed);
  assert.equal(verdict.fatal, true);
  assert.deepEqual(verdict.offenders, ["@github-tools/sdk", "@kybernesis/exe"]);
});

test("an objection nobody signed is fatal rather than waved through", () => {
  const anonymous = JSON.stringify({
    name: "kyber",
    dependencies: { eve: { version: "0.49.0", invalid: "^0.38.0 from the root project" } },
  });
  const verdict = assessPeerTree(anonymous);
  assert.equal(verdict.fatal, true, "not knowing who objects is the case the gate exists for");
});

test("a clean tree passes, and unreadable output does not", () => {
  const clean = JSON.stringify({
    name: "kyber",
    dependencies: { "@kybernesis/buzz": { version: "0.9.6", dependencies: { eve: { version: "0.49.0" } } } },
  });
  assert.deepEqual(assessPeerTree(clean), { ok: true, offenders: [], fatal: false });
  assert.equal(assessPeerTree("").fatal, true, "npm printing nothing is not a pass");
  assert.equal(assessPeerTree("not json at all").fatal, true);
});

test("the warning names the packages and says why the upgrade continued", () => {
  const message = staleRangeWarning(["@github-tools/eve-extension"], "eve");
  assert.match(message, /@github-tools\/eve-extension/);
  assert.match(message, /Every Kybernesis package agrees/);
  assert.match(message, /upgrade continues/);
  assert.match(staleRangeWarning(["a", "b"], "eve"), /declare a eve range/, "reads correctly in the plural");
});
