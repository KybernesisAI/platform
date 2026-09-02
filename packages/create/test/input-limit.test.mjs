import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION,
  discoverEffectiveInputLimit,
  formatEffectiveInputLimit,
  parseEveInfoJson,
  readEffectiveInputLimit,
  resolveEffectiveInputLimit,
} from "../dist/input-limit.js";
import { hostAgentTs } from "../dist/templates.js";

test("effective input limit resolves explicit numeric, false, and inherited values", () => {
  assert.deepEqual(
    resolveEffectiveInputLimit({ config: { limits: { maxInputTokensPerSession: 1234 } } }),
    { kind: "numeric", value: 1234, inherited: false },
  );
  assert.deepEqual(
    resolveEffectiveInputLimit({ config: { limits: { maxInputTokensPerSession: false } } }),
    { kind: "uncapped", inherited: false },
  );
  assert.deepEqual(
    resolveEffectiveInputLimit({ config: {} }),
    { kind: "numeric", value: EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION, inherited: true },
  );
});

test("effective limit formatter distinguishes explicit, uncapped, inherited, and unresolved", () => {
  assert.match(formatEffectiveInputLimit({ kind: "numeric", value: 40_000_000, inherited: true }), /40,000,000.*inherited eve default/);
  assert.match(formatEffectiveInputLimit({ kind: "numeric", value: 10, inherited: false }), /10 input tokens \(explicit\)/);
  assert.match(formatEffectiveInputLimit({ kind: "uncapped", inherited: false }), /uncapped.*explicit false/);
  assert.match(formatEffectiveInputLimit({ kind: "unresolved", reason: "missing" }), /unresolved.*missing/);
});

test("compiled manifest discovery reports malformed and unreadable inputs honestly", () => {
  assert.equal(readEffectiveInputLimit(null).kind, "unresolved");
  assert.equal(readEffectiveInputLimit({ diagnostics: null, artifacts: { compiledManifest: "/does/not/exist" } }).kind, "unresolved");

  const file = join(mkdtempSync(join(tmpdir(), "kyb-limit-")), "manifest.json");
  writeFileSync(file, JSON.stringify({ config: { limits: { maxInputTokensPerSession: false } } }));
  assert.deepEqual(
    readEffectiveInputLimit({ diagnostics: { errors: 0, warnings: 0 }, artifacts: { compiledManifest: file } }),
    { kind: "uncapped", inherited: false },
  );
});

test("exe scaffolds author the certified session limit while Vercel scaffolds stay unchanged", () => {
  const exe = hostAgentTs("exe", "openai/gpt-5");
  const vercel = hostAgentTs("vercel", "anthropic/claude-sonnet-5");
  assert.match(exe, /limits: \{ maxInputTokensPerSession: 40_000_000 \}/);
  assert.doesNotMatch(vercel, /maxInputTokensPerSession/);
});


test("eve info parsing rejects arrays and malformed diagnostics or artifacts", () => {
  assert.equal(parseEveInfoJson("[]"), null);
  assert.equal(parseEveInfoJson(JSON.stringify({ diagnostics: {}, artifacts: null })), null);
  assert.equal(parseEveInfoJson(JSON.stringify({ diagnostics: { errors: 0, warnings: "0" }, artifacts: null })), null);
  assert.equal(parseEveInfoJson(JSON.stringify({ diagnostics: null, artifacts: {} })), null);
  assert.deepEqual(
    parseEveInfoJson(JSON.stringify({
      diagnostics: { errors: 0, warnings: 2 },
      artifacts: { compiledManifest: "/tmp/manifest.json", extra: true },
      other: "allowed",
    })),
    {
      diagnostics: { errors: 0, warnings: 2 },
      artifacts: { compiledManifest: "/tmp/manifest.json" },
    },
  );
});

test("failed eve discovery surfaces the command stderr in the unresolved limit", () => {
  const result = discoverEffectiveInputLimit("/agent", {}, () => ({
    status: 1,
    stdout: "",
    stderr: "Agent compile failed: EXE_MODEL is not set\n",
  }));
  assert.equal(result.info, null);
  assert.equal(result.limit.kind, "unresolved");
  assert.match(result.limit.reason, /Agent compile failed: EXE_MODEL is not set/);
});

test("successful commands with unexpected JSON shape are not treated as discovery", () => {
  const result = discoverEffectiveInputLimit("/agent", {}, () => ({
    status: 0,
    stdout: JSON.stringify({ diagnostics: "clean", artifacts: [] }),
    stderr: "",
  }));
  assert.equal(result.info, null);
  assert.deepEqual(result.limit, {
    kind: "unresolved",
    reason: "eve info returned JSON with an unexpected shape",
  });
});
