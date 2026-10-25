import { test } from "node:test";
import assert from "node:assert/strict";
import { buzzBridgeUnit, buzzBridgeUnitName, buzzKeyPath, BUZZ_EXTENSION_MOUNT } from "../dist/buzz.js";

test("the bridge unit runs from the agent directory with its .env.local", () => {
  const unit = buzzBridgeUnit({ agent: "planner", user: "exedev", appDir: "/home/exedev/planner" });
  assert.match(unit, /^# Managed by @kybernesis\/create \(kyb add buzz\)/);
  assert.match(unit, /WorkingDirectory=\/home\/exedev\/planner\n/);
  assert.match(unit, /User=exedev\n/);
  assert.match(unit, /set -a && \. \.\/\.env\.local && set \+a && exec npx kybernesis-buzz run/);
  assert.match(unit, /After=network-online\.target planner-agent\.service/);
  assert.match(unit, /StandardOutput=append:\/home\/exedev\/planner\/buzz-bridge\.log/);
});

test("names and paths match what the rest of the toolchain expects", () => {
  assert.equal(buzzBridgeUnitName("planner"), "planner-buzz-bridge");
  assert.equal(buzzKeyPath("/home/exedev/planner"), "/home/exedev/planner/.buzz/agent-key.json");
  assert.match(BUZZ_EXTENSION_MOUNT, /export \{ default \} from "@kybernesis\/buzz\/extension";/);
});

test("the bridge units serving an agent are found by folder, whatever they are called", async () => {
  const { buzzBridgeUnitsFor } = await import("../dist/systemd.js");
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const systemd = mk(j(td(), "kyb-systemd-"));
  const unit = (dir) => `[Service]\nWorkingDirectory=${dir}\nExecStart=/bin/bash -lc 'exec npx kybernesis-buzz run'\n`;
  wf(j(systemd, "kyber-buzz-bridge.service"), unit("/home/exedev/kyber"));
  wf(j(systemd, "Kyber-buzz-bridge.service"), unit("/home/exedev/kyber/"));
  wf(j(systemd, "ava-buzz-bridge.service"), unit("/home/exedev/ava"));
  wf(j(systemd, "kyber-agent.service"), unit("/home/exedev/kyber"));
  assert.deepEqual(buzzBridgeUnitsFor("/home/exedev/kyber", systemd), ["Kyber-buzz-bridge", "kyber-buzz-bridge"]);
  assert.deepEqual(buzzBridgeUnitsFor("/home/exedev/ava", systemd), ["ava-buzz-bridge"]);
  assert.deepEqual(buzzBridgeUnitsFor("/home/exedev/sid", systemd), []);
  assert.deepEqual(buzzBridgeUnitsFor("/home/exedev/sid", j(systemd, "missing")), []);
});
