import { existsSync, readFileSync } from "node:fs";
import { capture } from "./util.js";

export const EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

export type EffectiveInputLimit =
  | { kind: "numeric"; value: number; inherited: boolean }
  | { kind: "uncapped"; inherited: false }
  | { kind: "unresolved"; reason: string };

/** Resolve the root limit from eve's compiled manifest, never source regexes. */
export function resolveEffectiveInputLimit(manifest: unknown): EffectiveInputLimit {
  if (!manifest || typeof manifest !== "object") {
    return { kind: "unresolved", reason: "compiled manifest is not an object" };
  }
  const config = Reflect.get(manifest, "config");
  if (!config || typeof config !== "object") {
    return { kind: "unresolved", reason: "compiled manifest has no root config" };
  }
  const limits = Reflect.get(config, "limits");
  if (limits === undefined) {
    return { kind: "numeric", value: EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION, inherited: true };
  }
  if (!limits || typeof limits !== "object") {
    return { kind: "unresolved", reason: "compiled root limits are malformed" };
  }
  const value = Reflect.get(limits, "maxInputTokensPerSession");
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
    const value = JSON.parse(text) as EveInfoJson;
    return value && typeof value === "object" ? value : null;
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

export function discoverEffectiveInputLimit(
  cwd: string,
  env?: Record<string, string>,
): { info: EveInfoJson | null; limit: EffectiveInputLimit } {
  const output = capture("npx", ["eve", "info", "--json"], cwd, env);
  const info = output === null ? null : parseEveInfoJson(output);
  return { info, limit: readEffectiveInputLimit(info) };
}
