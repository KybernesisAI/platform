import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface DurableRunInspection {
  runningRunIds: string[];
  inspectedRecords: number;
  issues: string[];
}

export interface BuzzSessionMatch {
  runId: string;
  community: string;
  channel: string;
}

export interface BuzzSessionInspection {
  path?: string;
  matches: BuzzSessionMatch[];
  issue?: string;
}

export type EvalScriptReconciliation =
  | { kind: "updated"; script: string }
  | { kind: "current"; script: string }
  | { kind: "custom"; script: string }
  | { kind: "missing" };

/** Read the local durable records without loading eve or mutating its store. */
export function inspectDurableRuns(cwd: string): DurableRunInspection {
  const runsDir = join(cwd, ".eve", ".workflow-data", "runs");
  if (!existsSync(runsDir)) return { runningRunIds: [], inspectedRecords: 0, issues: [] };

  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    return {
      runningRunIds: [],
      inspectedRecords: 0,
      issues: [`could not read ${runsDir}: ${(error as Error).message}`],
    };
  }

  const runningRunIds: string[] = [];
  const issues: string[] = [];
  let inspectedRecords = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(runsDir, entry.name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { runId?: unknown; status?: unknown };
      inspectedRecords += 1;
      if (record.status !== "running") continue;
      if (typeof record.runId !== "string" || record.runId.length === 0) {
        issues.push(`${path}: running record has no string runId`);
        continue;
      }
      runningRunIds.push(record.runId);
    } catch (error) {
      issues.push(`${path}: ${(error as Error).message}`);
    }
  }

  return { runningRunIds, inspectedRecords, issues };
}

function resolveEnvPath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Follow the same precedence as buzzBridge when enough environment is available. */
export function buzzSessionsPath(cwd: string, env: Record<string, string | undefined>): string | undefined {
  if (env.BUZZ_SESSIONS_FILE) return resolveEnvPath(cwd, env.BUZZ_SESSIONS_FILE);
  const legacy = join(cwd, ".buzz-sessions.json");
  if (existsSync(legacy)) return legacy;
  if (env.BUZZ_KEYFILE) return join(dirname(resolveEnvPath(cwd, env.BUZZ_KEYFILE)), "buzz-sessions.json");
  return undefined;
}

/** Best-effort join from durable run ids to Buzz's persisted community|channel map. */
export function inspectBuzzSessions(
  cwd: string,
  env: Record<string, string | undefined>,
  runningRunIds: readonly string[],
): BuzzSessionInspection {
  const path = buzzSessionsPath(cwd, env);
  if (!path) {
    return { matches: [], issue: "no BUZZ_SESSIONS_FILE, legacy .buzz-sessions.json, or BUZZ_KEYFILE was found" };
  }
  if (!existsSync(path)) return { path, matches: [], issue: `${path} does not exist` };

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object map");
    const running = new Set(runningRunIds);
    const matches: BuzzSessionMatch[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const runId = (value as { id?: unknown }).id;
      if (typeof runId !== "string" || !running.has(runId)) continue;
      const separator = key.lastIndexOf("|");
      matches.push({
        runId,
        community: separator < 0 ? "unknown community" : key.slice(0, separator),
        channel: separator < 0 ? key : key.slice(separator + 1),
      });
    }
    return { path, matches };
  } catch (error) {
    return { path, matches: [], issue: `could not read Buzz session metadata at ${path}: ${(error as Error).message}` };
  }
}

/** Replace only a simple direct eve eval invocation, preserving assignments and arguments. */
export function reconcileEvalScript(script: unknown): EvalScriptReconciliation {
  if (typeof script !== "string" || script.trim().length === 0) return { kind: "missing" };
  if (/^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*kyb-eval(?:\s|$)/.test(script)) {
    return { kind: "current", script };
  }
  if (/[;&|<>`]/.test(script)) return { kind: "custom", script };
  const direct = /^(\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*)eve\s+eval(?=\s|$)(.*)$/.exec(script);
  if (!direct) return { kind: "custom", script };
  return { kind: "updated", script: `${direct[1]}kyb-eval${direct[2]}` };
}

export async function confirmEveUpgrade(options: {
  yes: boolean;
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
}): Promise<boolean> {
  if (options.yes) return true;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true) return false;

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Continue with the eve upgrade? Type yes to continue: ")).trim().toLowerCase();
    return answer === "yes" || answer === "y";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
