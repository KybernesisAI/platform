import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const EVE_VERSION = "0.81.1";
/** The npm dist-tag every @kybernesis package carries for EVE_VERSION's line, e.g. `eve-0.81`. */
export const EVE_LINE_TAG = `eve-${EVE_VERSION.split(".").slice(0, 2).join(".")}`;
/**
 * An install spec for a @kybernesis package on the certified line. A hand-written
 * range went stale at the 0.81 cutover (dispatch ^0.7.0 is the 0.68 build, and
 * npm refuses it beside eve 0.81.1), so specs follow EVE_VERSION instead.
 */
export const linePackage = (name: string): string => `@kybernesis/${name}@${EVE_LINE_TAG}`;
/** The registry items built for EVE_VERSION's line; every @kybernesis dep in them is tagged for it. */
export const REGISTRY_URL = "https://registry.kybernesis.ai/r/eve-0.81/{name}.json";
export const DEFAULT_ISSUER = "https://agent.kybernesis.ai";

const TTY = process.stdout.isTTY === true;
export const green = (s: string) => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
export const yellow = (s: string) => (TTY ? `\x1b[33m${s}\x1b[0m` : s);
export const red = (s: string) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
export const bold = (s: string) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
export const dim = (s: string) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);

export function run(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFail?: boolean;
    quiet?: boolean;
    /** Extra environment for this one child; the parent's is inherited underneath. */
    env?: Record<string, string>;
    /** Kill the child after this many milliseconds. A command that cannot finish is a failure, not a wait. */
    timeoutMs?: number;
  },
): boolean {
  if (!options?.quiet) console.log(dim(`  $ ${command} ${args.join(" ")}`));
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    stdio: options?.quiet ? "pipe" : "inherit",
    env: { ...process.env, ...options?.env },
    timeout: options?.timeoutMs,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.error(red(`Command did not finish within ${Math.round((options?.timeoutMs ?? 0) / 60_000)} min and was stopped: ${command} ${args.join(" ")}`));
  }
  const ok = result.status === 0;
  if (!ok && !options?.allowFail) {
    console.error(red(`Command failed: ${command} ${args.join(" ")}`));
    process.exit(1);
  }
  return ok;
}

export function capture(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
): string | null {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return result.status === 0 ? result.stdout : null;
}

let rl: ReturnType<typeof createInterface> | null = null;
export async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${dim(`(${fallback})`)} `)).trim();
  return answer || fallback;
}
export function closePrompts(): void {
  rl?.close();
  rl = null;
}

/** Parse KEY="value" / KEY=value lines from an env file's contents. */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match && !line.trim().startsWith("#")) out[match[1]] = match[2];
  }
  return out;
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
