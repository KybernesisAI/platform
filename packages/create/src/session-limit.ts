import { isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { capture, EVE_VERSION } from "./util.js";

/** Certified root-session default in Eve 0.49.0. Do not derive this from the model context window. */
export const CERTIFIED_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

export type SessionInputLimit =
  | { status: "verified"; source: "explicit"; value: number | false }
  | { status: "verified"; source: "inherited"; value: number }
  | { status: "unverifiable"; reason: string };

export interface EveManifestInspection {
  diagnostics: { errors: number; warnings: number } | null;
  limit: SessionInputLimit;
}

type EveInfoJson = {
  diagnostics?: { errors?: unknown; warnings?: unknown } | null;
  artifacts?: { compiledManifest?: unknown } | null;
};

export function parseEveManifestInspection(
  infoText: string,
  cwd: string,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): EveManifestInspection {
  let info: EveInfoJson;
  try {
    info = JSON.parse(infoText) as EveInfoJson;
  } catch {
    return { diagnostics: null, limit: { status: "unverifiable", reason: "eve info --json returned invalid JSON" } };
  }
  const diagnostics =
    typeof info.diagnostics?.errors === "number" && typeof info.diagnostics.warnings === "number"
      ? { errors: info.diagnostics.errors, warnings: info.diagnostics.warnings }
      : null;
  const artifact = info.artifacts?.compiledManifest;
  if (typeof artifact !== "string" || artifact.length === 0) {
    return { diagnostics, limit: { status: "unverifiable", reason: "eve info did not report a compiled manifest" } };
  }
  const path = isAbsolute(artifact) ? artifact : resolve(cwd, artifact);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readText(path));
  } catch (error) {
    return {
      diagnostics,
      limit: { status: "unverifiable", reason: `could not read compiled manifest (${(error as Error).message})` },
    };
  }
  const config = typeof manifest === "object" && manifest !== null
    ? (manifest as { config?: unknown }).config
    : undefined;
  const limits = typeof config === "object" && config !== null
    ? (config as { limits?: unknown }).limits
    : undefined;
  const value = typeof limits === "object" && limits !== null
    ? (limits as { maxInputTokensPerSession?: unknown }).maxInputTokensPerSession
    : undefined;
  if (value === undefined) {
    return {
      diagnostics,
      limit: {
        status: "verified",
        source: "inherited",
        value: CERTIFIED_MAX_INPUT_TOKENS_PER_SESSION,
      },
    };
  }
  if (value === false || (typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return { diagnostics, limit: { status: "verified", source: "explicit", value } };
  }
  return {
    diagnostics,
    limit: { status: "unverifiable", reason: "compiled manifest contains an unsupported limit value" },
  };
}

export function inspectEveManifest(
  cwd: string,
  env?: Record<string, string>,
): EveManifestInspection | null {
  const info = capture("npx", ["eve", "info", "--json"], cwd, env);
  return info === null ? null : parseEveManifestInspection(info, cwd);
}

export function formatSessionInputLimit(limit: SessionInputLimit): string {
  const name = "limits.maxInputTokensPerSession";
  if (limit.status === "unverifiable") return `${name} unverifiable (${limit.reason})`;
  if (limit.value === false) return `${name} = uncapped (explicit)`;
  const value = limit.value.toLocaleString("en-US");
  return limit.source === "explicit"
    ? `${name} = ${value} (explicit)`
    : `${name} = ${value} (inherited Eve ${EVE_VERSION} default)`;
}
