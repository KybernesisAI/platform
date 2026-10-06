import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FILL_SCRIPT, fillOnComputer } from "../dist/index.js";

test("the fill script is valid JavaScript (it runs inside the container, where a syntax error would be a 500 at the worst moment)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fill-")), "fill.mjs");
  writeFileSync(file, FILL_SCRIPT);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("values travel on stdin, never on the command line; the result carries selectors, not values", async () => {
  const seen = { command: "", stdin: "", path: "" };
  const sandbox = {
    async writeTextFile({ path, content }) {
      seen.path = path;
      seen.stdin = content;
    },
    async run(options) {
      const command = options.command;
      seen.command = command;
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, filled: ["#u", "#p"], missing: [], page: "https://example.com" }), stderr: "" };
    },
  };
  const result = await fillOnComputer(sandbox, {
    pageOrigin: "https://example.com",
    fields: [
      { selector: "#u", value: "ian" },
      { selector: "#p", value: "hunter2-secret" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.filled, ["#u", "#p"]);
  assert.ok(!seen.command.includes("hunter2-secret"), "the secret must not be on the command line");
  assert.ok(seen.stdin.includes("hunter2-secret"), "the secret travels through the sandbox file, read on stdin");
  assert.ok(seen.command.includes(seen.path) && seen.command.includes("rm -f"), "the command reads the file and removes it");
  assert.ok(!JSON.stringify(result).includes("hunter2-secret"), "the result never echoes a value");
});
