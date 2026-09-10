import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { notifyMountTs } from "../dist/templates.js";
import { needsNotify, repairNotifyMount } from "../dist/upgrade.js";

const registryItem = JSON.parse(readFileSync(new URL("../../../registry/r/notify.json", import.meta.url), "utf8"));

test("a Studio agent without notify needs it; anything else is left alone", () => {
  assert.equal(needsNotify({ "@kybernesis/manage": "^0.8.0" }), true);
  assert.equal(needsNotify({ "@kybernesis/manage": "^0.8.0", "@kybernesis/notify": "0.1.0" }), false);
  assert.equal(needsNotify({ "@kybernesis/enterprise": "^0.2.0" }), false);
});

test("the mount the upgrade writes is the mount the registry installs", () => {
  assert.equal(registryItem.files[0].target, "agent/extensions/notify.ts");
  assert.equal(registryItem.files[0].content, notifyMountTs());
});

test("the mount is written once and an existing file is never touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-notify-"));
  try {
    assert.equal(repairNotifyMount(dir), "mounted");
    assert.equal(readFileSync(join(dir, "agent/extensions/notify.ts"), "utf8"), notifyMountTs());
    assert.equal(repairNotifyMount(dir), "present");
    const custom = mkdtempSync(join(tmpdir(), "kyb-notify-custom-"));
    mkdirSync(join(custom, "agent/extensions"), { recursive: true });
    writeFileSync(join(custom, "agent/extensions/notify.ts"), "// mine\n");
    assert.equal(repairNotifyMount(custom), "present");
    assert.equal(readFileSync(join(custom, "agent/extensions/notify.ts"), "utf8"), "// mine\n");
    rmSync(custom, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
