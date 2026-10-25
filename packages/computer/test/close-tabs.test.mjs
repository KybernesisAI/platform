import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeTabsCommand } from "../dist/index.js";

// A fake curl on PATH: /json/list answers with the given tabs, /json/close/<id> is recorded.
function runWithTabs(tabs) {
  const dir = mkdtempSync(join(tmpdir(), "close-tabs-"));
  writeFileSync(join(dir, "list.json"), tabs === null ? "" : JSON.stringify(tabs));
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
for a in "$@"; do url="$a"; done
case "$url" in
  */json/list) cat "${dir}/list.json" ;;
  */json/close/*) echo "\${url##*/}" >> "${dir}/closed"; echo "Target is closing" ;;
esac
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
  writeFileSync(join(dir, "closed"), "");
  const result = spawnSync("bash", ["-c", closeTabsCommand()], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  return { ...result, closed: readFileSync(join(dir, "closed"), "utf8").split("\n").filter(Boolean) };
}

test("closes every page but the most recent one, and leaves workers alone", () => {
  const result = runWithTabs([
    { id: "NEWEST", type: "page" },
    { id: "SW1", type: "service_worker" },
    { id: "OLD1", type: "page" },
    { id: "OLD2", type: "page" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.closed, ["OLD1", "OLD2"]);
  assert.equal(result.stdout.trim(), "closed 2 tab(s); 1 left open");
});

test("one tab open: nothing to close", () => {
  const result = runWithTabs([{ id: "ONLY", type: "page" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.closed, []);
  assert.equal(result.stdout.trim(), "closed 0 tab(s); 1 left open");
});

test("Chrome not running is not an error", () => {
  const result = runWithTabs(null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Chrome is not open");
});
