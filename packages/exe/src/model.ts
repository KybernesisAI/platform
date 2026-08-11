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
    responses: (model: string) => TModel;
  };
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
  const base = provider.responses(options.model) as Record<string, unknown> & {
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

  const wrapped = {
    specificationVersion: base.specificationVersion,
    provider: base.provider,
    modelId: base.modelId,
    get supportedUrls() {
      return base.supportedUrls;
    },
    doGenerate: (o: CallOptions) => base.doGenerate(forceStoreFalse(o)),
    doStream: (o: CallOptions) => base.doStream(forceStoreFalse(o)),
  };
  // The wrapper is call-compatible with the provider's model; hand back the
  // provider's own type so callers need no cast at the defineAgent() call site.
  return wrapped as TModel;
}
