import { readFileSync } from "node:fs";
import { capture } from "./util.js";
import type { CompiledModelRouting } from "./model-reach.js";

/** Eve 0.49's root default when the compiled config omits the policy. */
export const CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

export type AgentInputLimit =
  | { kind: "explicit-numeric"; value: number }
  | { kind: "explicit-uncapped" }
  | { kind: "inherited"; value: typeof CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION }
  | { kind: "unresolved"; reason: string };

export interface EveInfoInspection {
  diagnostics: { errors: number; warnings: number } | null;
  status: string | null;
  limit: AgentInputLimit;
  modelRouting: CompiledModelRouting;
}

interface EveInfoJson {
  status?: unknown;
  diagnostics?: unknown;
  artifacts?: { compiledManifest?: unknown } | null;
}

/**
 * Read the effective root policy from Eve's compiled artifact, never from
 * authored TypeScript. The 40M fallback is certified only when that artifact
 * truly omits maxInputTokensPerSession.
 */
export function parseEveInfoInspection(
  output: string,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): EveInfoInspection {
  let info: EveInfoJson;
  try {
    info = JSON.parse(output) as EveInfoJson;
  } catch (error) {
    return unresolved(`eve info --json was not valid JSON: ${(error as Error).message}`);
  }

  const diagnostics = parseDiagnostics(info.diagnostics);
  const status = typeof info.status === "string" ? info.status : null;
  const manifestPath = info.artifacts && typeof info.artifacts.compiledManifest === "string"
    ? info.artifacts.compiledManifest
    : null;
  if (!manifestPath) {
    return {
      diagnostics,
      status,
      limit: { kind: "unresolved", reason: "compiled manifest path was unavailable" },
      modelRouting: { kind: "unresolved", reason: "compiled manifest path was unavailable" },
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch (error) {
    return {
      diagnostics,
      status,
      limit: { kind: "unresolved", reason: `compiled manifest could not be read: ${(error as Error).message}` },
      modelRouting: { kind: "unresolved", reason: `compiled manifest could not be read: ${(error as Error).message}` },
    };
  }

  if (!isRecord(manifest) || !isRecord(manifest.config)) {
    return {
      diagnostics,
      status,
      limit: { kind: "unresolved", reason: "compiled root config was unavailable" },
      modelRouting: { kind: "unresolved", reason: "compiled root config was unavailable" },
    };
  }
  const modelRouting = parseModelRouting(manifest.config);
  const limits = manifest.config.limits;
  if (limits === undefined) {
    return inherited(diagnostics, status, modelRouting);
  }
  if (!isRecord(limits)) {
    return { diagnostics, status, limit: { kind: "unresolved", reason: "compiled root limits were malformed" }, modelRouting };
  }
  if (!Object.hasOwn(limits, "maxInputTokensPerSession")) {
    return inherited(diagnostics, status, modelRouting);
  }

  const value = limits.maxInputTokensPerSession;
  if (value === false) return { diagnostics, status, limit: { kind: "explicit-uncapped" }, modelRouting };
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { diagnostics, status, limit: { kind: "explicit-numeric", value }, modelRouting };
  }
  return {
    diagnostics,
    status,
    limit: { kind: "unresolved", reason: "compiled maxInputTokensPerSession was neither a positive number nor false" },
    modelRouting,
  };
}

/** Compile once through Eve's structured info contract and inspect its artifact. */
export function inspectEveAgent(
  cwd: string,
  env?: Record<string, string>,
): EveInfoInspection | null {
  const output = capture("npx", ["eve", "info", "--json"], cwd, env);
  return output === null ? null : parseEveInfoInspection(output);
}

function parseDiagnostics(value: unknown): EveInfoInspection["diagnostics"] {
  if (!isRecord(value)) return null;
  return typeof value.errors === "number" && typeof value.warnings === "number"
    ? { errors: value.errors, warnings: value.warnings }
    : null;
}

function inherited(
  diagnostics: EveInfoInspection["diagnostics"],
  status: string | null,
  modelRouting: CompiledModelRouting,
): EveInfoInspection {
  return {
    diagnostics,
    status,
    limit: { kind: "inherited", value: CERTIFIED_INHERITED_MAX_INPUT_TOKENS_PER_SESSION },
    modelRouting,
  };
}

function parseModelRouting(config: Record<string, unknown>): CompiledModelRouting {
  if (config.dynamicModel !== undefined) {
    return { kind: "unresolved", reason: "the root uses dynamic model selection" };
  }
  const model = config.model;
  if (!isRecord(model) || !isRecord(model.routing)) {
    return { kind: "unresolved", reason: "compiled model routing was unavailable" };
  }
  const routing = model.routing;
  if (routing.kind === "gateway") return { kind: "gateway" };
  if (routing.kind === "external") {
    return {
      kind: "external",
      ...(typeof routing.provider === "string" ? { provider: routing.provider } : {}),
    };
  }
  return { kind: "unresolved", reason: "compiled model routing was unrecognized" };
}

function unresolved(reason: string): EveInfoInspection {
  return {
    diagnostics: null,
    status: null,
    limit: { kind: "unresolved", reason },
    modelRouting: { kind: "unresolved", reason },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
