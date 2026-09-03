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
  if (model !== CLAUDE_SUBSCRIPTION_MODEL) {
    throw new Error(
      `Model reach claude-sub currently supports only ${CLAUDE_SUBSCRIPTION_MODEL}. ` +
        "That is the model covered by @kybernesis/exe's certified context-window constant; use a bare Anthropic id.",
    );
  }
  return { reach, model };
}

/**
 * Classify the effective route from stable authored helpers first, then Eve's
 * compiled routing. Provider=anthropic alone is not evidence of a subscription.
 */
export function classifyModelReach(
  authoredSource: string | null,
  compiledRouting: CompiledModelRouting,
): DoctorModelReach {
  if (authoredSource !== null) {
    const claudeSubscription = /\bclaudeSubscription\s*\(/.test(authoredSource);
    const exeModel = /\bexeModel\s*\(/.test(authoredSource);
    if (claudeSubscription && !exeModel) return { kind: "claude-sub" };
    if (exeModel && !claudeSubscription) return { kind: "exe" };
    if (claudeSubscription && exeModel) {
      return { kind: "unresolved", reason: "root agent authors both claudeSubscription() and exeModel()" };
    }
  }

  if (compiledRouting.kind === "gateway") return { kind: "gateway" };
  if (compiledRouting.kind === "external") {
    return { kind: "direct-provider", ...(compiledRouting.provider ? { provider: compiledRouting.provider } : {}) };
  }
  return { kind: "unresolved", reason: compiledRouting.reason };
}
