import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(counter.count, 2);
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
    assert.equal(recorded.cwd, dir);
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
