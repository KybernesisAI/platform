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
