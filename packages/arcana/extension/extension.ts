import { defineExtension } from "eve/extension";
import type { SessionContext } from "eve/context";
import { z } from "zod";

/**
 * Kybernesis Arcana memory for an eve agent.
 *
 * Mount once per brain: the root agent and each subagent mount their own
 * instance, each pointed at its own Arcana workspace with that workspace's
 * scoped `kb_` API key. (Workspace-scoped keys 403 outside their workspace.)
 *
 * `resolveWorkspace` optionally re-targets the workspace per session at
 * runtime (e.g. a different brain for DM sessions than for public-channel
 * sessions). Return `undefined` to fall back to the static `workspace`.
 */
export type ResolveWorkspace = (
  ctx: SessionContext,
) => string | undefined | Promise<string | undefined>;

export default defineExtension({
  config: z.object({
    /** Arcana `kb_` API key for the target workspace. */
    apiKey: z.string().min(1),
    /** Arcana workspace slug this brain reads and writes. */
    workspace: z.string().min(1),
    /** Optional per-session workspace override. */
    resolveWorkspace: z
      .custom<ResolveWorkspace>((value) => typeof value === "function")
      .optional(),
  }),
});
