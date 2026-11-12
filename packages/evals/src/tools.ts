/**
 * Tool-name matching for Arcana memory evals.
 *
 * Match by REMOTE-NAME SUFFIX, never exact qualified name: the prefix differs by
 * mounting style (`arcana__memory__arcana_remember` via the extension mount,
 * `arcana__arcana_remember` via a plain subagent connection), and exact matching
 * breaks the moment a consumer renames a mount file.
 */

/** Remote names of Arcana tools that READ from the workspace brain. */
export const MEMORY_READ_SUFFIXES = [
  "arcana_recall",
  "arcana_search",
  "arcana_timeline",
  "arcana_brain_query",
  "arcana_brain_read",
  "arcana_brain_list",
  "arcana_brain_stats",
] as const;

/** Remote names of Arcana tools that WRITE to the workspace brain. */
export const MEMORY_WRITE_SUFFIXES = [
  "arcana_remember",
  "arcana_brain_write",
  "arcana_brain_add",
  "arcana_pin_entity",
  "arcana_unpin_entity",
] as const;

/** Tool name from a completed action-result event, or null. */
export function resultToolName(event: {
  type: string;
  data?: unknown;
}): string | null {
  if (event.type !== "action.result") return null;
  const result = (event.data as { result?: { toolName?: string } })?.result;
  return typeof result?.toolName === "string" ? result.toolName : null;
}

/** True when the event is a completed action result matching one of `suffixes`. */
export function isResultFrom(
  event: { type: string; data?: unknown },
  suffixes: readonly string[],
): boolean {
  const name = resultToolName(event);
  return name !== null && suffixes.some((suffix) => name.endsWith(suffix));
}

/** A tool call that completed: the tool's name and what it returned. */
export interface CompletedCall {
  name: string;
  output: unknown;
}

/**
 * The tool calls that completed, in the order they completed.
 *
 * eve 1.0 names the tool on `call.requested` (`capability.name`) and settles it
 * on `call.settled` with only its `callId`, so a single event no longer says
 * which tool finished; this pairs them. eve 0.81 `action.result` events are
 * read too.
 */
export function completedCalls(events: readonly { type: string; data?: unknown }[]): CompletedCall[] {
  const named = new Map<string, string>();
  const out: CompletedCall[] = [];
  for (const event of events) {
    const data = (event.data ?? {}) as {
      callId?: unknown;
      outcome?: unknown;
      output?: unknown;
      capability?: { name?: unknown };
      result?: { output?: unknown };
    };
    if (event.type === "call.requested" && typeof data.callId === "string" && typeof data.capability?.name === "string") {
      named.set(data.callId, data.capability.name);
    } else if (event.type === "call.settled" && typeof data.callId === "string" && data.outcome === "completed") {
      const name = named.get(data.callId);
      if (name) out.push({ name, output: data.output });
    } else {
      const name = resultToolName(event);
      if (name) out.push({ name, output: data.result?.output });
    }
  }
  return out;
}

/** Names of the tools whose calls completed, in the order they completed. */
export function completedToolNames(events: readonly { type: string; data?: unknown }[]): string[] {
  return completedCalls(events).map((call) => call.name);
}

/** True when a call to a tool matching one of `suffixes` completed. */
export function completedFrom(events: readonly { type: string; data?: unknown }[], suffixes: readonly string[]): boolean {
  return completedToolNames(events).some((name) => suffixes.some((suffix) => name.endsWith(suffix)));
}
