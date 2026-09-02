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

/**
 * The real script against a fake daemon. "Now" is 2026-09-01T20:00Z; the
 * session backstop is a week, the build-container cutoff six hours, and the
 * template grace 48 hours.
 */
function runPrune(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-docker-prune-"));
  const log = join(dir, "docker.log");
  executable(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    # id|name|created|status
    printf '%s\\n' \\
      'ses-fresh|eve-sbx-ses-docker-aaaa-wrun_1|2026-09-01 10:00:00 +0000 UTC|Up 10 hours' \\
      'ses-old|eve-sbx-ses-docker-aaaa-wrun_2|2026-08-20 00:00:00 +0000 UTC|Up 12 days' \\
      'ses-stopped-recent|eve-sbx-ses-docker-aaaa-wrun_3|2026-08-30 00:00:00 +0000 UTC|Exited (0) 2 days ago' \\
      'ses-label|ordinary-looking-name|2026-08-31 00:00:00 +0000 UTC|Exited (0) 1 day ago' \\
      'build-live|eve-sbx-tpl-docker-aaaa-bbbb-build-1|2026-09-01 19:30:00 +0000 UTC|Up 30 minutes' \\
      'build-leak|eve-sbx-tpl-docker-aaaa-cccc-build-2|2026-08-18 00:00:00 +0000 UTC|Up 2 weeks' \\
      'generic-stopped|old-generic-container|2026-08-01 00:00:00 +0000 UTC|Exited (0) 4 weeks ago' \\
      'generic-running|claude-subscription|2026-08-01 00:00:00 +0000 UTC|Up 4 weeks' \\
      'inspect-fails|mystery|2026-08-01 00:00:00 +0000 UTC|Exited (0) 4 weeks ago'
    ;;
  inspect)
    container=$4
    [ "$container" = inspect-fails ] && exit 1
    case "$container" in
      ses-label) echo session ;;
      build-live|build-leak) echo template-build ;;
      *) echo '<no value>' ;;
    esac
    ;;
  images)
    case "$*" in
      *'{{.Tag}}'*)
        printf 'eve-sbx-tpl-docker-4c41-aaaa-rt\\t2026-08-20 00:00:00 +0000 UTC\\told-template\\n'
        printf 'eve-sbx-tpl-docker-4c41-bbbb-rt\\t2026-09-01 00:00:00 +0000 UTC\\tcurrent-template\\n'
        ;;
    esac
    ;;
  stop|rm|rmi|builder|image) exit 0 ;;
esac
`);
  executable(join(dir, "date"), `#!/bin/sh
case "$*" in
  '-u +%FT%TZ') echo '2026-09-01T20:00:00Z' ;;
  *'168 hours ago'*'+%Y-%m-%d'*) echo '2026-08-25 20:00:00' ;;
  *'6 hours ago'*'+%Y-%m-%d'*) echo '2026-09-01 14:00:00' ;;
  *'2026-09-01 00:00:00'*'+%s'*) echo 1788220800 ;;
  *'2026-08-20 00:00:00'*'+%s'*) echo 1787184000 ;;
  *'48 hours ago'*'+%s'*) echo 1788048000 ;;
  *'-d @'*) echo 'fmt' ;;
  *) /bin/date "$@" ;;
esac
`);
  executable(join(dir, "df"), `#!/bin/sh
printf 'overlay 100G 20G 80G 20%% /\\n'
`);
  try {
    const output = execFileSync("sh", [script], {
      encoding: "utf8",
      env: { ...process.env, FAKE_DOCKER_LOG: log, PATH: `${dir}:${process.env.PATH}`, ...extraEnv },
    });
    return { output, calls: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("session containers are kept for a week and removed after, template build leaks go, live builds stay", () => {
  const { output, calls } = runPrune();

  // Sessions inside the backstop are kept — stopped or running, by name or by label.
  for (const kept of ["ses-fresh", "ses-stopped-recent", "ses-label"]) {
    assert.equal(calls.some((c) => /^(rm|stop) /.test(c) && c.includes(kept)), false, kept);
  }
  assert.match(output, /keeping session container eve-sbx-ses-docker-aaaa-wrun_1/);
  assert.match(output, /keeping session container ordinary-looking-name/);
  // A session older than the backstop is stopped, then removed without force.
  assert.ok(calls.includes("stop ses-old"));
  assert.ok(calls.includes("rm ses-old"));
  assert.match(output, /removed session container eve-sbx-ses-docker-aaaa-wrun_2 .*older than 168h/);
  // A build container still up two weeks later is a leak; one up for thirty minutes is a build.
  assert.ok(calls.includes("rm -f build-leak"));
  assert.equal(calls.some((c) => /^(rm|stop) /.test(c) && c.includes("build-live")), false);
  // Other containers: stopped ones go, running ones are not this job's business.
  assert.ok(calls.includes("rm generic-stopped"));
  assert.equal(calls.some((c) => /^(rm|stop) .*generic-running/.test(c)), false);
  // Not knowing what a container is protects it.
  assert.equal(calls.some((c) => /^(rm|stop) .*inspect-fails/.test(c)), false);
  assert.match(output, /skipping container mystery: inspect failed/);
  // Nothing blanket: no container prune, and force only for the build leak.
  assert.equal(calls.some((c) => c.startsWith("container prune")), false);
  assert.deepEqual(calls.filter((c) => c.startsWith("rm -f")), ["rm -f build-leak"]);
  // The rest of the job is unchanged.
  assert.ok(calls.includes("builder prune -af"));
  assert.ok(calls.includes("rmi old-template"));
  assert.equal(calls.includes("rmi current-template"), false);
  assert.ok(calls.includes("image prune -f"));
  assert.match(output, /=== done ===/);
});

test("a dry run reports every decision and removes nothing", () => {
  const { output, calls } = runPrune({ KYB_PRUNE_DRY_RUN: "1" });

  assert.equal(calls.some((c) => /^(rm|rmi|stop|builder|image|container) /.test(c)), false, calls.join("; "));
  assert.match(output, /would remove session container eve-sbx-ses-docker-aaaa-wrun_2/);
  assert.match(output, /would remove template build container eve-sbx-tpl-docker-aaaa-cccc-build-2/);
  assert.match(output, /would remove stopped container old-generic-container/);
  assert.match(output, /would remove superseded sandbox template eve-sbx-tpl-docker-4c41-aaaa-rt/);
});

test("the script says what it protects, and the backstop is a week unless told otherwise", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /KYB_PRUNE_SESSION_HOURS:-168/);
  assert.match(source, /never break a live session/i);
  assert.doesNotMatch(source, /docker container prune/);
  assert.doesNotMatch(source, /NEVER TOUCHED: volumes/i === false ? /x^/ : /x^/);
  assert.match(source, /volumes \(a Claude subscription sign-in lives in one\)/);
});
