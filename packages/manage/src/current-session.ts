import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The conversation this agent is currently having, as recorded by its eve
 * channel (@kybernesis/dispatch writes it on every inbound turn).
 *
 * Read here rather than imported so the two packages stay independent: they are
 * published per eve line and on their own cadence, and a routine's delivery
 * must not hinge on their versions agreeing. The contract between them is this
 * file path and two field names, which is small enough to hold still.
 */
export interface CurrentSession {
  sessionId: string;
  principalId?: string;
  at: string;
}

/** Where the eve channel writes the pointer. */
export function currentSessionFile(appRoot: string): string {
  return join(appRoot, ".eve", "current-session.json");
}

/**
 * The current conversation, or undefined when nobody has spoken to this agent
 * yet — in which case a routine starts a new one rather than failing.
 */
export function readCurrentSession(appRoot: string): CurrentSession | undefined {
  try {
    const raw = JSON.parse(readFileSync(currentSessionFile(appRoot), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.sessionId !== "string" || o.sessionId === "") return undefined;
    return {
      sessionId: o.sessionId,
      ...(typeof o.principalId === "string" ? { principalId: o.principalId } : {}),
      at: typeof o.at === "string" ? o.at : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}
