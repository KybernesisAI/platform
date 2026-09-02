import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/claude-subscription.sh", import.meta.url));

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fixture({ credentialState = "present", readyState = "503", running = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kyb-claude-subscription-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  mkdirSync(bin);

  executable(join(bin, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_CALLS"
printf '%s' "$FAKE_READY_STATE"
`);
  executable(join(bin, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  ps)
    [ "$FAKE_RUNNING" = 1 ] && echo fake-container-id
    exit 0
    ;;
  volume)
    [ "$2" = inspect ] || exit 98
    [ "$FAKE_CREDENTIAL_STATE" = indeterminate ] && exit 1
    echo /fake/claude-subscription-volume
    ;;
  port)
    echo '127.0.0.1:3333'
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 98
    ;;
esac
`);
  executable(join(bin, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$FAKE_CALLS"
[ "$1" = -n ] || exit 98
shift
case "$1" in
  test)
    [ "$FAKE_CREDENTIAL_STATE" = present ]
    ;;
  true)
    [ "$FAKE_CREDENTIAL_STATE" = absent ]
    ;;
  *)
    echo "unexpected sudo command: $*" >&2
    exit 98
    ;;
esac
`);

  return {
    env: {
      ...process.env,
      AGENT_NAME: "test-agent",
      FAKE_CALLS: calls,
      FAKE_CREDENTIAL_STATE: credentialState,
      FAKE_READY_STATE: readyState,
      FAKE_RUNNING: running ? "1" : "0",
      PATH: `${bin}:${process.env.PATH}`,
    },
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runStatus(env) {
  return spawnSync("bash", [script, "status"], { encoding: "utf8", env });
}

for (const scenario of [
  {
    name: "reports a credential that exists but has not been loaded",
    credentialState: "present",
    diagnostic: /signed in, but this process has not loaded it \(\/ready → 503\)\. Run 'reload'\./,
  },
  {
    name: "reports a missing credential instead of exiting under set -e",
    credentialState: "absent",
    diagnostic: /running but NOT signed in \(\/ready → 503\)\. Run 'login'\./,
  },
  {
    name: "reports an indeterminate credential inspection instead of exiting under set -e",
    credentialState: "indeterminate",
    diagnostic: /not ready \(\/ready → 503\)\. Run 'reload' first; if that does not fix it, 'login'\./,
  },
]) {
  test(scenario.name, () => {
    const f = fixture({ credentialState: scenario.credentialState });
    try {
      const result = runStatus(f.env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, scenario.diagnostic);
      assert.match(result.stdout, /✓ loopback only/);
      assert.ok(f.calls().includes("docker port test-agent-claude-subscription 3000"));
    } finally {
      f.cleanup();
    }
  });
}

test("a ready proxy keeps the healthy status path and skips credential inspection", () => {
  const f = fixture({ credentialState: "indeterminate", readyState: "200" });
  try {
    const result = runStatus(f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /✓ test-agent-claude-subscription: signed in, answering on 127\.0\.0\.1:3333/);
    assert.match(result.stdout, /✓ loopback only/);
    assert.equal(f.calls().some((call) => call.startsWith("docker volume inspect") || call.startsWith("sudo ")), false);
  } finally {
    f.cleanup();
  }
});

test("a stopped proxy retains its nonzero status", () => {
  const f = fixture({ running: false });
  try {
    const result = runStatus(f.env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /test-agent-claude-subscription is not running/);
    assert.equal(f.calls().some((call) => call.startsWith("docker port")), false);
  } finally {
    f.cleanup();
  }
});
