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

function fixture({
  credentialState = "present",
  readyState = "503",
  // A loaded credential is not a valid one: /ready answers 200 over a blanked
  // sign-in while the API 401s, so the two are separate knobs on purpose.
  authState = "200",
  // Whole days until refreshTokenExpiresAt, or null when it cannot be read.
  refreshDays = null,
  running = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "kyb-claude-subscription-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  mkdirSync(bin);

  executable(join(bin, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_CALLS"
case "$*" in
  *v1/models*) printf '%s' "$FAKE_AUTH_STATE" ;;
  *) printf '%s' "$FAKE_READY_STATE" ;;
esac
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
  python3)
    # refresh_days_left(). Empty means "could not read it" — which must stay
    # silent rather than nag, since root is not always available on a host.
    [ -n "$FAKE_REFRESH_DAYS" ] || exit 1
    printf '%s\\n' "$FAKE_REFRESH_DAYS"
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
      FAKE_AUTH_STATE: authState,
      FAKE_REFRESH_DAYS: refreshDays === null ? "" : String(refreshDays),
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

test("a ready proxy that still authenticates reports healthy", () => {
  const f = fixture({ credentialState: "indeterminate", readyState: "200", authState: "200" });
  try {
    const result = runStatus(f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /✓ test-agent-claude-subscription: signed in and authenticating, answering on 127\.0\.0\.1:3333/);
    assert.match(result.stdout, /✓ loopback only/);
  } finally {
    f.cleanup();
  }
});

// The failure this whole check exists for. On Sid the refresh token reached its
// own expiry, the proxy wrote the credential back as empty strings, and /ready
// went on answering 200 — so status read "signed in, answering" through an
// outage where every turn 401'd. Ready is not authenticated.
test("a ready proxy whose credential has died is reported as dead, not healthy", () => {
  const f = fixture({ credentialState: "present", readyState: "200", authState: "401" });
  try {
    const result = runStatus(f.env);
    assert.match(result.stdout, /✗ test-agent-claude-subscription: credential is DEAD/);
    assert.match(result.stdout, /\/v1\/models → 401/);
    assert.match(result.stdout, /Run 'login'/);
    assert.doesNotMatch(result.stdout, /signed in and authenticating/);
  } finally {
    f.cleanup();
  }
});

test("status warns before the sign-in expires, and escalates as it closes in", () => {
  for (const [days, pattern] of [
    [27, /✓ sign-in valid for 27d/],
    [6, /! sign-in expires in 6d/],
    [2, /✗ sign-in expires in 2d/],
    [-4, /✗ sign-in EXPIRED 4d ago/],
  ]) {
    const f = fixture({ readyState: "200", authState: "200", refreshDays: days });
    try {
      assert.match(runStatus(f.env).stdout, pattern);
    } finally {
      f.cleanup();
    }
  }
});

// Root is not always available, and a missing number is not a reason to nag.
test("status says nothing about expiry when the volume cannot be read", () => {
  const f = fixture({ readyState: "200", authState: "200", refreshDays: null });
  try {
    assert.doesNotMatch(runStatus(f.env).stdout, /sign-in (valid|expires|EXPIRED)/);
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
