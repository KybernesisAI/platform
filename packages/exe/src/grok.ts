import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Grok on a SuperGrok / X Premium+ subscription, not on token-billed API keys.
 *
 * `grok login` (xAI's Grok Build CLI) performs a device OAuth and writes an
 * OIDC credential to ~/.grok/auth.json. That credential is a valid bearer for
 * https://api.x.ai/v1 — the ordinary OpenAI-compatible surface — and requests
 * made with it bill the subscription rather than metered API usage.
 *
 * This mirrors eve's own `experimental_chatgpt()`, which reads a `codex login`
 * to bill a ChatGPT subscription. Same shape, different vendor: the thing that
 * makes it possible is a local login, and the thing that makes it useful is
 * that the endpoint is standard.
 *
 * ```ts title="agent/agent.ts"
 * import { defineAgent } from "eve";
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { grokSubscription } from "@kybernesis/exe";
 *
 * export default defineAgent({
 *   model: grokSubscription({ model: "grok-4.6", createOpenAI }),
 *   modelContextWindowTokens: 400_000,
 * });
 * ```
 */

export interface GrokSubscriptionOptions<TModel> {
  /** Model id, e.g. `"grok-4.6"`. Bare xAI ids, not gateway-prefixed. */
  model: string;
  /** Where `grok login` stored its credential. Defaults to ~/.grok/auth.json. */
  authPath?: string;
  /** xAI API base. Rarely changed. */
  baseURL?: string;
  /**
   * Keep the credential alive by running the Grok CLI when it is close to
   * expiring. Defaults to true; pass false where the host refreshes it some
   * other way (a cron, a supervisor).
   *
   * Set `grokBinary` if the CLI is not on PATH — the installer puts it in
   * ~/.grok/bin, which a service process's PATH usually does not include.
   */
  autoRefresh?: boolean;
  /** Path to the `grok` binary. Defaults to ~/.grok/bin/grok, then PATH. */
  grokBinary?: string;
  /** `createOpenAI` from `@ai-sdk/openai`, passed in so this package pins no provider version. */
  createOpenAI: (config: {
    baseURL: string;
    apiKey: string;
    fetch?: typeof globalThis.fetch;
  }) => { chat: (model: string) => TModel };
}

interface StoredCredential {
  key?: string;
  expires_at?: string;
  email?: string;
}

/**
 * Read the credential the CLI wrote.
 *
 * The file is keyed by issuer and client id rather than by a fixed name, so the
 * entry is found by shape — the first record carrying a key — instead of by a
 * path that a CLI update would quietly change.
 */
export function readGrokCredential(authPath?: string): {
  key: string;
  email?: string;
  expiresAt?: Date;
} {
  const path = authPath ?? join(homedir(), ".grok", "auth.json");

  let parsed: Record<string, StoredCredential>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCredential>;
  } catch {
    throw new Error(
      `No Grok credential at ${path}. Run \`grok login\` on this machine to sign in with a ` +
        `SuperGrok or X Premium+ subscription.`,
    );
  }

  const entry = Object.values(parsed).find((v) => typeof v?.key === "string" && v.key.length > 40);
  if (!entry?.key) {
    throw new Error(`No usable credential in ${path}. Run \`grok login\` again.`);
  }

  const expiresAt = entry.expires_at ? new Date(entry.expires_at) : undefined;
  return { key: entry.key, email: entry.email, expiresAt };
}

/** Where the installer puts the CLI, which a service process rarely has on PATH. */
function grokBinaryPath(explicit?: string): string {
  if (explicit) return explicit;
  const installed = join(homedir(), ".grok", "bin", "grok");
  return existsSync(installed) ? installed : "grok";
}

/**
 * Refresh the credential by asking the CLI to do it.
 *
 * The token lasts six hours and the stored refresh token is what renews it —
 * but only the CLI ever exchanges it. Nothing in a long-running agent touches
 * that file, so an agent that reads the credential faithfully on every request
 * still dies six hours after the last human ran `grok`. That is not
 * hypothetical: it took a production agent down, and it presented as a 403
 * from the model API with no mention of expiry.
 *
 * `grok models` is a cheap authenticated command; running it renews the token
 * in place as a side effect. Deliberately shelling out to the vendor's own CLI
 * rather than reimplementing their OAuth refresh against an undocumented
 * endpoint — when xAI changes it, their CLI changes with it.
 *
 * Best-effort by design: if the refresh fails, the request still goes out with
 * whatever credential is on disk, and the API's own error is a better
 * description of the problem than anything invented here.
 */
let refreshing: Promise<void> | null = null;

async function refreshCredential(options: {
  grokBinary?: string;
  authPath?: string;
}): Promise<void> {
  // One at a time: a burst of concurrent turns must not run six logins.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await run(grokBinaryPath(options.grokBinary), ["models"], { timeout: 60_000 });
    } catch {
      /* Best effort — the request proceeds and the API reports the truth. */
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Renew a little before the deadline, so a long turn cannot expire mid-flight. */
const RENEW_WITHIN_MS = 15 * 60_000;

/**
 * A Grok model billed to the subscription.
 *
 * The credential is re-read before every request rather than captured once.
 * It expires in hours and the CLI refreshes it in place, so a long-lived agent
 * that read the file at boot would work for an afternoon and then start failing
 * authentication for no reason a user could see — which is exactly the failure
 * we spent a day chasing on the control plane.
 */
/**
 * Drop OpenAI's `safety_identifier` from an outgoing chat body.
 *
 * eve (0.45+) fills the identifier on every call whose provider looks like
 * OpenAI — and through `createOpenAI` this one does — but xAI is not OpenAI,
 * and an OpenAI-compatible endpoint that validates its parameters answers an
 * unknown one with HTTP 400 rather than ignoring it (the exe gateway does
 * exactly that). Anything that is not a JSON object body passes through
 * untouched.
 */
export function withoutSafetyIdentifier(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    if (!("safety_identifier" in parsed)) return body;
    const { safety_identifier: _dropped, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return body;
  }
}

export function grokSubscription<TModel>(options: GrokSubscriptionOptions<TModel>): TModel {
  const baseURL = options.baseURL ?? process.env.XAI_API_URL ?? "https://api.x.ai/v1";

  // Fail at construction if there is no login at all: an agent that boots
  // "fine" and cannot answer is worse than one that refuses to start.
  readGrokCredential(options.authPath);

  /**
   * Swap the Authorization header at the moment of the call.
   *
   * Done in fetch rather than by wrapping the model: the SDK's model methods
   * rely on their own `this`, and intercepting them through a Proxy detaches
   * that binding — every call then dies inside the SDK on a missing internal,
   * which is a confusing way to learn you were too clever. A fetch wrapper
   * touches the one thing that actually needs to change.
   */
  const autoRefresh = options.autoRefresh ?? true;

  const withCurrentToken: typeof globalThis.fetch = async (input, init) => {
    if (autoRefresh) {
      const { expiresAt } = readGrokCredential(options.authPath);
      if (!expiresAt || expiresAt.getTime() - Date.now() < RENEW_WITHIN_MS) {
        await refreshCredential({ grokBinary: options.grokBinary, authPath: options.authPath });
      }
    }
    const { key } = readGrokCredential(options.authPath);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    return await globalThis.fetch(input, { ...init, headers, body: withoutSafetyIdentifier(init?.body) });
  };

  const provider = options.createOpenAI({
    baseURL,
    // Required by the SDK at construction; the fetch above supplies the real,
    // current credential on every request.
    apiKey: "grok-subscription",
    fetch: withCurrentToken,
  });

  return provider.chat(options.model);
}
