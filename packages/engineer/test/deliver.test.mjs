import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import deliver from "../dist/extension/tools/deliver.mjs";

const KEYS = ["BLOB_READ_WRITE_TOKEN", "DELIVER_DIR", "DELIVER_BASE_URL", "EVE_PUBLIC_URL", "EXE_VM_NAME", "VERCEL", "HOME"];

async function run(env, filename = "report.md") {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const ctx = { getSandbox: async () => ({ readBinaryFile: async () => new TextEncoder().encode("# Report") }) };
    return await deliver.execute({ path: "/workspace/report.md", filename }, ctx);
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("on an exe host with no storage, the agent serves the file itself under a random id", async () => {
  const home = mkdtempSync(join(tmpdir(), "kyb-home-"));
  const out = await run({ HOME: home, EXE_VM_NAME: "acme" });
  const m = out.url.match(/^https:\/\/acme\.exe\.xyz\/eve\/v1\/kyb\/files\/([0-9a-f]{32})\/report\.md$/);
  assert.ok(m, out.url);
  assert.equal(readFileSync(join(home, ".kybernesis", "deliveries", m[1], "report.md"), "utf8"), "# Report");
  const again = await run({ HOME: home, EXE_VM_NAME: "acme" });
  assert.notEqual(again.url, out.url);
});

test("an explicit directory is served where the operator says, not by the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-deliver-"));
  const out = await run({ DELIVER_DIR: dir, DELIVER_BASE_URL: "https://files.example.com/", EXE_VM_NAME: "acme" });
  assert.match(out.url, /^https:\/\/files\.example\.com\/[0-9a-f]{32}\/report\.md$/);
  await assert.rejects(run({ DELIVER_DIR: dir, EXE_VM_NAME: "acme" }), /not configured/);
});

test("no address and no storage is refused, and so is a serverless host", async () => {
  await assert.rejects(run({}), /not configured/);
  await assert.rejects(run({ EVE_PUBLIC_URL: "https://agent.example.com", VERCEL: "1" }), /not configured/);
});

test("a dotted name cannot name the directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "kyb-home-"));
  const out = await run({ HOME: home, EVE_PUBLIC_URL: "https://agent.example.com" }, "..");
  assert.match(out.url, /\/[0-9a-f]{32}\/_$/);
});

test("the delivery carries a file card for the apps, which the model does not read", async () => {
  const home = mkdtempSync(join(tmpdir(), "kyb-home-"));
  const out = await run({ HOME: home, EVE_PUBLIC_URL: "https://agent.example.com" });
  assert.equal(out.kyb.card, "file");
  assert.deepEqual(out.kyb.data, { url: out.url, name: "report.md", size: 8, mediaType: "text/plain" });
  assert.equal(out.kyb.actions, undefined);
  const model = deliver.toModelOutput(out);
  assert.equal("kyb" in model.value, false);
  assert.equal(model.value.url, out.url);
});
