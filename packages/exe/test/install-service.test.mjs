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

/**
 * AC5 of the refresh design: an upgrade rewrites the unit and reloads systemd,
 * and does NOT enable or restart the service — the running agent is not
 * interrupted by a package bump. Recording stubs stand in for sudo and
 * systemctl so the sequence of privileged calls is the thing asserted.
 */
function recordingFixture() {
  const f = fixture();
  const calls = join(f.root, "calls.log");
  const sudo = join(f.root, "bin", "sudo");
  writeFileSync(
    sudo,
    `#!/bin/sh\n[ "$1" = "-n" ] && shift\necho "$*" >> '${calls}'\nexit 0\n`,
  );
  chmodSync(sudo, 0o755);
  return { ...f, calls: () => (readFileSync(calls, "utf8").trim().split("\n")) };
}

test("--refresh-unit installs the unit and reloads systemd, and neither enables nor restarts", () => {
  const f = recordingFixture();
  try {
    const result = run(["--refresh-unit"], { ...f.env, KYB_NONINTERACTIVE: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unit refreshed \(service not restarted/);
    const calls = f.calls();
    assert.match(calls[0], /^install -m 0644 \S+ \/etc\/systemd\/system\/test-agent-agent\.service$/);
    assert.equal(calls[1], "systemctl daemon-reload");
    assert.equal(calls.length, 2);
    assert.equal(calls.some((c) => /enable|restart/.test(c)), false);
  } finally {
    f.cleanup();
  }
});

test("every generated unit opens with the managed marker, and the marker is printable on its own", () => {
  const f = fixture();
  try {
    const marker = run(["--managed-marker"], f.env);
    const unit = run(["--print-unit"], f.env);
    assert.equal(marker.status, 0, marker.stderr);
    assert.match(marker.stdout, /^# Managed by @kybernesis\/exe install-service\.sh/);
    assert.ok(unit.stdout.startsWith(marker.stdout), "the unit's first line is the marker");
  } finally {
    f.cleanup();
  }
});

test("the unit builds before it starts, and gives the build time to prewarm", () => {
  const f = fixture();
  try {
    const unit = run(["--print-unit"], f.env).stdout;
    const pre = unit.indexOf("ExecStartPre=/bin/bash -lc 'set -a && . ./.env.local && set +a && npx eve build'");
    const start = unit.indexOf("ExecStart=/bin/bash -lc 'set -a && . ./.env.local && set +a && exec npx eve start");
    assert.ok(pre > 0 && start > pre, "ExecStartPre precedes ExecStart");
    assert.match(unit, /^TimeoutStartSec=900$/m);
    assert.match(unit, /^Restart=always$/m);
  } finally {
    f.cleanup();
  }
});
