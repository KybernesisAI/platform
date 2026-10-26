import { GET, POST } from "eve/channels";
import { parseInputResponses } from "eve/client";
import { sessions } from "eve/server";
import {
  type Exchange,
  exchangesFrom,
  noteSession,
  pendingContext,
  readThread,
  recapContext,
  threadAddress,
  updateThread,
  writeThread,
} from "./thread.js";

/** The verified caller, as `identify` in index.ts returns it. */
export interface ThreadCaller {
  userId: string;
  level: string;
  org?: string;
  email?: string;
}

export interface ThreadRouteInput {
  prefix: string;
  dir: string;
  issuer: string;
  identify: (req: Request) => Promise<ThreadCaller | Response>;
  /** How the end of an earlier session is read; eve's own store unless a test passes one. */
  readExchanges?: (sessionId: string) => Promise<Exchange[]>;
}

/** Where the person is, as the client declares it (same set as @kybernesis/enterprise). */
const SURFACES = new Set(["voice", "studio", "phone", "watch", "terminal"]);

/**
 * The principal a person's own turn runs as. The same shape kybernesisAuth
 * gives a turn arriving through the eve channel, so tools, connectors and
 * memory treat a message sent here exactly like one sent there.
 */
export function personPrincipal(caller: ThreadCaller, issuer: string, req: Request) {
  const surface = req.headers.get("x-kybernesis-surface")?.trim().toLowerCase();
  return {
    authenticator: "kybernesis",
    issuer,
    principalId: caller.userId,
    principalType: "user" as const,
    subject: caller.userId,
    attributes: {
      ...(caller.org ? { org: caller.org } : {}),
      ...(caller.email ? { email: caller.email } : {}),
      agentGrantLevel: caller.level,
      ...(surface && SURFACES.has(surface) ? { surface } : {}),
    },
  };
}

/** The most a client may add as context to one message. */
const CLIENT_CONTEXT_MAX = 8_000;

type Message = string | { type: string; [key: string]: unknown }[];

function validMessage(value: unknown): value is Message {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((p) => p && typeof p === "object" && typeof (p as { type?: unknown }).type === "string");
}

async function readExchanges(sessionId: string) {
  const events: { type?: unknown; data?: unknown }[] = [];
  try {
    for await (const e of sessions.attach(sessionId).stream({ startIndex: 0, follow: false })) {
      events.push(e as { type?: unknown; data?: unknown });
    }
  } catch {
    /* a session an upgrade deleted has nothing to carry over */
  }
  return exchangesFrom(events);
}

/**
 * The thread routes. Every one answers only for the caller's own thread: the
 * owner is the verified identity, never something in the request body.
 */
export function threadRoutes(input: ThreadRouteInput) {
  const { prefix, dir, issuer, identify } = input;
  const exchangesOf = input.readExchanges ?? readExchanges;

  return [
    /**
     * The caller's thread: the sessions behind it, oldest first, the one live
     * now, and the reports routines and heads-ups added. The apps draw these as
     * one scroll; each session's events come from the eve stream as before.
     */
    GET(prefix + "/thread", async (req, { resolveSession }) => {
      const caller = await identify(req);
      if (caller instanceof Response) return caller;
      const record = readThread(dir, caller.userId);
      const current = await resolveSession(threadAddress(caller.userId));
      if (current && noteSession(record, current.id)) writeThread(dir, record);
      const url = new URL(req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("reports") ?? "200") || 200, 1), 1_000);
      return Response.json({
        current: current?.id ?? null,
        sessions: record.sessions,
        reports: record.reports.slice(-limit),
        fresh: record.fresh ?? [],
      });
    }),

    /**
     * Send the person's message into their thread. The body is the same shape
     * a client sends to eve: `{ message, clientContext? }`, the message as text
     * or content parts. Reports they
     * have not seen discussed ride along as context, and so does the end of the
     * previous session when the thread has just moved to a new one.
     */
    POST(prefix + "/thread/messages", async (req, { from, resolveSession }) => {
      const caller = await identify(req);
      if (caller instanceof Response) return caller;
      const body = (await req.json().catch(() => ({}))) as { message?: unknown; clientContext?: unknown };
      if (!validMessage(body.message)) return Response.json({ ok: false, error: "Send { message } as text or content parts." }, { status: 400 });

      const address = threadAddress(caller.userId);
      const before = await resolveSession(address);
      const record = readThread(dir, caller.userId);
      const context: string[] = [];
      const previous = record.sessions.at(-1);
      const freshSince = record.fresh?.at(-1);
      if (!before && previous && !(freshSince && freshSince > previous.at)) {
        const recap = recapContext(await exchangesOf(previous.id));
        if (recap) context.push(recap);
      }
      const reports = pendingContext(record);
      if (reports) context.push(reports);
      // What the client knows that the agent cannot: the person's working
      // folder, or the end of a conversation this device had before threads.
      if (typeof body.clientContext === "string" && body.clientContext.trim()) {
        context.push(body.clientContext.slice(0, CLIENT_CONTEXT_MAX));
      }

      const session = await from(address).send(body.message as never, {
        auth: personPrincipal(caller, issuer, req),
        state: { kind: "thread", owner: caller.userId },
        ...(context.length ? { context } : {}),
      } as never);
      noteSession(record, session.id);
      writeThread(dir, record);
      return Response.json({ ok: true, sessionId: session.id });
    }),

    /**
     * Answer a question or approval. Without `sessionId` it is the thread's
     * own; with one it must be a background run that reported into this
     * caller's thread.
     */
    POST(prefix + "/thread/respond", async (req, { from, attachSession }) => {
      const caller = await identify(req);
      if (caller instanceof Response) return caller;
      const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; inputResponses?: unknown };
      let responses;
      try {
        responses = parseInputResponses(body.inputResponses);
      } catch {
        return Response.json({ ok: false, error: "inputResponses is not valid." }, { status: 400 });
      }
      const auth = personPrincipal(caller, issuer, req);
      const record = readThread(dir, caller.userId);
      const runId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      if (runId && !record.sessions.some((s) => s.id === runId)) {
        if (!record.reports.some((r) => r.runSessionId === runId)) {
          return Response.json({ ok: false, error: "No such conversation in your thread." }, { status: 404 });
        }
        const session = await attachSession(runId).respond(responses as never, { auth } as never);
        updateThread(dir, caller.userId, (r) => {
          for (const q of r.reports) if (q.runSessionId === runId && q.kind === "question") q.settled = true;
        });
        return Response.json({ ok: true, sessionId: (session as { sessionId?: string }).sessionId ?? runId });
      }
      const session = await from(threadAddress(caller.userId)).respond(responses as never, { auth } as never);
      return Response.json({ ok: true, sessionId: session.id });
    }),

    /** Stop the turn in progress. The thread and its history stay. */
    POST(prefix + "/thread/cancel", async (req, { from }) => {
      const caller = await identify(req);
      if (caller instanceof Response) return caller;
      const body = (await req.json().catch(() => ({}))) as { turnId?: unknown };
      return Response.json(
        await from(threadAddress(caller.userId)).cancel(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
      );
    }),

    /**
     * Start fresh: the agent lets go of what it was holding in mind, and the
     * history stays on screen above a divider (the stream records the clear).
     */
    POST(prefix + "/thread/fresh", async (req, { from }) => {
      const caller = await identify(req);
      if (caller instanceof Response) return caller;
      const result = await from(threadAddress(caller.userId)).clear();
      updateThread(dir, caller.userId, (r) => {
        r.fresh = [...(r.fresh ?? []), new Date().toISOString()].slice(-50);
        for (const report of r.reports) report.told = true;
      });
      return Response.json(result);
    }),
  ];
}
