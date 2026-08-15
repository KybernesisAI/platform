/**
 * Model access through an exe.dev LLM integration.
 *
 * exe.dev holds the provider credential server-side (its managed gateway, your
 * API key, or a connected ChatGPT subscription) and exposes it to attached VMs
 * at `https://<integration>.int.exe.xyz`. Nothing authenticates from the VM, so
 * no provider key ever lands on the host.
 */

/** Options for {@link exeModel}. */
export interface ExeModelOptions<TModel> {
  /**
   * Model id served by the integration (e.g. `"gpt-5.6-sol"`). Must be a model
   * the integration's OpenAI provider actually exposes — check with
   * `curl https://<integration>.int.exe.xyz/v1/models`.
   */
  model: string;
  /**
   * Integration hostname. Defaults to `EXE_LLM_URL`, then the default personal
   * integration `https://llm.int.exe.xyz/v1`. Team integrations use
   * `<name>.team.exe.xyz`.
   */
  baseURL?: string;
  /**
   * The `createOpenAI` factory from `@ai-sdk/openai`. Passed in rather than
   * imported so this package doesn't pin a provider version — use the one your
   * agent already depends on.
   */
  createOpenAI: (config: { baseURL: string; apiKey: string }) => {
    chat: (model: string) => TModel;
    responses: (model: string) => TModel;
  };
  /**
   * Which OpenAI surface to call.
   *
   * Defaults to "responses", which is what subscription-backed models require:
   * models.json reports `"apis": ["openai_responses"]` for them, and
   * chat-completions answers `Model … is not in this integration's model list`
   * for a model that plainly is.
   *
   * Pass "chat" for gateway-backed models that expect chat-completions.
   *
   * A warning about the errors here, because they cost hours: an UNKNOWN model
   * id on the responses surface comes back as
   * `404 unsupported endpoint: /v1/responses` — an error about the endpoint,
   * for a problem with the model. The endpoint is fine. Check that EXE_MODEL
   * carries its provider prefix (`openai/gpt-5.6-sol`, not `gpt-5.6-sol`)
   * before believing anything that 404 says.
   */
  api?: "chat" | "responses";
}

type CallOptions = {
  providerOptions?: { openai?: Record<string, unknown> } & Record<string, unknown>;
};

/**
 * A language model served by an exe.dev LLM integration, safe to hand to
 * `defineAgent({ model })`.
 *
 * ```ts title="agent/agent.ts"
 * import { defineAgent } from "eve";
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { exeModel } from "@kybernesis/exe";
 *
 * export default defineAgent({
 *   model: exeModel({ model: "gpt-5.6-sol", createOpenAI }),
 *   modelContextWindowTokens: 200_000,
 * });
 * ```
 *
 * **Why the wrapper exists.** When the integration's OpenAI provider is backed
 * by a **ChatGPT subscription**, requests are served by the Codex backend,
 * which is stricter than the plain OpenAI API and rejects stored responses
 * outright (`{"detail":"Store must be set to false"}` → HTTP 400, surfacing in
 * eve as `MODEL_CALL_FAILED`). The AI SDK sends `store` by default, so every
 * turn fails. This forces `store: false` on each call — the same normalization
 * eve applies internally in `experimental_chatgpt()` for local Codex logins.
 * It is harmless when the integration is gateway- or API-key-backed, so the
 * same agent file works against any provider source.
 */
export function exeModel<TModel>(options: ExeModelOptions<TModel>): TModel {
  const baseURL =
    options.baseURL ?? process.env.EXE_LLM_URL ?? "https://llm.int.exe.xyz/v1";

  // apiKey is required by the SDK but unused: exe injects the real credential.
  const provider = options.createOpenAI({ baseURL, apiKey: "exe-integration" });
  const api = options.api ?? "responses";
  const base = (api === "responses"
    ? provider.responses(options.model)
    : provider.chat(options.model)) as Record<string, unknown> & {
    doGenerate: (o: CallOptions) => unknown;
    doStream: (o: CallOptions) => unknown;
  };

  const forceStoreFalse = (o: CallOptions): CallOptions => ({
    ...o,
    providerOptions: {
      ...o.providerOptions,
      openai: { ...(o.providerOptions?.openai ?? {}), store: false },
    },
  });

  /**
   * Answer a non-streaming call by streaming and collecting the result.
   *
   * The Codex backend behind a ChatGPT subscription refuses non-streaming
   * requests outright (`{"detail":"Stream must be set to true"}` → HTTP 400).
   * Streaming is how an agent turn runs, so this stays invisible until
   * something asks for a whole answer at once — a judge scoring an eval, a
   * structured extraction, a generated title — and then it fails with an error
   * about `stream` for a call whose author never chose its streaming-ness.
   *
   * Collecting the stream is the honest fix: the backend gets the only shape it
   * accepts, and the caller gets the shape it asked for.
   */
  async function generateViaStream(o: CallOptions): Promise<unknown> {
    const result = (await base.doStream(forceStoreFalse(o))) as {
      stream: ReadableStream<Record<string, unknown>>;
      request?: unknown;
      response?: unknown;
    };

    const content: Array<Record<string, unknown>> = [];
    const text = new Map<string, string>();
    const reasoning = new Map<string, string>();
    let finishReason: unknown = "unknown";
    let usage: unknown = {};
    let providerMetadata: unknown;
    let warnings: unknown[] = [];
    let responseMetadata: Record<string, unknown> = {};

    const reader = result.stream.getReader();
    for (;;) {
      const { done, value: part } = await reader.read();
      if (done) break;
      if (!part) continue;
      switch (part.type) {
        case "stream-start":
          warnings = (part.warnings as unknown[]) ?? [];
          break;
        case "response-metadata": {
          const { type: _drop, ...rest } = part;
          responseMetadata = { ...responseMetadata, ...rest };
          break;
        }
        case "text-delta":
          text.set(String(part.id), (text.get(String(part.id)) ?? "") + String(part.delta ?? ""));
          break;
        case "reasoning-delta":
          reasoning.set(String(part.id), (reasoning.get(String(part.id)) ?? "") + String(part.delta ?? ""));
          break;
        // Tool calls, sources and files arrive whole; only text and reasoning
        // are split into deltas that have to be rejoined.
        case "tool-call":
        case "tool-result":
        case "source":
        case "file": {
          content.push({ ...part });
          break;
        }
        case "finish":
          finishReason = part.finishReason ?? "unknown";
          usage = part.usage ?? usage;
          providerMetadata = part.providerMetadata;
          break;
        case "error":
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          break;
      }
    }

    // Reasoning before text, matching the provider's own generate ordering.
    for (const [, value] of reasoning) if (value) content.unshift({ type: "reasoning", text: value });
    for (const [, value] of text) if (value) content.push({ type: "text", text: value });

    return {
      content,
      finishReason,
      usage,
      warnings,
      providerMetadata,
      request: result.request ?? {},
      response: { ...responseMetadata, ...((result.response as Record<string, unknown>) ?? {}) },
    };
  }

  const wrapped = {
    specificationVersion: base.specificationVersion,
    provider: base.provider,
    modelId: base.modelId,
    get supportedUrls() {
      return base.supportedUrls;
    },
    doGenerate: async (o: CallOptions) => {
      try {
        return await base.doGenerate(forceStoreFalse(o));
      } catch (error) {
        // Only the backend's own "must stream" refusal is retried. Every other
        // failure is the caller's to see, unchanged.
        if (!/stream must be set to true/i.test(String((error as Error)?.message ?? error))) throw error;
        return generateViaStream(o);
      }
    },
    doStream: (o: CallOptions) => base.doStream(forceStoreFalse(o)),
  };
  // The wrapper is call-compatible with the provider's model; hand back the
  // provider's own type so callers need no cast at the defineAgent() call site.
  return wrapped as TModel;
}
