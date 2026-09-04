import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CorruptionLineCounter } from "../dist/cli.js";

const wrapper = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-eval-"));
  const eve = join(dir, "node_modules/eve");
  mkdirSync(eve, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(eve, "package.json"), JSON.stringify({
    name: "eve",
    version: "0.0.0-test",
    type: "module",
    exports: { "./package.json": "./package.json" },
    bin: { eve: "cli.js" },
  }));
  writeFileSync(join(eve, "cli.js"), `
import { writeFileSync } from "node:fs";
const mode = process.env.FAKE_EVE_MODE;
if (process.env.FAKE_RECORD) {
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), probe: process.env.FAKE_PROBE }));
}
if (mode === "normal-corrupt") {
  process.stdout.write("starting\\nResults:\\n  Passed: 3\\n");
  process.stderr.write("background CorruptedEvent");
  process.stderr.write("LogError and CORRUPTED_EVENT_LOG");
  process.exitCode = 0;
} else if (mode === "json-corrupt") {
  process.stdout.write(JSON.stringify({ passed: 3, failed: 0 }));
  process.stderr.write("CORRUPTED_EVENT_LOG\\n");
} else if (mode === "failed") {
  process.stdout.write("Results:\\n  Failed: 1\\n");
  process.exitCode = 7;
} else if (mode === "judge-unreachable") {
  process.stdout.write("  ✗ judge.autoevals.correctness\\n    autoevals error: connect EHOSTDOWN 169.254.169.254:443\\nResults:\\n  Failed: 1\\n");
  process.exitCode = 7;
} else if (mode === "judge-status") {
  process.stderr.write("judge.autoevals.correctness\\nautoevals error: request failed with HTTP 503\\n");
  process.stdout.write(JSON.stringify({ passed: 0, failed: 1 }));
  process.exitCode = 7;
} else {
  process.stdout.write("progress\\nResults:\\n  Passed: 4\\n");
}
`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, mode, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, FAKE_EVE_MODE: mode, ...extraEnv },
  });
}

test("line parser handles chunk boundaries, final unterminated lines, and counts a dual-marker line once", () => {
  const counter = new CorruptionLineCounter();
  counter.push("one CorruptedEvent");
  counter.push("LogError and CORRUPTED_EVENT_LOG\nclean\nCORRUPTED_");
  counter.push("EVENT_LOG");
  counter.finish();
  // The trailing bare code line sits right under the error, so it is the same run.
  assert.equal(counter.count, 1);
});

test("eve's two-line block per condemned run counts as one run, and a bare code line far from any error counts on its own", () => {
  const counter = new CorruptionLineCounter();
  const block = (id) =>
    `[workflow-sdk] Error while running workflow\n  CorruptedEventLogError\n  run    ${id}\n  code   CORRUPTED_EVENT_LOG\n`;
  counter.push(block("wrun_A") + block("wrun_B"));
  counter.push(Array(20).fill("progress").join("\n") + "\n");
  counter.push("status CORRUPTED_EVENT_LOG for wrun_C\n");
  counter.finish();
  assert.equal(counter.count, 3);
});

test("normal output places the condemnation count beside Results and turns child zero into failure", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = run(dir, "normal-corrupt");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /starting\nCondemned runs: 1\nResults:/);
    assert.match(result.stderr, /CorruptedEventLogError and CORRUPTED_EVENT_LOG/);
  } finally {
    cleanup();
  }
});

test("JSON mode keeps stdout parseable and reports the count on stderr", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = run(dir, "json-corrupt", ["--json"]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { passed: 3, failed: 0 });
    assert.match(result.stderr, /Condemned runs: 1/);
  } finally {
    cleanup();
  }
});

test("clean evals exit zero, report zero, and forward args, environment, and cwd", () => {
  const { dir, cleanup } = fixture();
  try {
    const record = join(dir, "record.json");
    const result = run(dir, "clean", ["--strict", "--junit", ".eve/junit.xml"], {
      FAKE_RECORD: record,
      FAKE_PROBE: "forwarded",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Condemned runs: 0\nResults:/);
    const recorded = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(recorded.argv, ["eval", "--strict", "--junit", ".eve/junit.xml"]);
    // macOS keeps its temp dir behind a symlink (/var → /private/var); the child reports the real path.
    assert.equal(realpathSync(recorded.cwd), realpathSync(dir));
    assert.equal(recorded.probe, "forwarded");
  } finally {
    cleanup();
  }
});

test("an existing nonzero eve status is preserved", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = run(dir, "failed");
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Condemned runs: 0/);
  } finally {
    cleanup();
  }
});


test("judge transport failures are named as judge failures beside the console summary", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = run(dir, "judge-unreachable");
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Judge failure: the judge could not be reached\.\nResults:/);
    assert.doesNotMatch(result.stdout, /agent (failed|could not)/i);
  } finally {
    cleanup();
  }
});

test("judge HTTP failures report the response status without contaminating JSON stdout", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = run(dir, "judge-status", ["--json"]);
    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(result.stdout), { passed: 0, failed: 1 });
    assert.match(result.stderr, /Judge failure: the judge answered 503\./);
  } finally {
    cleanup();
  }
});
