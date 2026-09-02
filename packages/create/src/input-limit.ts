import { existsSync, readFileSync } from "node:fs";
import { captureResult, type CaptureResult } from "./util.js";

export const EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

export type EffectiveInputLimit =
  | { kind: "numeric"; value: number; inherited: boolean }
  | { kind: "uncapped"; inherited: false }
  | { kind: "unresolved"; reason: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Resolve the root limit from eve's compiled manifest, never source regexes. */
export function resolveEffectiveInputLimit(manifest: unknown): EffectiveInputLimit {
  if (!isPlainObject(manifest)) {
    return { kind: "unresolved", reason: "compiled manifest is not an object" };
  }
  const config = manifest.config;
  if (!isPlainObject(config)) {
    return { kind: "unresolved", reason: "compiled manifest has no root config" };
  }
  const limits = config.limits;
  if (limits === undefined) {
    return { kind: "numeric", value: EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION, inherited: true };
  }
  if (!isPlainObject(limits)) {
    return { kind: "unresolved", reason: "compiled root limits are malformed" };
  }
  const value = limits.maxInputTokensPerSession;
  if (value === undefined) {
    return { kind: "numeric", value: EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION, inherited: true };
  }
  if (value === false) return { kind: "uncapped", inherited: false };
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { kind: "numeric", value, inherited: false };
  }
  return { kind: "unresolved", reason: "maxInputTokensPerSession is neither a number nor false" };
}

export function formatEffectiveInputLimit(limit: EffectiveInputLimit): string {
  if (limit.kind === "unresolved") return `session input limit unresolved (${limit.reason})`;
  if (limit.kind === "uncapped") return "session input limit: uncapped (explicit false)";
  return `session input limit: ${limit.value.toLocaleString("en-US")} input tokens (${limit.inherited ? "inherited eve default" : "explicit"})`;
}

export interface EveInfoJson {
  diagnostics: { errors: number; warnings: number } | null;
  artifacts: { compiledManifest: string } | null;
}

export function parseEveInfoJson(text: string): EveInfoJson | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return null;

    const diagnostics = value.diagnostics;
    const validDiagnostics = diagnostics === null || (
      isPlainObject(diagnostics) &&
      Number.isInteger(diagnostics.errors) && Number(diagnostics.errors) >= 0 &&
      Number.isInteger(diagnostics.warnings) && Number(diagnostics.warnings) >= 0
    );
    const artifacts = value.artifacts;
    const validArtifacts = artifacts === null || (
      isPlainObject(artifacts) && typeof artifacts.compiledManifest === "string"
    );
    if (!validDiagnostics || !validArtifacts) return null;
    return {
      diagnostics: diagnostics === null
        ? null
        : { errors: Number(diagnostics.errors), warnings: Number(diagnostics.warnings) },
      artifacts: artifacts === null
        ? null
        : { compiledManifest: String(artifacts.compiledManifest) },
    };
  } catch {
    return null;
  }
}

export function readEffectiveInputLimit(info: EveInfoJson | null): EffectiveInputLimit {
  const path = info?.artifacts?.compiledManifest;
  if (!path) return { kind: "unresolved", reason: "eve discovery did not provide a compiled manifest" };
  if (!existsSync(path)) return { kind: "unresolved", reason: `compiled manifest not found at ${path}` };
  try {
    return resolveEffectiveInputLimit(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return { kind: "unresolved", reason: `could not read compiled manifest: ${(error as Error).message}` };
  }
}

type CaptureEveInfo = (
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
) => CaptureResult;

function commandFailure(result: CaptureResult): string {
  const detail = (result.stderr || result.error || result.stdout).trim().replace(/\s+/g, " ").slice(0, 500);
  return detail ? `eve info failed: ${detail}` : `eve info failed with status ${result.status ?? "unknown"}`;
}

export function discoverEffectiveInputLimit(
  cwd: string,
  env?: Record<string, string>,
  captureEveInfo: CaptureEveInfo = captureResult,
): { info: EveInfoJson | null; limit: EffectiveInputLimit } {
  const output = captureEveInfo("npx", ["eve", "info", "--json"], cwd, env);
  if (output.status !== 0) {
    return { info: null, limit: { kind: "unresolved", reason: commandFailure(output) } };
  }
  const info = parseEveInfoJson(output.stdout);
  if (info === null) {
    return {
      info: null,
      limit: { kind: "unresolved", reason: "eve info returned JSON with an unexpected shape" },
    };
  }
  return { info, limit: readEffectiveInputLimit(info) };
}
