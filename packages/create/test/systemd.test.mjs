import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LEGACY_RESTART_COMMAND,
  diagnoseManageRestart,
  reconcileManageRestart,
  repairManageRestart,
  systemdRestartCommand,
} from "../dist/systemd.js";

/**
 * Once systemd owns the agent, a Studio install that restarts through
 * scripts/eve-server.sh starts a second supervisor. What is under test is the
 * migration of the scaffolded literal — and only that literal — plus the
 * doctor verdicts around it.
 */

function app(manage) {
  const cwd = mkdtempSync(join(tmpdir(), "kyb-systemd-"));
  mkdirSync(join(cwd, "agent/channels"), { recursive: true });
  if (manage !== undefined) writeFileSync(join(cwd, "agent/channels/kyb.ts"), manage);
  return { cwd, manage: () => readFileSync(join(cwd, "agent/channels/kyb.ts"), "utf8"), cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("the exact scaffolded restart is migrated; anything else is preserved", () => {
  const legacy = app(`export default manage({\n  restartCommand: ${JSON.stringify(LEGACY_RESTART_COMMAND)},\n});\n`);
  const custom = app(`export default manage({ restartCommand: "bash my-own-restart.sh" });\n`);
  const none = app(`export default manage({});\n`);
  const absent = app();
  try {
    assert.equal(reconcileManageRestart(legacy.cwd, "kyber"), "migrated");
    assert.match(legacy.manage(), /restartCommand: "sudo -n systemctl restart kyber-agent",/);
    assert.equal(reconcileManageRestart(legacy.cwd, "kyber"), "systemd");

    assert.equal(reconcileManageRestart(custom.cwd, "kyber"), "custom");
    assert.match(custom.manage(), /my-own-restart\.sh/);
    assert.equal(reconcileManageRestart(none.cwd, "kyber"), "missing");
    assert.equal(reconcileManageRestart(absent.cwd, "kyber"), "absent");
  } finally {
    for (const a of [legacy, custom, none, absent]) a.cleanup();
  }
});

test("doctor: eve-server.sh under systemd fails with the exact line to use; the systemd command passes; custom warns", () => {
  const underSystemd = diagnoseManageRestart("kyber", LEGACY_RESTART_COMMAND);
  assert.equal(underSystemd.verdict, "fail");
  assert.match(underSystemd.detail, /two servers/);
  assert.ok(underSystemd.detail.includes(JSON.stringify(systemdRestartCommand("kyber"))));

  assert.equal(diagnoseManageRestart("kyber", systemdRestartCommand("kyber")).verdict, "pass");
  assert.equal(diagnoseManageRestart("kyber", "bash my-own-restart.sh").verdict, "warn");
  assert.equal(diagnoseManageRestart("kyber", undefined).verdict, "warn");
  // No systemd unit: the old script is still a valid restart.
  assert.equal(diagnoseManageRestart(null, LEGACY_RESTART_COMMAND).verdict, "pass");
});

test("upgrade migrates the restart only when a systemd unit for this checkout exists", () => {
  const a = app(`export default manage({ restartCommand: ${JSON.stringify(LEGACY_RESTART_COMMAND)} });\n`);
  const systemd = mkdtempSync(join(tmpdir(), "kyb-systemd-dir-"));
  try {
    // No unit anywhere: nothing to migrate to.
    assert.equal(repairManageRestart(a.cwd, { "@kybernesis/exe": "0.12.0" }, systemd), null);
    assert.match(a.manage(), /eve-server\.sh/);

    // A unit for a different checkout does not count.
    writeFileSync(join(systemd, "other-agent.service"), `[Service]\nUser=exedev\nWorkingDirectory=/somewhere/else\nEnvironment=PORT=8000\n`);
    assert.equal(repairManageRestart(a.cwd, { "@kybernesis/exe": "0.12.0" }, systemd), null);

    writeFileSync(join(systemd, "kyber-agent.service"), `[Service]\nUser=exedev\nWorkingDirectory=${a.cwd}\nEnvironment=PORT=8000\n`);
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      assert.equal(repairManageRestart(a.cwd, { "@kybernesis/exe": "0.12.0" }, systemd), "migrated");
    } finally {
      console.log = original;
    }
    assert.match(a.manage(), /sudo -n systemctl restart kyber-agent/);
    assert.ok(logs.some((l) => /migrated agent\/channels\/kyb\.ts/.test(l)));
    // Without the exe package the host is not ours to reason about.
    assert.equal(repairManageRestart(a.cwd, {}, systemd), null);
  } finally {
    a.cleanup();
    rmSync(systemd, { recursive: true, force: true });
  }
});

test("a build gate added as a drop-in counts as the unit's own", async () => {
  const { findMatchingAgentServiceUnit } = await import("../dist/systemd.js");
  const a = app("export default manage({});\n");
  const systemd = mkdtempSync(join(tmpdir(), "kyb-systemd-dropin-"));
  try {
    writeFileSync(join(systemd, "kyber-agent.service"), `[Service]\nUser=exedev\nWorkingDirectory=${a.cwd}\nEnvironment=PORT=8000\n`);
    mkdirSync(join(systemd, "kyber-agent.service.d"));
    writeFileSync(join(systemd, "kyber-agent.service.d/build-gate.conf"), "[Service]\nExecStartPre=/bin/bash -lc 'set -a && . ./.env.local && set +a && npx eve build'\n");
    const unit = findMatchingAgentServiceUnit(a.cwd, systemd);
    assert.ok(unit);
    assert.match(unit.contents, /npx eve build/);
    assert.equal(unit.values.name, "kyber");
  } finally {
    a.cleanup();
    rmSync(systemd, { recursive: true, force: true });
  }
});
