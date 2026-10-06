import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every conversation this agent has had, from eve's own run store.
 *
 * A conversation is a durable run of eve's session workflow; its id is the
 * session id clients send into. eve stamps each with the first message as a
 * title, what triggered it (HTTP, a schedule, a channel) and a status. That is
 * enough to list them, say which surface each came from and whether it can
 * still take a turn — which is the whole thing a person could not see before:
 * Studio knew one session, the phone knew the one a notification named, and
 * the rest sat on disk unlisted.
 */
export type SessionSurface = "chat" | "routines" | "imessage" | "buzz" | "api";

export interface SessionSummary {
  readonly id: string;
  /** The first message, as eve recorded it. */
  readonly title: string;
  readonly surface: SessionSurface;
  /** eve's own trigger label, for anything the surface mapping does not know. */
  readonly trigger: string;
  /** The last routine that delivered here, when this is the routines conversation. */
  readonly routine?: string;
  /** Where a Buzz conversation lives, when it is one. */
  readonly channel?: string;
  /** alive = can take a turn; ended = finished cleanly; failed = eve declared it dead. */
  readonly status: "alive" | "ended" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RunRecord {
  runId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  attributes?: Record<string, unknown>;
}

interface Parsed {
  readonly id: string;
  readonly title: string;
  readonly trigger: string;
  readonly routine?: string;
  readonly status: SessionSummary["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One parsed run, remembered by file mtime so a listing does not re-read 2,000 files. The surface is decided per listing, not cached: it depends on the canonical pointer and the Buzz store. */
const cache = new Map<string, { mtimeMs: number; parsed: Parsed | null }>();

function statusOf(run: RunRecord): SessionSummary["status"] {
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  if (run.status === "completed") return "ended";
  return "alive";
}

/**
 * Buzz conversations are HTTP turns like Studio's; the bridge keeps the
 * channel → session map, so that file is the only way to tell them apart.
 */
function buzzSessions(appRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const candidates = [join(appRoot, ".buzz-sessions.json"), join(appRoot, ".buzz", "buzz-sessions.json")];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return out;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const entries: [string, unknown][] = Array.isArray(raw)
      ? raw.map((e, i) => [String((e as { channel?: unknown }).channel ?? i), e])
      : Object.entries((raw as Record<string, unknown>) ?? {});
    for (const [channel, value] of entries) {
      const v = value as { sessionId?: unknown; id?: unknown } | null;
      const id = typeof value === "string" ? value : (v?.sessionId ?? v?.id);
      if (typeof id === "string") out.set(id, channel);
    }
  } catch {
    /* an unreadable bridge store only costs the label */
  }
  return out;
}

function surfaceOf(trigger: string, routine: string | undefined, id: string, canonicalId: string | undefined, buzz: Map<string, string>): SessionSurface {
  if (routine !== undefined || (canonicalId !== undefined && id === canonicalId)) return "routines";
  if (trigger === "channel:linq" || trigger === "channel:photon") return "imessage";
  if (buzz.has(id)) return "buzz";
  if (trigger === "http") return "chat";
  return "api";
}

export interface ListSessionsOptions {
  /** The routines conversation, so it is labelled even before a schedule attribute lands. */
  readonly canonicalId?: string;
  /** Most recent first; default 50, at most 500. */
  readonly limit?: number;
  /** Include ended and failed conversations. Default true: a finished thread is still readable. */
  readonly includeEnded?: boolean;
}

export function listSessions(appRoot: string, options: ListSessionsOptions = {}): SessionSummary[] {
  const runsDir = join(appRoot, ".eve", ".workflow-data", "runs");
  if (!existsSync(runsDir)) return [];
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const buzz = buzzSessions(appRoot);
  const out: SessionSummary[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(runsDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const hit = cache.get(file);
    let parsed: Parsed | null;
    if (hit && hit.mtimeMs === mtimeMs) {
      parsed = hit.parsed;
    } else {
      parsed = parse(file);
      cache.set(file, { mtimeMs, parsed });
    }
    if (!parsed) continue;
    if (options.includeEnded === false && parsed.status !== "alive") continue;
    const channel = buzz.get(parsed.id);
    out.push({
      id: parsed.id,
      title: parsed.title,
      surface: surfaceOf(parsed.trigger, parsed.routine, parsed.id, options.canonicalId, buzz),
      trigger: parsed.trigger,
      ...(parsed.routine ? { routine: parsed.routine } : {}),
      ...(channel ? { channel } : {}),
      status: parsed.status,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out.slice(0, limit);
}

function parse(file: string): Parsed | null {
  let run: RunRecord;
  try {
    run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  } catch {
    return null;
  }
  const attrs = run.attributes ?? {};
  // Only the session workflow is a conversation; turns and timeouts are its children.
  if (attrs["$eve.type"] !== "session" || typeof run.runId !== "string") return null;
  const trigger = typeof attrs["$eve.trigger"] === "string" ? (attrs["$eve.trigger"] as string) : "unknown";
  const routine = typeof attrs["$eve.schedule"] === "string" ? (attrs["$eve.schedule"] as string) : undefined;
  const rawTitle = typeof attrs["$eve.title"] === "string" && attrs["$eve.title"] ? (attrs["$eve.title"] as string) : "(untitled)";
  const createdAt = run.createdAt ?? run.updatedAt ?? "";
  return {
    id: run.runId,
    title: rawTitle.length > 160 ? `${rawTitle.slice(0, 157)}…` : rawTitle,
    trigger,
    ...(routine ? { routine } : {}),
    status: statusOf(run),
    createdAt,
    updatedAt: run.updatedAt ?? run.completedAt ?? createdAt,
  };
}
