import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/docker-prune.sh", import.meta.url));
const serverScript = fileURLToPath(new URL("../scripts/eve-server.sh", import.meta.url));

const rootRun = "01M1Q4SASKGVGWDCEFBKG1ZH8F";
const builderRun = "01M1Q3TJVVGCPNVVRPAYEA4WMX";
const missingRun = "01M1Q0".padEnd(26, "0");
const oldIdleRun = "01M1Q1".padEnd(26, "1");
const malformedRun = "01M1Q2".padEnd(26, "2");
for (const id of [rootRun, builderRun, missingRun, oldIdleRun, malformedRun]) assert.equal(id.length, 26);

const tags = {
  recent: "eve-sbx-tpl-docker-4c41-recent-rt",
  stale: "eve-sbx-tpl-docker-4c41-stale-rt",
  absent: "eve-sbx-tpl-docker-4c41-absent-rt",
  failed: "eve-sbx-tpl-docker-4c41-failed-rt",
  uncertain: "eve-sbx-tpl-docker-4c41-uncertain-rt",
  current: "eve-sbx-tpl-docker-4c41-current-rt",
};

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeRun(app, id, value) {
  const dir = join(app, ".eve/.workflow-data/runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), typeof value === "string" ? value : JSON.stringify(value));
}

function marker(app, tag, touchedAt) {
  const dir = join(app, ".eve/sandbox-cache/docker/templates");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, tag);
  writeFileSync(path, "marker identity is its exact tag-named path\n");
  utimesSync(path, touchedAt, touchedAt);
  return path;
}

function sessionName(runId, suffix) {
  return `eve-sbx-ses-docker-4c4164b5039c3606-18de43bbdbe2-wrun_${runId}-${suffix}`;
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
  writeRun(app1, `wrun_${rootRun}`, { status: "completed" });
  writeRun(app2, `wrun_${builderRun}`, { status: "running" });
  writeRun(app2, `wrun_${oldIdleRun}`, { status: "running" });
  writeRun(app1, `wrun_${malformedRun}`, "not json");

  // The fake clock is 2026-09-01T20:00:00Z. Exactly seven days is inclusive.
  const recentMarker = marker(app1, tags.recent, new Date("2026-08-25T20:00:00Z"));
  const staleMarker = marker(app1, tags.stale, new Date("2026-08-25T19:59:59Z"));
  const failedMarker = marker(app1, tags.failed, new Date("2026-08-20T00:00:00Z"));
  const uncertainMarker = marker(app2, tags.uncertain, new Date("2026-08-20T00:00:00Z"));
  const currentMarker = marker(app1, tags.current, new Date("2026-09-01T19:00:00Z"));

  executable(join(bin, "fake-docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    if [ "\${FAKE_SCENARIO:-}" = no-app ]; then
      printf '%s\\n' 'young|eve-sbx-ses-docker-aaaa-wrun_unknown|2026-09-01 19:00:00 +0000 UTC|Exited (0) 1 hour ago'
    elif [ "\${FAKE_SCENARIO:-}" = unavailable ]; then
      printf '%s\\n' 'unsafe-missing|${sessionName(missingRun, "__root__")}|2026-09-01 19:00:00 +0000 UTC|Exited (0) 1 hour ago'
    else
      printf '%s\\n' \\
        'terminal|${sessionName(rootRun, "__root__")}|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'missing|${sessionName(missingRun, "__root__")}|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'running-2h|${sessionName(builderRun, "subagents-builder")}|2026-09-01 18:00:00 +0000 UTC|Exited (0) 2 hours ago' \\
        'running-30h|${sessionName(oldIdleRun, "subagents-builder")}|2026-08-31 14:00:00 +0000 UTC|Exited (0) 30 hours ago' \\
        'malformed|${sessionName(malformedRun, "__root__")}|2026-08-31 14:00:00 +0000 UTC|Exited (0) 30 hours ago' \\
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
    printf '${tags.recent}\\t2026-08-20 00:00:00 +0000 UTC\\trecent-template\\n'
    printf '${tags.stale}\\t2026-08-20 01:00:00 +0000 UTC\\tstale-template\\n'
    printf '${tags.absent}\\t2026-08-20 02:00:00 +0000 UTC\\tabsent-template\\n'
    printf '${tags.failed}\\t2026-08-20 03:00:00 +0000 UTC\\tfailed-template\\n'
    printf '${tags.uncertain}\\t2026-08-20 04:00:00 +0000 UTC\\tuncertain-template\\n'
    printf '${tags.current}\\t2026-09-01 14:23:00 +0000 UTC\\tcurrent-template\\n'
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
  executable(join(bin, "stat"), `#!/bin/sh
case "$*" in *${tags.uncertain}) exit 1 ;; esac
exec /usr/bin/stat "$@"
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
        recent: existsSync(recentMarker),
        stale: existsSync(staleMarker),
        failed: existsSync(failedMarker),
        uncertain: existsSync(uncertainMarker),
        current: existsSync(currentMarker),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mutated = (calls, id) => calls.some((call) => /^(rm|stop) /.test(call) && call.includes(id));

test("production-shaped root and subagent names resolve to bare durable run ids", () => {
  const { output, calls } = runPrune();
  assert.ok(calls.includes("rm terminal"));
  assert.ok(calls.includes("rm missing"));
  assert.equal(mutated(calls, "running-2h"), false);
  assert.ok(calls.includes("rm running-30h"));
  assert.ok(calls.includes("rm malformed"), "unknown old exited sessions use the idle cutoff");
  assert.equal(mutated(calls, "running-current"), false);
  assert.ok(calls.includes("stop running-old"));
  assert.ok(calls.includes("rm running-old"));
  assert.match(output, new RegExp(`workflow run wrun_${rootRun} is terminal`));
  assert.doesNotMatch(output, new RegExp(`workflow run wrun_${rootRun}-__root__`));
  assert.match(output, new RegExp(`keeping exited session container .*wrun_${builderRun}-subagents-builder.*run state running`));
  assert.ok(calls.includes("rm -f build-leak"));
  assert.equal(mutated(calls, "build-live"), false);
});

test("without an app environment or parseable run id a young exited session is kept", () => {
  const { output, calls } = runPrune({ noAppEnv: true });
  assert.equal(mutated(calls, "young"), false);
  assert.match(output, /keeping exited session container .*run state unknown/);
});

test("an unavailable candidate run directory cannot authorize immediate missing-run deletion", () => {
  const { output, calls } = runPrune({ unavailableRuns: true });
  assert.equal(mutated(calls, "unsafe-missing"), false);
  assert.match(output, /keeping exited session container .*run state unknown/);
});

test("recent exact tag markers veto batch removal while stale and absent markers do not", () => {
  const { output, calls, markers } = runPrune();
  assert.equal(calls.includes("rmi recent-template"), false, "exactly seven days old is inclusive");
  assert.equal(calls.includes("rmi uncertain-template"), false, "stat uncertainty protects");
  assert.equal(calls.includes("rmi current-template"), false);
  assert.ok(calls.includes("rmi stale-template"));
  assert.ok(calls.includes("rmi absent-template"));
  assert.ok(calls.includes("rmi failed-template"));
  assert.deepEqual(markers, { recent: true, stale: false, failed: true, uncertain: true, current: true });
  assert.match(output, /keeping sandbox template .*recent.*marker touched within 7d/);
  assert.match(output, /keeping sandbox template .*uncertain.*marker time unavailable/);
  assert.ok(calls.includes("builder prune -af"));
  assert.ok(calls.includes("image prune -f"));
});

test("dry run performs no Docker or marker mutation", () => {
  const { output, calls, markers } = runPrune({ dryRun: true });
  assert.equal(calls.some((call) => /^(rm|rmi|stop|builder|image|container) /.test(call)), false, calls.join("; "));
  assert.deepEqual(markers, { recent: true, stale: true, failed: true, uncertain: true, current: true });
  assert.match(output, /would remove session container/);
  assert.match(output, /would remove superseded sandbox template .*marker stale/);
  assert.match(output, /would remove superseded sandbox template .*marker absent/);
});

test("startup runs packaged reclaim before Eve while preserving the orphan sweep", () => {
  const source = readFileSync(serverScript, "utf8");
  const prune = source.indexOf('EVE_APP_DIR="$APP" "$PRUNE_SCRIPT" || true');
  const start = source.indexOf("npx eve start --host 0.0.0.0");
  assert.ok(prune >= 0 && prune < start);
  assert.match(source, /docker top "\$c"/);
  assert.match(source, /docker rm -f "\$c"/);
});

test("threshold defaults and operational rationale remain documented beside the rules", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /KYB_PRUNE_IDLE_HOURS:-24/);
  assert.match(source, /KYB_PRUNE_SESSION_HOURS:-168/);
  assert.match(source, /KYB_PRUNE_TEMPLATE_MARKER_DAYS:-7/);
  assert.doesNotMatch(source, /docker container prune/);
  assert.match(source, /inspect failures protect/i);
  assert.match(source, /per checkout/i);
  assert.match(source, /share one Docker daemon/i);
  assert.match(source, /rebuilt alone/i);
});
