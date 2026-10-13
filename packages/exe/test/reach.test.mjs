import { test } from "node:test";
import assert from "node:assert/strict";
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
