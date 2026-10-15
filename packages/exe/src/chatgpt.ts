import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * A ChatGPT subscription on a host, through the Codex CLI's own sign-in.
 *
 * eve's `chatgpt()` (from `eve/models/openai`) bills a ChatGPT plan: when the
 * `codex` binary is on PATH it asks `codex app-server` for the current token,
 * and Codex owns the credential and its refresh. On a headless VM the sign-in
 * is `codex login --device-auth`, which writes `$CODEX_HOME/auth.json`
 * (default ~/.codex). Both halves have to be on the host the agent runs on: the
 * binary on the service's PATH, and the sign-in in the service user's home.
 * Without the binary eve falls back to a browser sign-in nobody can do on a VM.
 */

type Env = Record<string, string | undefined>;

/** Where Codex keeps its sign-in. */
export function codexAuthPath(env: Env = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

/** Whether `codex login` has left a ChatGPT sign-in (not an API key) on this host. */
export function codexSignedIn(env: Env = process.env): boolean {
  try {
    const parsed = JSON.parse(readFileSync(codexAuthPath(env), "utf8")) as { tokens?: Record<string, unknown> | null };
    const tokens = parsed.tokens;
    return Boolean(tokens && typeof tokens === "object" && Object.values(tokens).some((v) => typeof v === "string" && v.length > 20));
  } catch {
    return false;
  }
}

/** The `codex` binary eve will run, found the way a spawn finds it: on PATH. */
export function codexOnPath(env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
