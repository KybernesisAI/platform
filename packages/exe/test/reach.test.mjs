import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exeModelReach, resolveExeReach } from "../dist/index.js";

/**
 * The switch exists so an owner can change how an agent reaches its model by
 * writing env through the setup route, never by editing agent/agent.ts. Two
 * things matter: an untouched agent behaves exactly as its scaffold authored,
 * and a switch that cannot work never stops the agent booting, because the
 * route that would switch it back lives inside the agent.
 */

const gatewayDefault = { reach: "gateway", model: "anthropic/claude-sonnet-5" };
const subDefault = { reach: "claude-sub", model: "anthropic/claude-opus-5" };

/** Fake provider factories that record what they were asked to build. */
function providers() {
  const made = [];
  return {
    made,
    createOpenAI: (config) => ({
      chat: (id) => (made.push({ kind: "openai.chat", config, id }), { modelId: id, kind: "openai.chat" }),
      responses: (id) => {
        made.push({ kind: "openai.responses", config, id });
        return {
          specificationVersion: "v3",
          provider: "openai.responses",
          modelId: id,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({}),
        };
      },
    }),
    createAnthropic: (config) => (id) => {
      made.push({ kind: "anthropic", config, id });
      return { modelId: id, kind: "anthropic", doGenerate: async () => ({}), doStream: async () => ({}) };
    },
  };
}

const quiet = { log: () => {} };

test("unset, each scaffold default is built as authored", () => {
  assert.deepEqual(resolveExeReach(gatewayDefault, {}), { reach: "gateway", model: "anthropic/claude-sonnet-5" });
  assert.deepEqual(resolveExeReach(gatewayDefault, { EXE_MODEL: "openai/gpt-5.6-sol" }), {
    reach: "gateway",
    model: "openai/gpt-5.6-sol",
  });
  assert.deepEqual(resolveExeReach(subDefault, { KYB_MODEL_REACH: "  " }), { reach: "claude-sub", model: "claude-opus-5" });
});

test("an empty EXE_MODEL on the gateway still fails at construction, naming the variable", () => {
  const p = providers();
  assert.throws(() => exeModelReach({ ...gatewayDefault, ...p, ...quiet, env: { EXE_MODEL: "" } }), /EXE_MODEL/);
});

test("gateway: Claude goes to Messages with the bare id, everything else to the OpenAI route, 200k window", () => {
  const p = providers();
  const claude = exeModelReach({ ...gatewayDefault, ...p, ...quiet, env: { EXE_LLM_URL: "https://team.int.exe.xyz/v1" } });
  assert.equal(claude.modelContextWindowTokens, 200_000);
  assert.deepEqual(p.made[0], {
    kind: "anthropic",
    config: { baseURL: "https://team.int.exe.xyz/v1", apiKey: "exe-integration" },
    id: "claude-sonnet-5",
  });
  exeModelReach({ ...gatewayDefault, ...p, ...quiet, env: { EXE_MODEL: "openai/gpt-5.6-sol" } });
  assert.equal(p.made[1].kind, "openai.responses");
  assert.equal(p.made[1].config.baseURL, "https://llm.int.exe.xyz/v1");
});

test("claude-sub: the subscription proxy on loopback with the 1M window, whatever EXE_MODEL says", () => {
  const p = providers();
  const built = exeModelReach({
    ...gatewayDefault,
    ...p,
    ...quiet,
    env: { KYB_MODEL_REACH: "claude-sub", EXE_MODEL: "openai/gpt-5.6-sol", CLAUDE_PROXY_PORT: "3444" },
  });
  assert.equal(built.modelContextWindowTokens, 1_000_000);
  assert.deepEqual(p.made[0], {
    kind: "anthropic",
    config: { baseURL: "http://127.0.0.1:3444/v1", apiKey: "claude-subscription-local-proxy" },
    id: "claude-opus-5",
  });
});

test("byok: the provider's own API with the owner's key, chosen by EXE_MODEL's prefix", () => {
  const p = providers();
  exeModelReach({
    ...gatewayDefault,
    ...p,
    ...quiet,
    env: { KYB_MODEL_REACH: "byok", ANTHROPIC_API_KEY: "sk-ant-test" },
  });
  assert.deepEqual(p.made[0], {
    kind: "anthropic",
    config: { baseURL: "https://api.anthropic.com/v1", apiKey: "sk-ant-test" },
    id: "claude-sonnet-5",
  });
  exeModelReach({
    ...subDefault,
    ...p,
    ...quiet,
    env: { KYB_MODEL_REACH: "byok", EXE_MODEL: "openai/gpt-5.6", OPENAI_API_KEY: "sk-test" },
  });
  assert.equal(p.made[1].kind, "openai.responses");
  assert.deepEqual(p.made[1].config, { baseURL: "https://api.openai.com/v1", apiKey: "sk-test" });
  assert.equal(p.made[1].id, "gpt-5.6");
});

test("a switch that cannot work falls back to the default with one warning, never a throw", () => {
  const cases = [
    [{ KYB_MODEL_REACH: "gateway-ish" }, /must be one of gateway, byok, claude-sub/],
    [{ KYB_MODEL_REACH: "byok" }, /needs ANTHROPIC_API_KEY/],
    [{ KYB_MODEL_REACH: "byok", EXE_MODEL: "openai/gpt-5.6" }, /needs OPENAI_API_KEY/],
    [{ KYB_MODEL_REACH: "byok", EXE_MODEL: "xai/grok-5", OPENAI_API_KEY: "sk-test" }, /anthropic\/ or openai\/ prefix/],
  ];
  for (const [env, reason] of cases) {
    const decision = resolveExeReach(subDefault, env);
    assert.equal(decision.reach, "claude-sub");
    assert.match(decision.fallback.reason, reason);

    const p = providers();
    const lines = [];
    const built = exeModelReach({ ...subDefault, ...p, env, log: (line, fallback) => lines.push({ line, fallback }) });
    assert.equal(built.modelContextWindowTokens, 1_000_000);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].fallback, true);
    assert.match(lines[0].line, /Running on the default reach, claude-sub/);
  }
});

test("the boot line never carries a key", () => {
  const p = providers();
  const lines = [];
  exeModelReach({
    ...gatewayDefault,
    ...p,
    env: { KYB_MODEL_REACH: "byok", ANTHROPIC_API_KEY: "sk-ant-secretvalue" },
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /secretvalue/);
});

test("grok-sub: signed in, it runs the Grok subscription with GROK_MODEL and a 400k window", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "https://auth.x.ai::client": { key: "k".repeat(64), expires_at: new Date(Date.now() + 3_600_000).toISOString() } }));
  const p = providers();
  const built = exeModelReach({
    ...gatewayDefault,
    ...p,
    ...quiet,
    env: { KYB_MODEL_REACH: "grok-sub", GROK_MODEL: "grok-4.6-fast", GROK_AUTH_PATH: authPath },
  });
  assert.equal(built.modelContextWindowTokens, 400_000);
  assert.deepEqual(
    p.made.map((m) => [m.kind, m.id, m.config.baseURL]),
    [["openai.chat", "grok-4.6-fast", "https://api.x.ai/v1"]],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("grok-sub without a sign-in boots on the authored route and says why", () => {
  const lines = [];
  const p = providers();
  const decision = resolveExeReach(gatewayDefault, { KYB_MODEL_REACH: "grok-sub", EXE_MODEL: "openai/gpt-6-sol" }, { grok: () => "grok-sub needs a Grok sign-in on this host (grok login), and there is none" });
  assert.equal(decision.reach, "gateway");
  assert.equal(decision.model, "openai/gpt-6-sol");
  assert.match(decision.fallback.reason, /grok login/);
  exeModelReach({
    ...gatewayDefault,
    ...p,
    env: { KYB_MODEL_REACH: "grok-sub", EXE_MODEL: "openai/gpt-6-sol" },
    probes: { grok: () => "no grok login here" },
    log: (line, fallback) => lines.push([line, fallback]),
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0][1], true);
  assert.match(lines[0][0], /KYB_MODEL_REACH=grok-sub not used/);
});

test("grok-sub decision defaults to grok-4.6 when GROK_MODEL is unset", () => {
  assert.deepEqual(resolveExeReach(gatewayDefault, { KYB_MODEL_REACH: "grok-sub" }, { grok: () => true }), {
    reach: "grok-sub",
    model: "grok-4.6",
  });
});

test("chatgpt-sub: with chatgpt passed and a sign-in, it runs eve's chatgpt() with the bare CHATGPT_MODEL", () => {
  const p = providers();
  const asked = [];
  const built = exeModelReach({
    ...gatewayDefault,
    ...p,
    ...quiet,
    chatgpt: (id) => (asked.push(id), { modelId: id, kind: "chatgpt" }),
    probes: { chatgpt: () => true },
    env: { KYB_MODEL_REACH: "chatgpt-sub", CHATGPT_MODEL: "openai/gpt-6-sol" },
  });
  assert.deepEqual(asked, ["gpt-6-sol"]);
  assert.equal(built.model.kind, "chatgpt");
  assert.equal(built.modelContextWindowTokens, 200_000);
  assert.equal(p.made.length, 0);
});

test("chatgpt-sub falls back when the agent does not pass chatgpt, or the host has no codex sign-in", () => {
  const lines = [];
  const p = providers();
  exeModelReach({
    ...gatewayDefault,
    ...p,
    env: { KYB_MODEL_REACH: "chatgpt-sub", EXE_MODEL: "openai/gpt-6-sol" },
    probes: { chatgpt: () => true },
    log: (line) => lines.push(line),
  });
  assert.match(lines[0], /passes chatgpt from eve\/models\/openai/);
  const noLogin = resolveExeReach(
    gatewayDefault,
    { KYB_MODEL_REACH: "chatgpt-sub", EXE_MODEL: "openai/gpt-6-sol", PATH: "/nonexistent", CODEX_HOME: "/nonexistent" },
  );
  assert.equal(noLogin.reach, "gateway");
  assert.match(noLogin.fallback.reason, /codex CLI/);
  assert.deepEqual(resolveExeReach(gatewayDefault, { KYB_MODEL_REACH: "chatgpt-sub" }, { chatgpt: () => true }), {
    reach: "chatgpt-sub",
    model: "gpt-6-sol",
  });
});

test("codex sign-in is read from CODEX_HOME and only a ChatGPT token counts", async () => {
  const { codexSignedIn } = await import("../dist/index.js");
  const dir = mkdtempSync(join(tmpdir(), "codex-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: null }));
  assert.equal(codexSignedIn({ CODEX_HOME: dir }), false);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "a".repeat(40), refresh_token: "r".repeat(40) } }));
  assert.equal(codexSignedIn({ CODEX_HOME: dir }), true);
  rmSync(dir, { recursive: true, force: true });
});

test("CLAUDE_MODEL overrides only the subscription route, not EXE_MODEL", () => {
  const env = { CLAUDE_MODEL: "claude-opus-5-5", EXE_MODEL: "anthropic/claude-sonnet-5" };
  assert.equal(resolveExeReach({ reach: "claude-sub", model: "anthropic/claude-sonnet-5" }, env).model, "claude-opus-5-5");
  assert.equal(resolveExeReach({ reach: "gateway", model: "anthropic/claude-opus-5" }, env).model, "anthropic/claude-sonnet-5");
});
