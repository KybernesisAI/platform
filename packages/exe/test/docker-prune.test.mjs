import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/docker-prune.sh", import.meta.url));

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

test("the real prune script protects sessions and retains safe reclamation", () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-docker-prune-"));
  const log = join(dir, "docker.log");
  try {
    executable(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    printf '%s\\n' stopped-session-label stopped-session-name generic-stopped inspect-fails
    ;;
  inspect)
    format=$3
    container=$4
    [ "$container" = inspect-fails ] && exit 1
    case "$format" in
      *eve.sandbox.role*)
        [ "$container" = stopped-session-label ] && echo session || echo '<no value>'
        ;;
      *Name*)
        case "$container" in
          stopped-session-label) echo /ordinary-looking-name ;;
          stopped-session-name) echo /eve-sbx-ses-live-123 ;;
          generic-stopped) echo /old-generic-container ;;
        esac
        ;;
    esac
    ;;
  images)
    case "$*" in
      *'{{.CreatedAt}}\\t{{.ID}}'*)
        printf '2026-08-20 00:00:00 +0000 UTC\\told-template\\n'
        printf '2026-09-01 00:00:00 +0000 UTC\\tcurrent-template\\n'
        ;;
      *) printf '2026-09-01 00:00:00 +0000 UTC\\n' ;;
    esac
    ;;
  rm|rmi|builder|image) exit 0 ;;
esac
`);
    executable(join(dir, "date"), `#!/bin/sh
case "$*" in
  '-u +%FT%TZ') echo '2026-09-01T20:00:00Z' ;;
  *'2026-09-01 00:00:00'*'+%s'*) echo 1788220800 ;;
  *'2026-08-20 00:00:00'*'+%s'*) echo 1787184000 ;;
  *'48 hours ago'*'+%s'*) echo 1788048000 ;;
  *) /bin/date "$@" ;;
esac
`);
    executable(join(dir, "df"), `#!/bin/sh
printf 'overlay 100G 20G 80G 20%% /\\n'
`);

    const output = execFileSync("sh", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: log,
        KYB_PRUNE_SESSION_HOURS: "0",
        PATH: `${dir}:${process.env.PATH}`,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");

    assert.equal(calls.some((call) => call.startsWith("container prune")), false);
    assert.equal(calls.some((call) => /rm .*stopped-session-label/.test(call)), false);
    assert.equal(calls.some((call) => /rm .*stopped-session-name/.test(call)), false);
    assert.equal(calls.some((call) => /rm .*inspect-fails/.test(call)), false);
    assert.ok(calls.includes("rm generic-stopped"));
    assert.equal(calls.some((call) => call.startsWith("rm -f")), false);
    assert.ok(calls.includes("builder prune -af"));
    assert.ok(calls.includes("rmi old-template"));
    assert.equal(calls.includes("rmi current-template"), false);
    assert.ok(calls.includes("image prune -f"));

    assert.match(output, /protecting durable session container ordinary-looking-name/);
    assert.match(output, /protecting durable session container eve-sbx-ses-live-123/);
    assert.match(output, /skipping container inspect-fails: inspect failed/);
    assert.match(output, /removed stopped container old-generic-container/);
    assert.match(output, /removed superseded sandbox template old-template/);
    assert.match(output, /=== done ===/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the script documents durable-session safety and does not consult a session cutoff", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /Age and Docker state do not establish terminality/);
  assert.match(source, /never touches Docker volumes/);
  assert.doesNotMatch(source, /KYB_PRUNE_SESSION_HOURS/);
  assert.doesNotMatch(source, /docker container prune/);
  assert.doesNotMatch(source, /docker rm -f/);
});
