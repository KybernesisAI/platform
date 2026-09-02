import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-upgrade-cli-"));
  const bin = join(dir, "bin");
  const log = join(dir, "commands.log");
  mkdirSync(join(dir, ".eve/.workflow-data/runs"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(dir, ".eve/.workflow-data/runs/open.json"), JSON.stringify({ runId: "run-open", status: "running" }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { eval: "ARCANA_COMPANY_WORKSPACE=fixture-eval eve eval --strict" },
    dependencies: { "@kybernesis/evals": "0.6.1", eve: "0.38.3" },
  }, null, 2) + "\n");

  executable(join(bin, "node"), `#!/bin/sh
case "$*" in
  *"require('eve/package.json').version"*) echo 0.38.3 ;;
  *"require('@kybernesis/evals/package.json').version"*) echo 0.6.1 ;;
  *) exit 1 ;;
esac
`);
  executable(join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$KYB_TEST_COMMAND_LOG"
if [ "$1" = view ]; then
  case "$2" in
    @kybernesis/create) echo 0.14.3 ;;
    @kybernesis/evals) echo 0.6.1 ;;
    eve) echo 0.49.0 ;;
    *) exit 1 ;;
  esac
fi
exit 0
`);
  executable(join(bin, "npx"), "#!/bin/sh\nexit 1\n");

  return {
    dir,
    log,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, KYB_TEST_COMMAND_LOG: log },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runUpgrade(fix, args) {
  return spawnSync(process.execPath, [cli, "upgrade", "--skip-eval", ...args], {
    cwd: fix.dir,
    env: fix.env,
    encoding: "utf8",
  });
}

test("noninteractive eve upgrade refuses before install or package repair without --yes", () => {
  const fix = fixture();
  try {
    const before = readFileSync(join(fix.dir, "package.json"), "utf8");
    const result = runUpgrade(fix, []);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /This will reset 1 open conversations/);
    assert.match(result.stdout, /cancelled before installation/);
    assert.doesNotMatch(result.stdout, /Installing:/);
    assert.equal(readFileSync(join(fix.dir, "package.json"), "utf8"), before);
    assert.doesNotMatch(readFileSync(fix.log, "utf8"), /^install /m);
  } finally {
    fix.cleanup();
  }
});

for (const flag of ["--yes", "-y"]) {
  test(`${flag} prints the warning, installs, and reconciles the eval script`, () => {
    const fix = fixture();
    try {
      const result = runUpgrade(fix, [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /This will reset 1 open conversations/);
      assert.ok(result.stdout.indexOf("This will reset") < result.stdout.indexOf("Installing:"));
      assert.match(readFileSync(fix.log, "utf8"), /^install .*eve@0\.49\.0/m);
      const pkg = JSON.parse(readFileSync(join(fix.dir, "package.json"), "utf8"));
      assert.equal(pkg.scripts.eval, "ARCANA_COMPANY_WORKSPACE=fixture-eval kyb-eval --strict");
    } finally {
      fix.cleanup();
    }
  });
}
