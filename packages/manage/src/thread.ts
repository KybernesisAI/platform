import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cardsOf, newStepState, readStep, type Card, type StepState } from "@kybernesis/cards";

/**
 * One continuous conversation per person, on every device.
 *
 * eve runs sessions, and a session ends: after its timeout (30 days by
 * default), when an eve upgrade strands it, or when someone resets it. A person
 * does not think in sessions. So each person gets one fixed address on this
 * channel, `thread:<their id>`, and eve keeps a live session behind it. This
 * record remembers every session that address has had, so the apps can show
 * them as one scroll, and every report a routine or heads-up produced.
 *
 * Routines never speak in the thread. Each run is its own background session;
 * only its final answer (and its cards) is added here, as a report. On the
 * person's next message the reports they have not discussed yet ride along as
 * context, so "move my 3pm" right after the calendar report still works.
 *
 * Kept outside the app's .eve folder on purpose: an eve line upgrade can delete
 * the conversation store, and the record of what was said is the part a person
 * would miss.
 */

export interface ThreadSession {
  id: string;
  at: string;
}

export interface ThreadReport {
  /** Stable: the run's session id plus a sequence. */
  id: string;
  /** A finished answer, or a question the run is waiting on. */
  kind: "report" | "question";
  /** The routine's name; "magic" for a heads-up. */
  routine: string;
  text: string;
  cards?: Card[];
  at: string;
  /** The background run. Questions are answered here. */
  runSessionId: string;
  /** The open requests, for a question. */
  requests?: unknown[];
  /** A question someone answered, or a run that ended without anyone answering. */
  settled?: boolean;
  /** Already given to the thread's session as context. */
  told?: boolean;
}

export interface ThreadRecord {
  owner: string;
  sessions: ThreadSession[];
  reports: ThreadReport[];
  /** When the person asked to start fresh, newest last. */
  fresh?: string[];
}

/** Older reports stay on disk this long; the apps page through them. */
const MAX_REPORTS = 1_000;
/** At most this many reports go to the model at once. */
const CONTEXT_REPORTS = 5;
const CONTEXT_TEXT = 600;

export function threadAddress(owner: string): string {
  return `thread:${owner}`;
}

/** A run's own address: unique per firing, so two routines never share a session. */
export function runAddress(routine: string, owner: string, now = Date.now()): string {
  return `run:${routine}:${owner}:${now.toString(36)}`;
}

export function threadsDir(dir?: string): string {
  return dir ?? process.env.KYB_THREADS_DIR ?? join(homedir(), ".kybernesis", "threads");
}

function fileFor(dir: string, owner: string): string {
  return join(dir, `${encodeURIComponent(owner)}.json`);
}

export function readThread(dir: string, owner: string): ThreadRecord {
  try {
    const raw = JSON.parse(readFileSync(fileFor(dir, owner), "utf8")) as Partial<ThreadRecord>;
    return {
      owner,
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      reports: Array.isArray(raw.reports) ? raw.reports : [],
      ...(Array.isArray(raw.fresh) ? { fresh: raw.fresh } : {}),
    };
  } catch {
    return { owner, sessions: [], reports: [] };
  }
}

/**
 * Written whole and renamed into place. One process owns these files, and every
 * change is a synchronous read-modify-write, so two changes cannot interleave.
 */
export function writeThread(dir: string, record: ThreadRecord): void {
  mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, record.owner);
  const tmp = `${file}.${process.pid}.tmp`;
  const trimmed = record.reports.length > MAX_REPORTS ? { ...record, reports: record.reports.slice(-MAX_REPORTS) } : record;
  writeFileSync(tmp, JSON.stringify(trimmed));
  renameSync(tmp, file);
}

export function updateThread(dir: string, owner: string, change: (record: ThreadRecord) => void): ThreadRecord {
  const record = readThread(dir, owner);
  change(record);
  writeThread(dir, record);
  return record;
}

/** Note the session the address resolved to; a new one is appended, never reordered. */
export function noteSession(record: ThreadRecord, id: string, at = new Date().toISOString()): boolean {
  if (record.sessions.some((s) => s.id === id)) return false;
  record.sessions.push({ id, at });
  return true;
}

/**
 * What the thread's session should know before the person's next words: the
 * reports since they last wrote, newest last, short. Marks them told.
 */
export function pendingContext(record: ThreadRecord): string | undefined {
  const untold = record.reports.filter((r) => !r.told && r.kind === "report");
  for (const r of record.reports) if (r.kind === "report") r.told = true;
  if (untold.length === 0) return undefined;
  const lines = untold.slice(-CONTEXT_REPORTS).map((r) => {
    const cards = (r.cards ?? [])
      .map((c) => {
        const artifact = (c.data as { artifactId?: unknown } | undefined)?.artifactId;
        return `${c.card}${c.title ? ` "${c.title}"` : ""}${typeof artifact === "string" ? ` (artifact ${artifact})` : ""}`;
      })
      .join(", ");
    const text = r.text.length > CONTEXT_TEXT ? `${r.text.slice(0, CONTEXT_TEXT)}…` : r.text;
    return `- ${r.at} ${r.routine === "magic" ? "heads-up" : `routine "${r.routine}"`}: ${text}${cards ? ` [${cards}]` : ""}`;
  });
  return (
    "Since the person last wrote, you posted these in their conversation. They ran in the background " +
    "and the person did not write them; treat them as things you already told the person:\n" +
    lines.join("\n")
  );
}

/** One exchange, for carrying a conversation into its next session. */
export interface Exchange {
  role: "person" | "agent";
  text: string;
}

const RECAP_EXCHANGES = 8;
const RECAP_TEXT = 400;

/**
 * The end of the previous session, as context for the first message of the
 * next one. A new session starts empty, so without this the agent would not
 * know what "that" refers to after the 30-day handover.
 */
export function recapContext(exchanges: Exchange[]): string | undefined {
  const tail = exchanges.slice(-RECAP_EXCHANGES);
  if (tail.length === 0) return undefined;
  const lines = tail.map((e) => {
    const text = e.text.length > RECAP_TEXT ? `${e.text.slice(0, RECAP_TEXT)}…` : e.text;
    return `${e.role === "person" ? "Person" : "You"}: ${text}`;
  });
  return `This conversation continues from an earlier session. The last exchanges were:\n${lines.join("\n")}`;
}

/** The exchanges in a session's stream: what the person said and what the agent finally answered. */
export function exchangesFrom(events: Iterable<{ type?: unknown; data?: unknown }>): Exchange[] {
  const out: Exchange[] = [];
  for (const e of events) {
    const data = (e.data ?? {}) as { message?: unknown; finishReason?: unknown };
    if (e.type === "message.received" && typeof data.message === "string" && data.message.trim()) {
      out.push({ role: "person", text: data.message });
    } else if (e.type === "message.completed" && typeof data.message === "string" && data.finishReason !== "tool-calls" && data.message.trim()) {
      out.push({ role: "agent", text: data.message });
    }
  }
  return out;
}

/**
 * What a background run produced, gathered from its events as they happen:
 * the last answer it gave and the cards its tools returned.
 */
export interface RunCapture {
  text?: string;
  steps: StepState;
}

export function newRunCapture(): RunCapture {
  return { steps: newStepState() };
}

export function captureRunEvent(capture: RunCapture, type: string, data: unknown): void {
  if (type === "message.completed") {
    const d = (data ?? {}) as { message?: unknown; finishReason?: unknown };
    if (typeof d.message === "string" && d.finishReason !== "tool-calls" && d.message.trim()) capture.text = d.message;
    return;
  }
  readStep(capture.steps, type, data);
}

export function runCards(capture: RunCapture): Card[] {
  return cardsOf(capture.steps.steps.values());
}

/** Whether a principal is a person this channel can keep a thread for. */
export function threadOwnerOf(auth: unknown): string | undefined {
  const p = auth as { principalType?: unknown; principalId?: unknown } | null | undefined;
  if (!p || p.principalType !== "user" || typeof p.principalId !== "string" || !p.principalId) return undefined;
  if (p.principalId.startsWith("eve:")) return undefined;
  return p.principalId;
}

/** Reports nobody owns (a routine made before routines had owners) are kept here, for people who manage the agent. */
export const AGENT_OWNER = "_agent";
