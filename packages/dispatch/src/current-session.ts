import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The conversation this agent is currently having with a person.
 *
 * A schedule cannot find this out for itself. It is handed `{ to, waitUntil,
 * appAuth }` and nothing else — no session list, no way to address a session by
 * id — so a routine that wants to answer *into the chat the person is actually
 * looking at* has no way to name it. The information exists, but only here: the
 * eve channel sees `sessionId` on every inbound turn.
 *
 * So the channel writes it down. This is deliberately a file and not memory:
 * `@kybernesis/manage` restarts the agent whenever a routine is added, and an
 * in-process variable would be empty exactly when the first routine fires.
 *
 * Agent-local by design. The control plane has no part in this — a routine is
 * the agent's own business, and routing one through a hosted service would make
 * a local conversation depend on a network it never needed.
 */
export interface CurrentSession {
  /** The durable eve session id of the most recent inbound turn. */
  sessionId: string;
  /** Who was talking, when a verified principal was present. */
  principalId?: string;
  /** ISO timestamp, so a stale pointer is recognisable as stale. */
  at: string;
}

/** Where the pointer lives, next to the agent's other runtime state. */
export function currentSessionFile(appRoot?: string): string {
  const root = appRoot ?? process.env.EVE_APP_DIR ?? process.cwd();
  return join(root, ".eve", "current-session.json");
}

/**
 * Record the session this turn belongs to. Never throws: a read-only or full
 * filesystem must not take a conversation down, and the cost of failing is one
 * routine landing in a new thread instead of the open one.
 */
export function recordCurrentSession(input: CurrentSession, appRoot?: string): void {
  try {
    const file = currentSessionFile(appRoot);
    mkdirSync(dirname(file), { recursive: true });
    // Written to a sibling and renamed: a reader that arrives mid-write gets
    // the old pointer rather than half a JSON document.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(input), "utf8");
    renameSync(tmp, file);
  } catch {
    // Intentionally silent, see above.
  }
}

/** Local Eve run metadata is the deployment discriminator; caller identity is not. */
function localRun(sessionId: string, appRoot?: string): Record<string, unknown> | undefined {
  // The id comes from a request or pointer file, never allow it to escape runs/.
  if (!/^wrun_[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  const root = appRoot ?? process.env.EVE_APP_DIR ?? process.cwd();
  try {
    const raw = JSON.parse(readFileSync(join(root, ".eve", ".workflow-data", "runs", `${sessionId}.json`), "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Only a locally recorded production run may become the routine's conversation. */
export function shouldRecordCurrentSession(sessionId: string, appRoot?: string): boolean {
  if (process.env.EVE_DEV === "1" || process.env.EVE_EVALUATION === "1") return false;
  const run = localRun(sessionId, appRoot);
  return typeof run?.deploymentId === "string" && /^dpl_local@.+$/.test(run.deploymentId) &&
    (run.status === "pending" || run.status === "running");
}

/** An explicitly terminal local run is not an addressable conversation. */
function terminalSession(sessionId: string, appRoot?: string): boolean {
  const status = localRun(sessionId, appRoot)?.status;
  return status === "cancelled" || status === "completed" || status === "failed";
}

/** Read the pointer, or undefined when there has never been a turn. */
export function readCurrentSession(appRoot?: string): CurrentSession | undefined {
  try {
    const raw = JSON.parse(readFileSync(currentSessionFile(appRoot), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.sessionId !== "string" || o.sessionId === "" || terminalSession(o.sessionId, appRoot)) return undefined;
    return {
      sessionId: o.sessionId,
      ...(typeof o.principalId === "string" ? { principalId: o.principalId } : {}),
      at: typeof o.at === "string" ? o.at : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}
