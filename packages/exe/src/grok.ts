import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** `createOpenAI` from `@ai-sdk/openai`, passed in so this package pins no provider version. */
  createOpenAI: (config: {
    baseURL: string;
    apiKey: string;
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

/**
 * A Grok model billed to the subscription.
 *
 * The credential is re-read before every request rather than captured once.
 * It expires in hours and the CLI refreshes it in place, so a long-lived agent
 * that read the file at boot would work for an afternoon and then start failing
 * authentication for no reason a user could see — which is exactly the failure
 * we spent a day chasing on the control plane.
 */
export function grokSubscription<TModel>(options: GrokSubscriptionOptions<TModel>): TModel {
  const baseURL = options.baseURL ?? process.env.XAI_API_URL ?? "https://api.x.ai/v1";

  // Fail at construction if there is no login at all: an agent that boots
  // "fine" and cannot answer is worse than one that refuses to start.
  readGrokCredential(options.authPath);

  const provider = options.createOpenAI({
    baseURL,
    // The SDK wants a string at construction; the fetch below supplies the
    // real, current one.
    apiKey: "grok-subscription",
  });

  const model = provider.chat(options.model) as TModel & {
    doGenerate?: unknown;
    doStream?: unknown;
  };

  return new Proxy(model as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "doGenerate" && property !== "doStream") return value;
      return async (input: { headers?: Record<string, string> }) => {
        const { key } = readGrokCredential(options.authPath);
        return await (value as (o: unknown) => unknown)({
          ...input,
          headers: { ...(input.headers ?? {}), authorization: `Bearer ${key}` },
        });
      };
    },
  }) as TModel;
}
