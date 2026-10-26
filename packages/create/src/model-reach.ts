import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostKind } from "./templates.js";

export const MODEL_REACH_ENV = "KYB_MODEL_REACH";
export const CLAUDE_SUBSCRIPTION_MODEL = "claude-opus-5";

export type ScaffoldModelReach = "default" | "claude-sub";

export interface ModelScaffoldConfig {
  reach: ScaffoldModelReach;
  model: string;
}

export type CompiledModelRouting =
  | { kind: "gateway" }
  | { kind: "external"; provider?: string }
  | { kind: "unresolved"; reason: string };

export type DoctorModelReach =
  | { kind: "claude-sub" }
  | { kind: "exe" }
  | { kind: "grok-sub" }
  | { kind: "chatgpt-sub" }
  | { kind: "gateway" }
  | { kind: "direct-provider"; provider?: string }
  | { kind: "unresolved"; reason: string };

/** Resolve the one-shot scaffold selector. An explicit CLI value wins over Factory env. */
export function resolveModelReach(cliValue?: string, envValue?: string): ScaffoldModelReach {
  const selected = cliValue !== undefined ? cliValue : envValue;
  if (selected === undefined) return "default";
  if (selected.trim() === "" && cliValue === undefined) return "default";
  if (selected.trim() === "claude-sub") return "claude-sub";
  throw new Error(
    `Unsupported model reach ${JSON.stringify(selected)}. Supported values: claude-sub (or omit it for the host default).`,
  );
}

/** Validate host/model compatibility before eve creates any files. */
export function resolveModelScaffold(options: {
  host: HostKind;
  cliReach?: string;
  envReach?: string;
  model?: string;
}): ModelScaffoldConfig {
  const reach = resolveModelReach(options.cliReach, options.envReach);
  if (reach === "default") {
    return { reach, model: options.model ?? "anthropic/claude-sonnet-5" };
  }

  if (options.host !== "exe") {
    throw new Error(
      "Model reach claude-sub requires --host=exe because its OAuth proxy runs on the same machine as the agent.",
    );
  }

  const model = (options.model ?? CLAUDE_SUBSCRIPTION_MODEL).replace(/^anthropic\//, "");
  if (!/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model)) {
    throw new Error("Claude subscription requires a bare Anthropic model id (claude-...), not a gateway id.");
  }
  return { reach, model };
}

/**
 * The route an `exeModelReach` agent takes at boot: KYB_MODEL_REACH when it is
 * one that can run, else the authored `reach`. The same rules as
 * `resolveExeReach` in @kybernesis/exe (declared here so create keeps zero
 * runtime deps); change both together.
 */
export function switchedModelReach(source: string, env: Record<string, string | undefined>): DoctorModelReach | null {
  if (!/\bexeModelReach\s*\(/.test(source)) return null;
  const authored = /\breach\s*:\s*["'](gateway|byok|claude-sub|grok-sub|chatgpt-sub)["']/.exec(source)?.[1];
  if (!authored) return { kind: "unresolved", reason: "exeModelReach has no literal default reach to read" };
  const model = env.EXE_MODEL ?? /\bmodel\s*:\s*["']([^"']+)["']/.exec(source)?.[1] ?? "";
  const route = (reach: string): DoctorModelReach | null => {
    if (reach === "gateway") return { kind: "exe" };
    if (reach === "claude-sub") return { kind: "claude-sub" };
    // Runs only once `grok login` has left a credential; the agent falls back otherwise.
    if (reach === "grok-sub") {
      const auth = env.GROK_AUTH_PATH?.trim() || join(homedir(), ".grok", "auth.json");
      return existsSync(auth) ? { kind: "grok-sub" } : null;
    }
    // Needs eve's chatgpt passed in, and a Codex sign-in on the host.
    if (reach === "chatgpt-sub") {
      if (!/\bchatgpt\s*[,}]/.test(source)) return null;
      const auth = join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
      return existsSync(auth) ? { kind: "chatgpt-sub" } : null;
    }
    if (reach !== "byok") return null;
    const provider = /^(anthropic|openai)\//.exec(model)?.[1];
    if (!provider) return null;
    return env[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]?.trim()
      ? { kind: "direct-provider", provider }
      : null;
  };
  const requested = env[MODEL_REACH_ENV]?.trim();
  const chosen = requested ? route(requested) : null;
  return chosen ?? route(authored) ?? { kind: "direct-provider", ...(/^(anthropic|openai)\//.exec(model) ? { provider: model.split("/")[0] } : {}) };
}

/**
 * Classify the effective route from stable authored helpers first, then Eve's
 * compiled routing. Provider=anthropic alone is not evidence of a subscription.
 */
export function classifyModelReach(
  authoredSource: string | null,
  compiledRouting: CompiledModelRouting,
  env: Record<string, string | undefined> = {},
): DoctorModelReach {
  if (authoredSource !== null) {
    const switched = switchedModelReach(authoredSource, env);
    if (switched) return switched;
    const claudeSubscription = /\bclaudeSubscription\s*\(/.test(authoredSource);
    const exeModel = /\bexeModel\s*\(/.test(authoredSource);
    const grokSubscription = /\bgrokSubscription\s*\(/.test(authoredSource);
    const authored = [claudeSubscription, exeModel, grokSubscription].filter(Boolean).length;
    if (authored === 1 && claudeSubscription) return { kind: "claude-sub" };
    if (authored === 1 && exeModel) return { kind: "exe" };
    if (authored === 1 && grokSubscription) return { kind: "grok-sub" };
    if (authored > 1) {
      return { kind: "unresolved", reason: "root agent authors more than one model reach helper" };
    }
  }

  if (compiledRouting.kind === "gateway") return { kind: "gateway" };
  if (compiledRouting.kind === "external") {
    return { kind: "direct-provider", ...(compiledRouting.provider ? { provider: compiledRouting.provider } : {}) };
  }
  return { kind: "unresolved", reason: compiledRouting.reason };
}
