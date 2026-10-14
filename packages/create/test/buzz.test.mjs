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
