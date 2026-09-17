import { parseEnv } from "./util.js";

/**
 * Environment values that are used to build a URL, and whether they can be.
 *
 * An SDK handed `POSTHOG_HOST=eu.i.posthog.com` does not complain at start. It
 * fails once per turn, forever, inside a background drain: `Failed to parse URL
 * from eu.i.posthog.com/batch/`. On the reference fleet that was 121 logged
 * failures and every analytics event of the deployment silently discarded,
 * while the agent itself looked perfectly healthy. Nothing surfaces it because
 * nothing that matters to the turn depends on it.
 *
 * Hence checking the SHAPE of the value at rest, which costs nothing and finds
 * it before a client's first turn.
 */

/**
 * Names whose value is unambiguously a whole URL.
 *
 * `_HOST` is deliberately NOT here: plenty of them legitimately hold a bare
 * hostname (`SMTP_HOST`, `PGHOST`, `REDIS_HOST`), and flagging those would make
 * doctor cry wolf on a correct config.
 */
const URL_SUFFIXES = ["_URL", "_ENDPOINT", "_ISSUER"] as const;

/**
 * `_HOST` names that specific SDKs use as a base URL, so they do need a scheme.
 * An allowlist rather than a rule, because only the SDK knows which it is.
 */
const BASE_URL_HOSTS = new Set(["POSTHOG_HOST"]);

/** Does this name hold a whole URL? */
export function expectsUrl(name: string): boolean {
  if (BASE_URL_HOSTS.has(name)) return true;
  return URL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export type EnvUrlProblem = {
  readonly name: string;
  /** Why it cannot be used to build a request. Never includes the value. */
  readonly reason: "no scheme" | "not a url" | "not http(s)";
  readonly fix: string;
};

/**
 * Check one value. Returns undefined when it is fine.
 *
 * The value never appears in the result: these files sit beside real secrets
 * and a diagnostic that echoes them turns a config warning into a leak.
 */
export function checkEnvUrl(name: string, value: string): EnvUrlProblem | undefined {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // A bare host is by far the common case, and the remedy differs from junk.
    const bare = /^[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(trimmed);
    return {
      name,
      reason: bare ? "no scheme" : "not a url",
      fix: bare
        ? `${name} has no scheme, so anything built from it fails to parse. Prefix it with https://`
        : `${name} is not a URL. Set it to an absolute https:// URL.`,
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      name,
      reason: "not http(s)",
      fix: `${name} is a ${parsed.protocol.replace(":", "")} URL. Set it to an absolute https:// URL.`,
    };
  }
  return undefined;
}

/** Every URL-shaped value in this env text that cannot build a request. */
export function envUrlProblems(text: string): EnvUrlProblem[] {
  const problems: EnvUrlProblem[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (!expectsUrl(name)) continue;
    const problem = checkEnvUrl(name, value);
    if (problem) problems.push(problem);
  }
  return problems;
}
