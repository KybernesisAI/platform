import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AGENT_BROWSER_MOUNT,
  backUpWorkflowStore,
  migrateManifest,
  migrateSources,
  restoreWorkflowStore,
} from "../dist/line-hop.js";

const LINE_URL = "https://registry.kybernesis.ai/r/eve-0.81/{name}.json";

function agent(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-line-hop-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { dir, read: (path) => readFileSync(join(dir, path), "utf8"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the manifest drops the browser extension, pins GitHub tools, raises ai and moves the registry, once", () => {
  const pkg = {
    dependencies: { "@agent-browser/eve": "0.34.0", "@github-tools/eve-extension": "^0.8.0", ai: "^7.0.105", eve: "0.68.0" },
    overrides: { ai: "^7.0.105" },
    registries: { "@kybernesis": "https://registry.kybernesis.ai/r/{name}.json" },
  };
  const first = migrateManifest(pkg, LINE_URL);
  assert.deepEqual(first.moves.map((m) => [m.name, m.from, m.to]), [
    ["@agent-browser/eve", "0.34.0", null],
    ["@github-tools/eve-extension", "^0.8.0", "0.8.1"],
    ["ai", "^7.0.105", "^7.0.137"],
  ]);
  assert.deepEqual(pkg.dependencies, { "@github-tools/eve-extension": "0.8.1", ai: "^7.0.137", eve: "0.68.0" });
  assert.equal(pkg.overrides.ai, "^7.0.137");
  assert.equal(pkg.registries["@kybernesis"], LINE_URL);

  const again = migrateManifest(pkg, LINE_URL);
  assert.deepEqual(again, { moves: [], registry: null });
});

test("a registry pointed somewhere of the owner's choosing, and an ai range already high enough, are left alone", () => {
  const pkg = { dependencies: { ai: "^7.1.0" }, registries: { "@kybernesis": "https://example.test/{name}.json" } };
  assert.deepEqual(migrateManifest(pkg, LINE_URL), { moves: [], registry: null });
});

// The registry's eve 0.68 copy of the vault item's tool, exactly.
const VAULT_TOOL_068 = `import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { REQUEST_VAULT_ITEM_DESCRIPTION, interpretVaultAnswer, vaultItemAsk } from "@kybernesis/vault/ask";

// Ask the person for a login, card or address that is not in their vault.
// Parks durably; Studio shows a form that saves to the vault and hands back an
// item id, other surfaces offer "I'll type it myself" or "Cancel". No secret
// ever passes through the agent. Authored here, not in the package: eve
// compiles "use workflow" from the tool module's source.
export default defineWorkflowTool({
  description: REQUEST_VAULT_ITEM_DESCRIPTION,
  inputSchema: z.object({
    kind: z.enum(["login", "card", "address", "contact"]),
  }),
  async execute(input, ctx) {
    "use workflow";
    const answer = await ctx.ask(vaultItemAsk(input));
    return interpretVaultAnswer(answer);
  },
});
`;

test("sources: the judge, the browser mount, the vault ask tool, and prose naming tools eve no longer has", () => {
  const a = agent({
    "evals/evals.config.ts": "export default { judge: { model: exe.evaluationModel(\"j\") } };\n",
    "agent/extensions/browser.ts": AGENT_BROWSER_MOUNT,
    "agent/subagents/web/extensions/browser.ts": 'import browser from "@agent-browser/eve";\nexport default browser({ headless: false });\n',
    "agent/tools/request_vault_item.ts": VAULT_TOOL_068,
    "agent/skills/recall/SKILL.md": "Use `connection_search` for memory if it is not loaded.\n",
  });
  try {
    const result = migrateSources(a.dir);
    assert.deepEqual(result.updated.sort(), ["agent/tools/request_vault_item.ts", "evals/evals.config.ts"]);
    assert.deepEqual(result.removed, ["agent/extensions/browser.ts"]);
    assert.deepEqual(result.manual.map((m) => m.file).sort(), ["agent/skills/recall/SKILL.md", "agent/subagents/web/extensions/browser.ts"]);
    assert.match(a.read("evals/evals.config.ts"), /exe\.decisionModel\("j"\)/);
    assert.equal(existsSync(join(a.dir, "agent/extensions/browser.ts")), false);

    const tool = a.read("agent/tools/request_vault_item.ts");
    assert.match(tool, /\n {2}async task\(input, ctx\) \{\n {4}"use workflow";/);
    assert.doesNotMatch(tool, /async execute/);
    assert.match(tool, /\/\/ reaches the model later in the conversation\. Parks durably; Studio shows a form/);

    // A second pass finds nothing left to do but the hand-authored files.
    const again = migrateSources(a.dir);
    assert.deepEqual([again.updated, again.removed], [[], []]);
    assert.equal(a.read("agent/tools/request_vault_item.ts"), tool);
  } finally {
    a.cleanup();
  }
});

test("an ask tool that is not the registry's own is not touched", () => {
  const own = VAULT_TOOL_068.replace("@kybernesis/vault/ask", "./my-ask.js");
  const a = agent({ "agent/tools/request_vault_item.ts": own });
  try {
    assert.deepEqual(migrateSources(a.dir).updated, []);
    assert.equal(a.read("agent/tools/request_vault_item.ts"), own);
  } finally {
    a.cleanup();
  }
});

test("the conversation store is copied aside once and can be put back", () => {
  const a = agent({ ".eve/.workflow-data/runs/one.json": "{\"runId\":\"one\"}" });
  try {
    assert.equal(backUpWorkflowStore(a.dir, "0.68"), "copied");
    writeFileSync(join(a.dir, ".eve/.workflow-data/runs/one.json"), "{\"runId\":\"changed\"}");
    assert.equal(backUpWorkflowStore(a.dir, "0.68"), "kept");
    assert.equal(a.read(".eve/.workflow-data.eve-0.68/runs/one.json"), "{\"runId\":\"one\"}");

    rmSync(join(a.dir, ".eve/.workflow-data"), { recursive: true });
    assert.equal(restoreWorkflowStore(a.dir, "0.68"), true);
    assert.equal(a.read(".eve/.workflow-data/runs/one.json"), "{\"runId\":\"one\"}");
    assert.equal(restoreWorkflowStore(a.dir, "0.50"), false);
  } finally {
    a.cleanup();
  }
});

test("an agent with no store has nothing to keep", () => {
  const a = agent({ "package.json": "{}" });
  try {
    assert.equal(backUpWorkflowStore(a.dir, "0.68"), "none");
  } finally {
    a.cleanup();
  }
});

test("doctor reports what the hop would move without moving it", async () => {
  const { lineHopDoctorChecks } = await import("../dist/doctor.js");
  const a = agent({
    "package.json": JSON.stringify({ dependencies: { "@agent-browser/eve": "0.34.0" } }),
    "agent/extensions/browser.ts": AGENT_BROWSER_MOUNT,
  });
  try {
    const labels = lineHopDoctorChecks(a.dir).map((c) => `${c.verdict} ${c.label}`);
    assert.deepEqual(labels, [
      "warn @agent-browser/eve is installed",
      "warn agent/extensions/browser.ts mounts an extension that does not run on eve 0.81.1",
    ]);
    assert.equal(a.read("agent/extensions/browser.ts"), AGENT_BROWSER_MOUNT);
    const clean = agent({ "package.json": "{}" });
    assert.deepEqual(lineHopDoctorChecks(clean.dir), []);
    clean.cleanup();
  } finally {
    a.cleanup();
  }
});
