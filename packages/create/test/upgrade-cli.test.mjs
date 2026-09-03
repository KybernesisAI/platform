import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-upgrade-cli-"));
  const bin = join(dir, "bin");
  const systemd = join(dir, "systemd");
  const log = join(dir, "commands.log");
  mkdirSync(join(dir, ".eve/.workflow-data/runs"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(bin);
  mkdirSync(systemd);
  writeFileSync(join(dir, ".eve/.workflow-data/runs/open.json"), JSON.stringify({ runId: "run-open", status: "running" }));
  writeFileSync(join(dir, "package-lock.json"), "original lock\n");
  writeFileSync(join(dir, "node_modules/sentinel"), "installed\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { typecheck: "true", eval: "ARCANA_COMPANY_WORKSPACE=fixture-eval eve eval --strict" },
    dependencies: {
      "@kybernesis/buzz": "~0.8.0",
      "@kybernesis/evals": "0.6.1",
      eve: options.eveRange ?? "0.38.3",
      zod: "4.4.3",
    },
    devDependencies: { "@kybernesis/enterprise": "0.7.0", typescript: "7.0.2" },
  }, null, 2) + "\n");

  executable(join(bin, "node"), `#!/bin/sh
case "$*" in
  *"eve/package.json"*) echo "${options.eveInstalled ?? "0.38.3"}" ;;
  *"@kybernesis/buzz/package.json"*peerDependencies*) echo "^0.38.0" ;;
  *"@kybernesis/buzz/package.json"*) echo 0.8.0 ;;
  *"@kybernesis/evals/package.json"*peerDependencies*) echo "^0.38.0" ;;
  *"@kybernesis/evals/package.json"*) echo 0.6.1 ;;
  *"@kybernesis/enterprise/package.json"*peerDependencies*) echo "^0.38.0" ;;
  *"@kybernesis/enterprise/package.json"*) echo 0.7.0 ;;
  *) exec ${JSON.stringify(process.execPath)} "$@" ;;
esac
`);
  executable(join(bin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$KYB_TEST_COMMAND_LOG"
if [ "$1" = view ]; then
  case "$2 $3" in
    "@kybernesis/create version") echo 0.14.5 ;;
    "@kybernesis/buzz version") echo 0.9.0 ;;
    "@kybernesis/evals version") echo 0.6.2 ;;
    "@kybernesis/enterprise version") echo 0.8.0 ;;
    "eve version") echo 0.49.0 ;;
    "@kybernesis/buzz@0.9.0 peerDependencies.eve") echo "^0.49.0" ;;
    "@kybernesis/evals@0.6.2 peerDependencies.eve") echo "^0.49.0" ;;
    "@kybernesis/enterprise@0.8.0 peerDependencies.eve") echo "^0.49.0" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = install ]; then
  [ -d node_modules ] && modules=yes || modules=no
  [ -f package-lock.json ] && lock=yes || lock=no
  printf 'install-state node_modules=%s lock=%s\\n' "$modules" "$lock" >> "$KYB_TEST_COMMAND_LOG"
  if [ "$KYB_INSTALL_FAIL" = 1 ]; then
    echo "npm ERR! code ERESOLVE" >&2
    echo "npm ERR! unable to resolve dependency tree" >&2
    exit 1
  fi
  mkdir -p node_modules
  echo regenerated > package-lock.json
  exit 0
fi
if [ "$1 $2" = "ls eve" ]; then
  [ "$KYB_LS_FAIL" = 1 ] && exit 1
  echo 'fixture@1.0.0'
  echo 'eve@0.49.0'
  exit 0
fi
exit 0
`);
  executable(join(bin, "npx"), `#!/bin/sh
printf 'npx %s\\n' "$*" >> "$KYB_TEST_COMMAND_LOG"
exit 0
`);
  executable(join(bin, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$KYB_TEST_COMMAND_LOG"
[ "$1" = is-active ] || exit 0
[ "$KYB_BRIDGE_STATE" = active ] && exit 0
exit 3
`);
  executable(join(bin, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$KYB_TEST_COMMAND_LOG"
case "$*" in
  *" systemctl stop "*) [ "$KYB_STOP_FAIL" = 1 ] && exit 1 ;;
  *" systemctl start "*) [ "$KYB_START_FAIL" = 1 ] && exit 1 ;;
esac
exit 0
`);

  if (options.agentUnit !== false) {
    writeFileSync(join(systemd, "fixture-agent.service"), `[Service]\nUser=fixture\nWorkingDirectory=${dir}\nEnvironment=PORT=8000\n`);
  }

  return {
    dir,
    log,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      KYB_TEST_COMMAND_LOG: log,
      KYB_SYSTEMD_DIR: systemd,
      KYB_BRIDGE_STATE: options.bridgeState ?? "inactive",
      ...(options.installFail ? { KYB_INSTALL_FAIL: "1" } : {}),
      ...(options.lsFail ? { KYB_LS_FAIL: "1" } : {}),
      ...(options.stopFail ? { KYB_STOP_FAIL: "1" } : {}),
      ...(options.startFail ? { KYB_START_FAIL: "1" } : {}),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runUpgrade(fix, args = ["--yes"]) {
  return spawnSync(process.execPath, [cli, "upgrade", "--skip-eval", ...args], {
    cwd: fix.dir,
    env: fix.env,
    encoding: "utf8",
  });
}

function commandLog(fix) {
  return existsSync(fix.log) ? readFileSync(fix.log, "utf8") : "";
}

test("confirmation refusal occurs before manifest mutation, deletion, or bridge commands", () => {
  const fix = fixture({ bridgeState: "active" });
  try {
    const manifest = readFileSync(join(fix.dir, "package.json"), "utf8");
    const result = runUpgrade(fix, []);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /This will reset 1 open conversations/);
    assert.match(result.stdout, /cancelled before installation/);
    assert.equal(readFileSync(join(fix.dir, "package.json"), "utf8"), manifest);
    assert.ok(existsSync(join(fix.dir, "node_modules/sentinel")));
    assert.equal(readFileSync(join(fix.dir, "package-lock.json"), "utf8"), "original lock\n");
    assert.doesNotMatch(commandLog(fix), /systemctl|npm install/);
  } finally {
    fix.cleanup();
  }
});

for (const flag of ["--yes", "-y"]) {
  test(`${flag} clean-upgrades every root Kybernesis and Eve range with strict npm`, () => {
    const fix = fixture();
    try {
      const result = runUpgrade(fix, [flag]);
      assert.equal(result.status, 0, result.stderr);
      const pkg = JSON.parse(readFileSync(join(fix.dir, "package.json"), "utf8"));
      assert.equal(pkg.dependencies["@kybernesis/buzz"], "^0.9.0");
      assert.equal(pkg.dependencies["@kybernesis/evals"], "^0.6.2");
      // Exact on purpose: the pin is the certification (a caret pulled 0.49.1).
      assert.equal(pkg.dependencies.eve, "0.49.0");
      assert.equal(pkg.devDependencies["@kybernesis/enterprise"], "^0.8.0");
      assert.equal(pkg.dependencies.zod, "4.4.3");
      assert.equal(pkg.devDependencies.typescript, "7.0.2");
      assert.equal(pkg.scripts.eval, "ARCANA_COMPANY_WORKSPACE=fixture-eval kyb-eval --strict");
      const log = commandLog(fix);
      assert.match(log, /^npm install$/m);
      assert.match(log, /install-state node_modules=no lock=no/);
      assert.match(log, /^npm ls eve$/m);
      assert.doesNotMatch(log, /legacy-peer-deps|--force/);
    } finally {
      fix.cleanup();
    }
  });
}

test("same-major/minor Eve state uses the in-place package install without bridge interruption", () => {
  const fix = fixture({ eveInstalled: "0.49.0", eveRange: "^0.49.0", bridgeState: "active" });
  try {
    const result = runUpgrade(fix);
    assert.equal(result.status, 0, result.stderr);
    const log = commandLog(fix);
    assert.match(log, /^npm install @kybernesis\/buzz@0\.9\.0 @kybernesis\/enterprise@0\.8\.0 @kybernesis\/evals@0\.6\.2$/m);
    assert.match(log, /install-state node_modules=yes lock=yes/);
    assert.match(log, /^npm ls eve$/m);
    assert.doesNotMatch(log, /systemctl/);
    assert.doesNotMatch(log, /legacy-peer-deps|--force/);
  } finally {
    fix.cleanup();
  }
});

test("an active bridge stops before deletion and starts only after install and peer validation", () => {
  const fix = fixture({ bridgeState: "active" });
  try {
    const result = runUpgrade(fix);
    assert.equal(result.status, 0, result.stderr);
    const log = commandLog(fix);
    const stop = log.indexOf("sudo -n systemctl stop fixture-buzz-bridge.service");
    const install = log.indexOf("npm install\n");
    const validate = log.indexOf("npm ls eve");
    const start = log.indexOf("sudo -n systemctl start fixture-buzz-bridge.service");
    assert.ok(stop >= 0 && stop < install, log);
    assert.ok(install < validate && validate < start, log);
  } finally {
    fix.cleanup();
  }
});

for (const [label, options] of [
  ["inactive", { bridgeState: "inactive" }],
  ["missing agent unit", { agentUnit: false, bridgeState: "active" }],
]) {
  test(`${label} bridge state is never stopped or started`, () => {
    const fix = fixture(options);
    try {
      const result = runUpgrade(fix);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(commandLog(fix), /systemctl (stop|start)|sudo .*systemctl/);
    } finally {
      fix.cleanup();
    }
  });
}

test("bridge stop failure is fatal before manifest rewrite or dependency deletion", () => {
  const fix = fixture({ bridgeState: "active", stopFail: true });
  try {
    const manifest = readFileSync(join(fix.dir, "package.json"), "utf8");
    const result = runUpgrade(fix);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sudo -n systemctl stop fixture-buzz-bridge\.service/);
    assert.equal(readFileSync(join(fix.dir, "package.json"), "utf8"), manifest);
    assert.ok(existsSync(join(fix.dir, "node_modules/sentinel")));
    assert.doesNotMatch(commandLog(fix), /^npm install$/m);
  } finally {
    fix.cleanup();
  }
});

test("bridge start failure after validation is visible and fatal", () => {
  const fix = fixture({ bridgeState: "active", startFail: true });
  try {
    const result = runUpgrade(fix);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /systemctl start fixture-buzz-bridge\.service/);
    assert.match(result.stderr, /systemctl status fixture-buzz-bridge\.service/);
    const log = commandLog(fix);
    assert.ok(log.indexOf("npm ls eve") < log.indexOf("systemctl start fixture-buzz-bridge.service"));
  } finally {
    fix.cleanup();
  }
});

test("ERESOLVE reports factual Eve peer-range changes and the complete remedy", () => {
  const fix = fixture({ bridgeState: "active", installFail: true });
  try {
    const result = runUpgrade(fix);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /ERESOLVE/);
    assert.match(output, /@kybernesis\/buzz: 0\.8\.0 peers on \^0\.38\.0; 0\.9\.0 peers on \^0\.49\.0/);
    assert.match(output, /@kybernesis\/enterprise: 0\.7\.0 peers on \^0\.38\.0; 0\.8\.0 peers on \^0\.49\.0/);
    assert.match(output, /@kybernesis\/evals: 0\.6\.1 peers on \^0\.38\.0; 0\.6\.2 peers on \^0\.49\.0/);
    for (const command of ["rm -rf node_modules", "rm -f package-lock.json", "npm install", "npm ls eve"]) {
      assert.ok(output.includes(command), output);
    }
    assert.match(output, /metadata facts, not an attribution/);
    assert.match(output, /bridge remains stopped/);
    assert.doesNotMatch(commandLog(fix), /systemctl start/);
  } finally {
    fix.cleanup();
  }
});

test("npm ls eve failure propagates and leaves a stopped bridge stopped", () => {
  const fix = fixture({ bridgeState: "active", lsFail: true });
  try {
    const result = runUpgrade(fix);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm ls eve failed/);
    assert.match(result.stdout, /bridge remains stopped/);
    assert.doesNotMatch(commandLog(fix), /systemctl start/);
  } finally {
    fix.cleanup();
  }
});

const npmOffline =
  process.env.KYB_TEST_OFFLINE === "1" ||
  ["1", "true"].includes((process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? "").toLowerCase());
test("[network] published Buzz 0.8 and Eve 0.38 upgrade to the certified peer tree", { skip: npmOffline }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-upgrade-network-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "kyb-upgrade-network-fixture",
      private: true,
      scripts: { typecheck: "true" },
      dependencies: { "@kybernesis/buzz": "^0.8.0", eve: "^0.38.3" },
    }, null, 2) + "\n");
    const initial = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8" });
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const upgraded = spawnSync(process.execPath, [cli, "upgrade", "--yes", "--skip-eval"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, KYB_SYSTEMD_DIR: join(dir, "missing-systemd") },
    });
    assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
    const tree = spawnSync("npm", ["ls", "eve"], { cwd: dir, encoding: "utf8" });
    assert.equal(tree.status, 0, tree.stdout + tree.stderr);
    assert.match(tree.stdout, /eve@0\.49\.0/);
  } finally {
    // A real eve install leaves read-only directories behind (the baked
    // sandbox tree); rmSync alone hit EACCES on CI and failed a test whose
    // assertions had passed. Reopen the tree first, and never let a leaked
    // temp dir be the verdict.
    spawnSync("chmod", ["-R", "u+rwX", dir]);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.warn(`could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
