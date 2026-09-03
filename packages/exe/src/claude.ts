/**
 * Claude on a Claude subscription, not on token-billed API keys.
 *
 * @remarks
 * The third of the subscription-backed providers, alongside `grokSubscription`
 * and eve's own `experimental_chatgpt()`. All three exist for the same reason:
 * a client already pays for a seat, and an agent that bills metered API usage
 * on top is buying the same capability twice.
 *
 * The shape is different from the other two, and the difference matters when
 * something breaks. Grok and ChatGPT credentials are files a CLI writes, read
 * directly. Claude Code's OAuth is refreshed by a local proxy that owns the
 * token exchange, and this provider simply speaks the ordinary Anthropic
 * Messages API to `127.0.0.1`. So there is a process to keep alive here, where
 * the others only have a file to keep fresh — which is why a proxy that is
 * merely *reachable* is checked at start rather than assumed.
 *
 * ```ts title="agent/agent.ts"
 * import { defineAgent } from "eve";
 * import { createAnthropic } from "@ai-sdk/anthropic";
 * import { claudeSubscription } from "@kybernesis/exe";
 *
 * export default defineAgent({
 *   model: claudeSubscription({ model: "claude-opus-5", createAnthropic }),
 *   modelContextWindowTokens: CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW,
 * });
 * ```
 *
 * ## What the proxy is for, and what it must not do
 *
 * A Claude subscription authenticates with an OAuth bearer that expires and is
 * refreshed against Anthropic's own endpoints. The proxy holds that credential,
 * refreshes it, and swaps it in on each forwarded request — so the agent
 * process never holds a long-lived secret and the placeholder key below is
 * exactly that, a placeholder the SDK insists on.
 *
 * It must bind to loopback only. A proxy on a public interface is an
 * unauthenticated gateway to somebody's paid subscription, and the URL below is
 * checked for that on the way past rather than left to a code review.
 *
 * ## Provider-defined tool names are not ours to rename
 *
 * A proxy that obfuscates tool names — a reasonable thing to do for privacy
 * with user-defined tools — must leave Anthropic's own provider-defined tools
 * alone. `web_search` is validated by name upstream, and renaming it produces
 * `tools.N.web_search_20250305.name: Input should be 'web_search'`, which reads
 * like a schema bug in the agent rather than a rewrite in the middle. If you
 * maintain the proxy, keep that carve-out and keep it tested.
 */

/**
 * Input window for `claude-opus-5`, for `modelContextWindowTokens`.
 *
 * @remarks
 * Read from the API rather than remembered: `GET /v1/models/claude-opus-5`
 * reports `max_input_tokens`, and it is the only authority worth trusting.
 * Two hundred thousand is the number most people carry in their heads from
 * earlier Claude models, and using it here would make eve compact at a fifth of
 * the real capacity — every long session paying for summarisation it did not
 * need, and losing detail nobody asked it to drop.
 *
 * Other Claude models differ. Ask the models endpoint before assuming this one
 * applies, and see {@link claudeInputWindow}.
 */
export const CLAUDE_SUBSCRIPTION_CONTEXT_WINDOW = 1_000_000;

/**
 * The model's real input window, from the API.
 *
 * @remarks
 * For preflight and for scripts, not for boot: an agent that cannot start until
 * a proxy answers is worse than one that starts with a declared number. Compare
 * what it returns against what the agent declares — a mismatch is silent in
 * both directions, wasting capacity when too low and overflowing when too high.
 */
export async function claudeInputWindow(
  model: string,
  baseURL = "http://127.0.0.1:3333/v1",
  timeoutMs = 4000,
): Promise<number | undefined> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/models/${model}`, {
      headers: { "x-api-key": "claude-subscription-local-proxy", "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { max_input_tokens?: number };
    return typeof body.max_input_tokens === "number" ? body.max_input_tokens : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The output cap every subscription call carries unless the caller says
 * otherwise.
 *
 * Without one the provider asks for the model's maximum (`max_tokens: 128000`
 * on claude-opus-5) on every request. A subscription is a shared per-minute
 * output budget, so each message then reserves a large share of it and the
 * subscription agent is the first thing to fail under load: this showed as
 * `Overloaded` errors on two deployments (KYB-530). 16k covers any answer a
 * chat turn produces; long artifacts go through tools, not the reply.
 */
export const CLAUDE_SUBSCRIPTION_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Fill `maxOutputTokens` on a language model's calls when the caller left it
 * unset. Works on the AI SDK's provider interface directly (`doGenerate` /
 * `doStream` take the call options as their first argument), so this package
 * needs no dependency on `ai` and the wrapped object keeps every other
 * property of the model, including its specification version.
 */
export function withDefaultMaxOutputTokens<TModel>(model: TModel, cap: number): TModel {
  const fill = (options: unknown) =>
    options && typeof options === "object" && (options as { maxOutputTokens?: unknown }).maxOutputTokens === undefined
      ? { ...(options as object), maxOutputTokens: cap }
      : options;
  const source = model as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = Object.create(Object.getPrototypeOf(source) ?? null);
  for (const key of Object.keys(source)) wrapped[key] = source[key];
  for (const name of ["doGenerate", "doStream"]) {
    const original = source[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (options: unknown, ...rest: unknown[]) =>
      (original as (...a: unknown[]) => unknown).call(source, fill(options), ...rest);
  }
  return wrapped as unknown as TModel;
}

export interface ClaudeSubscriptionOptions<TModel> {
  /** Model id, e.g. `"claude-opus-5"`. Bare Anthropic ids, not gateway-prefixed. */
  model: string;
  /**
   * Where the local proxy listens. Defaults to `http://127.0.0.1:3333/v1`.
   *
   * Must be loopback: this endpoint spends a subscription and requires no
   * credential of its own.
   */
  baseURL?: string;
  /**
   * Refuse a non-loopback proxy URL. Defaults to true.
   *
   * Turn it off only when the proxy is genuinely elsewhere AND the network path
   * is authenticated by something else — a private mesh, an SSH tunnel with its
   * own auth. Left on, this is the check that stops a convenience edit during
   * debugging from publishing someone's subscription to the internet.
   */
  requireLoopback?: boolean;
  /** `createAnthropic` from `@ai-sdk/anthropic`, passed in so this package pins no provider version. */
  createAnthropic: (config: { baseURL: string; apiKey: string }) => (model: string) => TModel;
  /**
   * Output cap applied to calls that set none. Defaults to
   * {@link CLAUDE_SUBSCRIPTION_MAX_OUTPUT_TOKENS}; `false` disables the cap. A
   * per-call `maxOutputTokens` always wins over this default.
   */
  maxOutputTokens?: number | false;
}

/**
 * Hosts that mean "this machine".
 *
 * `localhost` is included and IPv6 loopback is spelled both ways, because a
 * URL is written by a person and all three forms are the same intent.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether a proxy URL points at this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the proxy is up and holding a subscription credential.
 *
 * @remarks
 * Worth calling at preflight. When the proxy is down every turn fails with a
 * connection error from deep inside the SDK, which reads like the model being
 * unavailable rather than like a container that stopped — and the two have very
 * different fixes.
 */
export async function claudeProxyReady(
  baseURL = "http://127.0.0.1:3333/v1",
  timeoutMs = 4000,
): Promise<{ ok: boolean; detail: string }> {
  // The health path sits at the root, beside the versioned API rather than
  // inside it.
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${root}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { ok: true, detail: `Claude subscription proxy answering at ${root}` }
      : { ok: false, detail: `Proxy at ${root} answered ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      detail:
        `No Claude subscription proxy at ${root} (${(error as Error).message}). ` +
        `Every turn will fail with what looks like a model outage. Start the proxy container.`,
    };
  }
}

/**
 * A Claude model billed to a subscription through a local OAuth proxy.
 *
 * @throws When the proxy URL is not loopback and `requireLoopback` is left on.
 */
export function claudeSubscription<TModel>(options: ClaudeSubscriptionOptions<TModel>): TModel {
  const baseURL = options.baseURL ?? "http://127.0.0.1:3333/v1";

  if (options.requireLoopback !== false && !isLoopbackUrl(baseURL)) {
    throw new Error(
      `claudeSubscription: ${baseURL} is not a loopback address. This proxy spends a Claude ` +
        `subscription and requires no credential of its own, so exposing it off-host publishes ` +
        `that subscription to anyone who finds the port. Bind it to 127.0.0.1, or pass ` +
        `requireLoopback: false if the network path is authenticated some other way.`,
    );
  }

  const anthropic = options.createAnthropic({
    baseURL,
    // The SDK requires a key and the proxy replaces it with the current OAuth
    // bearer before forwarding. A real key here would be the bug: it would bill
    // metered usage and quietly defeat the point of the whole arrangement.
    apiKey: "claude-subscription-local-proxy",
  });

  const model = anthropic(options.model);
  if (options.maxOutputTokens === false) return model;
  return withDefaultMaxOutputTokens(model, options.maxOutputTokens ?? CLAUDE_SUBSCRIPTION_MAX_OUTPUT_TOKENS);
}
