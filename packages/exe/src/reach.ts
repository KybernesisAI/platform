/**
 * Model reach chosen at boot, from the environment.
 *
 * An exe host can reach its model three ways: the exe LLM gateway (the
 * integration holds the credential), the owner's own provider key, or a Claude
 * subscription through the loopback OAuth proxy. Each used to be a different
 * `agent/agent.ts`, so changing it meant editing source on the host and
 * rebuilding. That is not something a person setting an agent up from a phone
 * can do, and the setup route deliberately writes env values, never code.
 *
 * {@link exeModelReach} reads `KYB_MODEL_REACH` once at boot and builds the
 * matching model. Unset, it builds what the scaffold authored, so an agent
 * nobody has touched behaves exactly as before.
 *
 * ```ts title="agent/agent.ts"
 * import { defineAgent } from "eve";
 * import { createAnthropic } from "@ai-sdk/anthropic";
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { exeModelReach } from "@kybernesis/exe";
 *
 * export default defineAgent({
 *   ...exeModelReach({ reach: "gateway", model: "anthropic/claude-sonnet-5", createOpenAI, createAnthropic }),
 *   limits: { maxInputTokensPerSession: false },
 * });
 * ```
 *
 * ## A bad switch never takes the agent down
 *
 * The setup route lives inside the agent. A requested reach that cannot work
 * (an unknown value, a key that is not there) falls back to the authored
 * default with one loud log line, rather than throwing at boot: a thrown error
 * under systemd is an agent that never starts, and an agent that never starts
 * cannot be told to switch back. The setup status route reports the same
 * decision from the same rules, so the owner sees what is actually running.
 */

import { CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW, claudeSubscription } from "./claude.js";
import { exeModel } from "./model.js";

/** The env variable the switch reads. The same name `kyb init` reads for its one-shot scaffold choice. */
export const MODEL_REACH_ENV = "KYB_MODEL_REACH";

/**
 * - `gateway`: the exe LLM integration, `EXE_MODEL` (provider-prefixed).
 * - `byok`: the provider's own API, with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
 *   chosen by `EXE_MODEL`'s prefix (`anthropic/…` or `openai/…`).
 * - `claude-sub`: a Claude subscription through the loopback proxy.
 */
export type ExeModelReach = "gateway" | "byok" | "claude-sub";

export const EXE_MODEL_REACHES: readonly ExeModelReach[] = ["gateway", "byok", "claude-sub"];

/** The model id a Claude subscription runs, matching {@link CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW}. */
export const CLAUDE_SUBSCRIPTION_DEFAULT_MODEL = "claude-opus-5";

/** Context window declared on the gateway and BYOK routes; the scaffold's long-standing value. */
export const EXE_DEFAULT_CONTEXT_WINDOW = 200_000;

type Env = Record<string, string | undefined>;

export interface ExeReachDefaults {
  /** The reach used when `KYB_MODEL_REACH` is unset or empty: what the scaffold authored. */
  reach: ExeModelReach;
  /**
   * Provider-prefixed id for the gateway and BYOK routes when `EXE_MODEL` is
   * unset (e.g. `anthropic/claude-sonnet-5`).
   */
  model: string;
  /** Bare Claude id for the subscription route. Defaults to {@link CLAUDE_SUBSCRIPTION_DEFAULT_MODEL}. */
  claudeModel?: string;
}

/** What the switch decided, and why, without building anything. */
export interface ExeReachDecision {
  reach: ExeModelReach;
  /** The id handed to the provider route (prefixed for gateway, bare for the others). */
  model: string;
  /** For BYOK, which provider key it uses. */
  provider?: "anthropic" | "openai";
  /** Set when `KYB_MODEL_REACH` asked for something else and the default was used instead. */
  fallback?: { requested: string; reason: string };
}

function byokRoute(model: string, env: Env): { provider: "anthropic" | "openai"; id: string } | string {
  const match = /^(anthropic|openai)\/(.+)$/.exec(model);
  if (!match) return `byok needs EXE_MODEL with an anthropic/ or openai/ prefix, and it is ${JSON.stringify(model)}`;
  const provider = match[1] as "anthropic" | "openai";
  const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!env[key]?.trim()) return `byok on ${model} needs ${key}, and it is not set`;
  return { provider, id: match[2] };
}

/**
 * Decide the reach from the environment. Pure: the same rules the setup status
 * route mirrors, testable without a provider.
 *
 * `EXE_MODEL` keeps its existing meaning on the gateway: only an unset value
 * falls back to the default, so an empty one still fails at construction with
 * the message that names it.
 */
export function resolveExeReach(defaults: ExeReachDefaults, env: Env = process.env): ExeReachDecision {
  const claudeModel = defaults.claudeModel ?? CLAUDE_SUBSCRIPTION_DEFAULT_MODEL;
  const requested = env[MODEL_REACH_ENV]?.trim() ?? "";

  const decide = (reach: ExeModelReach): ExeReachDecision | string => {
    if (reach === "claude-sub") return { reach, model: claudeModel };
    const model = env.EXE_MODEL ?? defaults.model;
    if (reach === "gateway") return { reach, model };
    const route = byokRoute(model, env);
    return typeof route === "string" ? route : { reach, model: route.id, provider: route.provider };
  };

  if (requested && requested !== defaults.reach) {
    if (!(EXE_MODEL_REACHES as readonly string[]).includes(requested)) {
      const fallback = { requested, reason: `${MODEL_REACH_ENV} must be one of ${EXE_MODEL_REACHES.join(", ")}` };
      return { ...fallbackDecision(defaults, env, claudeModel), fallback };
    }
    const chosen = decide(requested as ExeModelReach);
    if (typeof chosen !== "string") return chosen;
    return { ...fallbackDecision(defaults, env, claudeModel), fallback: { requested, reason: chosen } };
  }
  return fallbackDecision(defaults, env, claudeModel);
}

/**
 * The authored default, built as authored. A misconfigured default is not
 * second-guessed: it fails the way it always did, per turn or at construction.
 */
function fallbackDecision(defaults: ExeReachDefaults, env: Env, claudeModel: string): ExeReachDecision {
  if (defaults.reach === "claude-sub") return { reach: "claude-sub", model: claudeModel };
  const model = env.EXE_MODEL ?? defaults.model;
  if (defaults.reach === "gateway") return { reach: "gateway", model };
  const match = /^(anthropic|openai)\/(.+)$/.exec(model);
  return match
    ? { reach: "byok", model: match[2], provider: match[1] as "anthropic" | "openai" }
    : { reach: "byok", model, provider: "openai" };
}

type ProviderFactory<TProvider> = (config: { baseURL: string; apiKey: string }) => TProvider;

export interface ExeModelReachOptions<TModel> extends ExeReachDefaults {
  /** `createOpenAI` from `@ai-sdk/openai`: gateway non-Claude ids and BYOK OpenAI. */
  createOpenAI: ProviderFactory<{ chat: (model: string) => TModel; responses: (model: string) => TModel }>;
  /** `createAnthropic` from `@ai-sdk/anthropic`: gateway Claude ids, BYOK Anthropic, the subscription. */
  createAnthropic: ProviderFactory<(model: string) => TModel>;
  /** Defaults to `process.env`; for tests. */
  env?: Env;
  /** Where the one boot line goes. Defaults to `console.warn` for a fallback and `console.info` otherwise. */
  log?: (line: string, fallback: boolean) => void;
}

/**
 * The model and its declared window, for spreading into `defineAgent`.
 *
 * Returns both because they belong together: a Claude subscription declares
 * the model's real 1M window, the other routes the scaffold's 200k.
 */
export function exeModelReach<TModel>(options: ExeModelReachOptions<TModel>): {
  model: TModel;
  modelContextWindowTokens: number;
} {
  const env = options.env ?? process.env;
  const decision = resolveExeReach(options, env);
  const log =
    options.log ?? ((line: string, fallback: boolean) => (fallback ? console.warn(line) : console.info(line)));
  if (decision.fallback) {
    log(
      `[exe] ${MODEL_REACH_ENV}=${decision.fallback.requested} not used: ${decision.fallback.reason}. ` +
        `Running on the default reach, ${decision.reach} (${decision.model}).`,
      true,
    );
  } else {
    log(`[exe] model reach: ${decision.reach} (${decision.model})`, false);
  }

  switch (decision.reach) {
    case "claude-sub": {
      const port = env.CLAUDE_PROXY_PORT?.trim();
      return {
        model: claudeSubscription({
          model: decision.model,
          createAnthropic: options.createAnthropic,
          ...(port ? { baseURL: `http://127.0.0.1:${port}/v1` } : {}),
        }),
        modelContextWindowTokens: CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW,
      };
    }
    case "byok": {
      const model =
        decision.provider === "anthropic"
          ? options.createAnthropic({ baseURL: "https://api.anthropic.com/v1", apiKey: env.ANTHROPIC_API_KEY ?? "" })(
              decision.model,
            )
          : options.createOpenAI({ baseURL: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY ?? "" }).responses(
              decision.model,
            );
      return { model, modelContextWindowTokens: EXE_DEFAULT_CONTEXT_WINDOW };
    }
    case "gateway":
      return {
        model: exeModel({
          model: decision.model,
          baseURL: env.EXE_LLM_URL || "https://llm.int.exe.xyz/v1",
          createOpenAI: options.createOpenAI,
          createAnthropic: options.createAnthropic,
        }),
        modelContextWindowTokens: EXE_DEFAULT_CONTEXT_WINDOW,
      };
  }
}
