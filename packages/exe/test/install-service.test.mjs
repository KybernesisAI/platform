import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/install-service.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kyb-install-service-"));
  const app = join(root, "sample-agent");
  const bin = join(root, "bin");
  mkdirSync(app);
  mkdirSync(bin);
  writeFileSync(join(app, "package.json"), "{}\n");
  writeFileSync(join(app, ".env.local"), "SECRET=test\n");
  for (const command of ["sudo", "systemctl"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!/bin/sh\necho '${command} must not run' >&2\nexit 97\n`);
    chmodSync(path, 0o755);
  }
  return {
    root,
    app,
    env: {
      ...process.env,
      EVE_APP_DIR: app,
      AGENT_NAME: "test-agent",
      PORT: "8123",
      PATH: `${bin}:${process.env.PATH}`,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(args, env) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env });
}

test("--unit-path reports the canonical target without mutating the host", () => {
  const f = fixture();
  try {
    const result = run(["--unit-path"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "/etc/systemd/system/test-agent-agent.service\n");
    assert.equal(result.stderr, "");
  } finally {
    f.cleanup();
  }
});

test("--print-unit renders deterministic bytes from the agent environment", () => {
  const f = fixture();
  try {
    const first = run(["--print-unit"], f.env);
    const second = run(["--print-unit"], f.env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /Description=test-agent eve agent/);
    assert.match(first.stdout, new RegExp(`WorkingDirectory=${f.app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(first.stdout, /Environment=PORT=8123/);
    assert.ok(first.stdout.includes(`User=${userInfo().username}\n`));
    assert.equal(first.stderr, "");
  } finally {
    f.cleanup();
  }
});

test("unknown options fail without invoking privileged commands", () => {
  const f = fixture();
  try {
    const result = run(["--surprise"], f.env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option: --surprise/);
    assert.doesNotMatch(result.stderr, /must not run/);
  } finally {
    f.cleanup();
  }
});


test("--refresh-unit reloads systemd without enabling or restarting", () => {
  const f = fixture();
  try {
    const calls = join(f.root, "sudo-calls");
    const sudo = join(f.root, "bin", "sudo");
    writeFileSync(sudo, `#!/bin/sh\nprintf '%s\n' "$*" >>${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(sudo, 0o755);
    const result = run(["--refresh-unit"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const recorded = readFileSync(calls, "utf8");
    assert.match(recorded, /install -m 0644/);
    assert.match(recorded, /systemctl daemon-reload/);
    assert.doesNotMatch(recorded, /enable|restart/);
    assert.match(result.stdout, /service not restarted/);
  } finally {
    f.cleanup();
  }
});

test("the default command still installs, enables, and restarts the service", () => {
  const f = fixture();
  try {
    const calls = join(f.root, "sudo-calls");
    const sudo = join(f.root, "bin", "sudo");
    writeFileSync(sudo, `#!/bin/sh\nprintf '%s\n' "$*" >>${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(sudo, 0o755);
    const result = run([], f.env);
    assert.equal(result.status, 0, result.stderr);
    const recorded = readFileSync(calls, "utf8");
    assert.match(recorded, /install -m 0644/);
    assert.match(recorded, /systemctl daemon-reload/);
    assert.match(recorded, /systemctl enable test-agent-agent/);
    assert.match(recorded, /systemctl restart test-agent-agent/);
    assert.match(result.stdout, /installed and started/);
  } finally {
    f.cleanup();
  }
});
