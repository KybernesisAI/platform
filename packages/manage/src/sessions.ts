import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A historical run without a trusted creation-time provenance record is unattributed. */
export type SessionSurface = "chat" | "routines" | "imessage" | "buzz" | "api" | "unknown";
export type SessionOrigin = "owner" | "eval" | "unknown";

export interface SessionSummary {
  readonly id: string;
  /** The first message, as eve recorded it. */
  readonly title: string;
  readonly surface: SessionSurface;
  /** Unknown until Eve records trusted provenance when the session is created. */
  readonly origin: SessionOrigin;
  /** eve's own trigger label, for anything the surface mapping does not know. */
  readonly trigger: string;
  /** The last routine that delivered here, when this is the routines conversation. */
  readonly routine?: string;
  /** Reserved for a future trusted creation-time Buzz channel record. */
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

/** One parsed run, remembered by file mtime so a listing does not re-read 2,000 files. */
const cache = new Map<string, { mtimeMs: number; parsed: Parsed | null }>();

function statusOf(run: RunRecord): SessionSummary["status"] {
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  if (run.status === "completed") return "ended";
  return "alive";
}

export interface ListSessionsOptions {
  /** Kept for existing callers; mutable pointers cannot establish historical provenance. */
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
    out.push({
      id: parsed.id,
      title: parsed.title,
      surface: "unknown",
      origin: "unknown",
      trigger: parsed.trigger,
      ...(parsed.routine ? { routine: parsed.routine } : {}),
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
