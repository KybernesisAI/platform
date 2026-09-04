import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { githubToolsDoctorCheck } from "../dist/doctor.js";
import { finalizeGithubToolsRegistryMount } from "../dist/init.js";
import {
  LEGACY_GITHUB_TOOLS_MOUNT,
  githubToolsMountTs,
} from "../dist/templates.js";
import { repairGithubToolsMount } from "../dist/upgrade.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-github-tools-"));
  mkdirSync(join(dir, "agent/extensions"), { recursive: true });
  return {
    dir,
    path: join(dir, "agent/extensions/github.ts"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runRenderedMount(token) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-github-runtime-"));
  const path = join(dir, "mount.mjs");
  const source = githubToolsMountTs()
    .replace(
      'import githubTools from "@github-tools/eve-extension";',
      `function githubTools(options) {
  return {
    options,
    resolve() {
      if (!process.env.GITHUB_TOKEN && typeof options.token !== "function") {
        throw new Error("GitHub token is required.");
      }
      return options.include?.length === 0 ? {} : { github_issue: {} };
    },
  };
}`,
    )
    .replace("export default githubTools(", "const mounted = githubTools(") +
    `\nconsole.log(JSON.stringify({ optionKeys: Object.keys(mounted.options), tools: Object.keys(mounted.resolve()) }));\n`;
  writeFileSync(path, source);
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  if (token !== undefined) env.GITHUB_TOKEN = token;
  const result = spawnSync(process.execPath, [path], { env, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("managed source keeps Eve's direct imported-factory default-call shape", () => {
  const source = githubToolsMountTs();
  assert.match(source, /^import githubTools from "@github-tools\/eve-extension";/);
  assert.match(source, /export default githubTools\(githubToolsOptions\(\)\);/);
  assert.doesNotMatch(source, /export default\s+(?:githubToolsOptions|defineExtension)\b/);
});

test("without GITHUB_TOKEN the rendered mount resolves quietly to zero tools", () => {
  const result = runRenderedMount(undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const rendered = JSON.parse(result.stdout);
  assert.deepEqual(rendered.optionKeys.sort(), ["include", "token"]);
  assert.deepEqual(rendered.tools, []);
});

test("with GITHUB_TOKEN the rendered mount retains the registry's default behavior", () => {
  const result = runRenderedMount("github-token");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const rendered = JSON.parse(result.stdout);
  assert.deepEqual(rendered.optionKeys, []);
  assert.deepEqual(rendered.tools, ["github_issue"]);
});

test("init only replaces a successfully installed GitHub registry mount", () => {
  const fix = fixture();
  try {
    writeFileSync(fix.path, LEGACY_GITHUB_TOOLS_MOUNT);
    assert.equal(finalizeGithubToolsRegistryMount(fix.dir, false), false);
    assert.equal(readFileSync(fix.path, "utf8"), LEGACY_GITHUB_TOOLS_MOUNT);

    assert.equal(finalizeGithubToolsRegistryMount(fix.dir, true), true);
    assert.equal(readFileSync(fix.path, "utf8"), githubToolsMountTs());

    rmSync(fix.path);
    assert.equal(finalizeGithubToolsRegistryMount(fix.dir, true), false);
  } finally {
    fix.cleanup();
  }
});

test("upgrade replaces only the exact legacy scaffold and is idempotent", () => {
  const fix = fixture();
  try {
    writeFileSync(fix.path, LEGACY_GITHUB_TOOLS_MOUNT);
    assert.deepEqual(repairGithubToolsMount(fix.dir), { kind: "updated" });
    assert.equal(readFileSync(fix.path, "utf8"), githubToolsMountTs());
    assert.deepEqual(repairGithubToolsMount(fix.dir), { kind: "current" });
  } finally {
    fix.cleanup();
  }
});

test("upgrade leaves customized and missing GitHub mounts alone", () => {
  const fix = fixture();
  try {
    const custom = 'import githubTools from "@github-tools/eve-extension";\nexport default githubTools({ include: ["repos"] });\n';
    writeFileSync(fix.path, custom);
    assert.deepEqual(repairGithubToolsMount(fix.dir), { kind: "customized" });
    assert.equal(readFileSync(fix.path, "utf8"), custom);

    rmSync(fix.path);
    assert.deepEqual(repairGithubToolsMount(fix.dir), { kind: "missing" });
  } finally {
    fix.cleanup();
  }
});

test("doctor reports the off state only for a mounted extension without a token", () => {
  assert.deepEqual(githubToolsDoctorCheck(true, {}), {
    verdict: "warn",
    label: "GitHub tools off (no GITHUB_TOKEN)",
    detail: "set GITHUB_TOKEN in .env.local or the deployment environment, then rebuild and restart",
  });
  assert.equal(githubToolsDoctorCheck(true, { GITHUB_TOKEN: "token" }), null);
  assert.equal(githubToolsDoctorCheck(false, {}), null);
});
