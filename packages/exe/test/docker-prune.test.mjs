import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/docker-prune.sh", import.meta.url));
const serverScript = fileURLToPath(new URL("../scripts/eve-server.sh", import.meta.url));

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeRun(app, id, value) {
  const dir = join(app, ".eve/.workflow-data/runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), typeof value === "string" ? value : JSON.stringify(value));
}

function marker(app, name, reference) {
  const dir = join(app, ".eve/sandbox-cache/docker/templates");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${reference}\n`);
  return path;
}

function runPrune({ dryRun = false, noAppEnv = false, unavailableRuns = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-docker-prune-"));
  const app1 = join(dir, "app-one");
  const app2 = join(dir, "app-two");
  const bin = join(dir, "bin");
  const log = join(dir, "docker.log");
  mkdirSync(bin);
  mkdirSync(join(app1, ".eve/.workflow-data/runs"), { recursive: true });
  mkdirSync(join(app2, ".eve/.workflow-data/runs"), { recursive: true });
  writeRun(app1, "wrun_terminal", { status: "completed" });
  writeRun(app2, "wrun_running_2h", { status: "running" });
  writeRun(app2, "wrun_running_30h", { status: "running" });
  writeRun(app1, "wrun_malformed", "not json");

  const oldMarker = marker(app1, "old", "eve-sandbox-template:eve-sbx-tpl-docker-4c41-old-rt");
  const failedMarker = marker(app1, "failed", "eve-sandbox-template:eve-sbx-tpl-docker-4c41-failed-rt");
  const keptMarker = marker(app1, "kept", "eve-sandbox-template:eve-sbx-tpl-docker-4c41-current-rt");

  executable(join(bin, "fake-docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    if [ "\${FAKE_SCENARIO:-}" = no-app ]; then
      printf '%s\\n' 'young|eve-sbx-ses-docker-aaaa-wrun_unknown|2026-09-01 19:00:00 +0000 UTC|Exited (0) 1 hour ago'
    elif [ "\${FAKE_SCENARIO:-}" = unavailable ]; then
      printf '%s\\n' 'unsafe-missing|eve-sbx-ses-docker-aaaa-wrun_missing|2026-09-01 19:00:00 +0000 UTC|Exited (0) 1 hour ago'
    else
      printf '%s\\n' \\
        'terminal|eve-sbx-ses-docker-aaaa-wrun_terminal|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'missing|eve-sbx-ses-docker-aaaa-wrun_missing|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'running-2h|eve-sbx-ses-docker-aaaa-wrun_running_2h|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'running-30h|eve-sbx-ses-docker-aaaa-wrun_running_30h|2026-08-31 14:00:00 +0000 UTC|Exited (0) 30 hours ago' \\
        'malformed|eve-sbx-ses-docker-aaaa-wrun_malformed|2026-08-31 14:00:00 +0000 UTC|Exited (0) 30 hours ago' \\
        'running-current|eve-sbx-ses-docker-aaaa-wrun_current|2026-08-31 00:00:00 +0000 UTC|Up 1 day' \\
        'running-old|eve-sbx-ses-docker-aaaa-wrun_old|2026-08-20 00:00:00 +0000 UTC|Up 12 days' \\
        'build-live|eve-sbx-tpl-docker-aaaa-live-build|2026-09-01 19:30:00 +0000 UTC|Up 30 minutes' \\
        'build-leak|eve-sbx-tpl-docker-aaaa-old-build|2026-08-18 00:00:00 +0000 UTC|Up 2 weeks'
    fi
    ;;
  inspect)
    container=$4
    case "$3" in
      *State.FinishedAt*)
        case "$container" in
          terminal|missing|running-2h|young|unsafe-missing) echo '2026-09-01T18:00:00Z' ;;
          running-30h|malformed) echo '2026-08-31T14:00:00Z' ;;
          *) exit 1 ;;
        esac
        ;;
      *)
        case "$container" in build-live|build-leak) echo template-build ;; *) echo '<no value>' ;; esac
        ;;
    esac
    ;;
  images)
    [ "\${FAKE_SCENARIO:-}" = no-app ] && exit 0
    printf 'eve-sbx-tpl-docker-4c41-old-rt\\t2026-08-20 00:00:00 +0000 UTC\\told-template\\n'
    printf 'eve-sbx-tpl-docker-4c41-failed-rt\\t2026-08-21 00:00:00 +0000 UTC\\tfailed-template\\n'
    printf 'eve-sbx-tpl-docker-4c41-current-rt\\t2026-09-01 00:00:00 +0000 UTC\\tcurrent-template\\n'
    ;;
  rmi) [ "$2" = failed-template ] && exit 1; exit 0 ;;
  stop|rm|builder|image) exit 0 ;;
esac
`);
  executable(join(bin, "date"), `#!/bin/sh
[ "$*" = '-u +%s' ] && { echo 1788292800; exit 0; }
[ "$*" = '-u +%FT%TZ' ] && { echo 2026-09-01T20:00:00Z; exit 0; }
case "$*" in *"6 hours ago"*) echo '2026-09-01 14:00:00'; exit 0 ;; esac
exec /bin/date "$@"
`);
  executable(join(bin, "df"), "#!/bin/sh\nprintf 'overlay 100G 20G 80G 20%% /\\n'\n");
  if (unavailableRuns) {
    executable(join(bin, "ls"), `#!/bin/sh
case "$1" in *app-one/.eve/.workflow-data/runs) exit 1 ;; esac
exec /bin/ls "$@"
`);
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    EVE_DOCKER_PATH: join(bin, "fake-docker"),
    FAKE_DOCKER_LOG: log,
    ...(dryRun ? { KYB_PRUNE_DRY_RUN: "1" } : {}),
    ...(noAppEnv
      ? { FAKE_SCENARIO: "no-app" }
      : { EVE_APP_DIRS: `${app1}:${app2}`, ...(unavailableRuns ? { FAKE_SCENARIO: "unavailable" } : {}) }),
  };
  delete env.EVE_APP_DIR;
  if (noAppEnv) delete env.EVE_APP_DIRS;

  try {
    const output = execFileSync("sh", [script], { cwd: noAppEnv ? "/" : dir, env, encoding: "utf8" });
    return {
      output,
      calls: readFileSync(log, "utf8").trim().split("\n"),
      markers: {
        old: existsSync(oldMarker),
        failed: existsSync(failedMarker),
        kept: existsSync(keptMarker),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mutated = (calls, id) => calls.some((call) => /^(rm|stop) /.test(call) && call.includes(id));

test("durable run state reclaims exited sessions promptly and protects live sessions", () => {
  const { output, calls } = runPrune();
  assert.ok(calls.includes("rm terminal"));
  assert.ok(calls.includes("rm missing"));
  assert.equal(mutated(calls, "running-2h"), false);
  assert.ok(calls.includes("rm running-30h"));
  assert.ok(calls.includes("rm malformed"), "unknown old exited sessions use the idle cutoff");
  assert.equal(mutated(calls, "running-current"), false);
  assert.ok(calls.includes("stop running-old"));
  assert.ok(calls.includes("rm running-old"));
  assert.match(output, /workflow run wrun_terminal is terminal/);
  assert.match(output, /workflow run wrun_missing is conclusively missing/);
  assert.match(output, /keeping exited session container .*wrun_running_2h/);
  assert.ok(calls.includes("rm -f build-leak"));
  assert.equal(mutated(calls, "build-live"), false);
});

test("without an app environment or readable run store a young exited session is kept", () => {
  const { output, calls } = runPrune({ noAppEnv: true });
  assert.equal(mutated(calls, "young"), false);
  assert.match(output, /keeping exited session container .*run state unknown/);
});


test("an unavailable candidate run directory cannot authorize immediate missing-run deletion", () => {
  const { output, calls } = runPrune({ unavailableRuns: true });
  assert.equal(mutated(calls, "unsafe-missing"), false);
  assert.match(output, /keeping exited session container .*run state unknown/);
});

test("template batches remain per app hash and only successful exact-image markers are removed", () => {
  const { calls, markers } = runPrune();
  assert.ok(calls.includes("rmi old-template"));
  assert.ok(calls.includes("rmi failed-template"));
  assert.equal(calls.includes("rmi current-template"), false);
  assert.deepEqual(markers, { old: false, failed: true, kept: true });
  assert.ok(calls.includes("builder prune -af"));
  assert.ok(calls.includes("image prune -f"));
});

test("dry run performs no Docker or marker mutation", () => {
  const { output, calls, markers } = runPrune({ dryRun: true });
  assert.equal(calls.some((call) => /^(rm|rmi|stop|builder|image|container) /.test(call)), false, calls.join("; "));
  assert.deepEqual(markers, { old: true, failed: true, kept: true });
  assert.match(output, /would remove session container/);
  assert.match(output, /would remove superseded sandbox template/);
});

test("startup runs packaged reclaim before Eve while preserving the orphan sweep", () => {
  const source = readFileSync(serverScript, "utf8");
  const prune = source.indexOf('EVE_APP_DIR="$APP" "$PRUNE_SCRIPT" || true');
  const start = source.indexOf("npx eve start --host 0.0.0.0");
  assert.ok(prune >= 0 && prune < start);
  assert.match(source, /docker top "\$c"/);
  assert.match(source, /docker rm -f "\$c"/);
});

test("session thresholds retain the documented defaults and no blanket container prune exists", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /KYB_PRUNE_IDLE_HOURS:-24/);
  assert.match(source, /KYB_PRUNE_SESSION_HOURS:-168/);
  assert.doesNotMatch(source, /docker container prune/);
  assert.match(source, /never break a live session/i);
});
