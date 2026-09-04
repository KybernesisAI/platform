import {
  ClientError,
  createDataUrlFilePart,
  type Client,
  type InputRequest,
  type MessageResponse,
  type MessageResult,
  type MessageStreamEvent,
  type SendTurnInput,
} from "eve/client";
import { isImage, type FetchedMedia, type MediaRef } from "./media.js";
import { SessionStore } from "./sessions.js";

/** Five minutes without an eve event or acknowledgement is treated as a stalled turn. */
export const DEFAULT_AGENT_SILENCE_TIMEOUT_MS = 5 * 60_000;
/**
 * How long a turn may run once the agent has acknowledged it.
 *
 * eve's response stream is quiet while the agent works: a long tool call or a
 * delegated subagent produces no events until it returns. Reading that quiet
 * as a stall killed every real piece of work over five minutes the day the
 * silence watchdog shipped (a repository study, a delegation that cloned and
 * read a codebase), while the stall it was built for happened BEFORE the
 * first event: no run was ever created. So the short bound stays on the
 * phases where silence is a fault (unread drain, acknowledgements) and the
 * response stream gets this ceiling instead. Sixty minutes covers the longest
 * genuine turn seen on a deployment (44 minutes) with room.
 */
export const DEFAULT_AGENT_WORK_TIMEOUT_MS = 60 * 60_000;

/** The two bounds a watchdog applies, chosen by phase. */
export interface AgentTimeouts {
  /** Silence before the first event of a request: drain, send/create acknowledgement. */
  readonly silenceMs: number;
  /** Silence between events once the response stream is open: the agent is working. */
  readonly workMs: number;
}

const isWorkPhase = (phase: AgentSilencePhase): boolean => phase.endsWith("response stream");


export type AgentSilencePhase =
  | "unread drain"
  | "send acknowledgement"
  | "response stream"
  | "create acknowledgement"
  | "create response stream";

/** A caller-owned inactivity timeout. Aborting the transport does not cancel the eve session. */
export class AgentSilenceTimeoutError extends Error {
  readonly phase: AgentSilencePhase;
  readonly intervalMs: number;

  constructor(phase: AgentSilencePhase, intervalMs: number) {
    super(`agent was silent for ${intervalMs}ms during ${phase}`);
    this.name = "AgentSilenceTimeoutError";
    this.phase = phase;
    this.intervalMs = intervalMs;
  }
}

/** Refuse invalid values before starting a bridge with an ineffective watchdog. */
export function validateAgentSilenceTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("agentSilenceTimeoutMs must be a finite positive number of milliseconds");
  }
  return value;
}

/** A message shape accepted by the certified eve client's send contract. */
export type TurnMessage = SendTurnInput["message"];

/**
 * One thing that went wrong inside a turn, as the session stream reported it.
 *
 * A turn where every tool call fails ends with no assistant text and no
 * turn-level error: eve logs `tool execution failed` and finishes. From the
 * channel that was the same silence as an overloaded model or a dead process,
 * and on one deployment it took an hour to tell them apart (KYB-529). The
 * stream does carry the facts (`action.result` with a failed status and the
 * tool's name and error; `step.failed` / `turn.failed` with a code and
 * message), so the bridge keeps them and says them.
 */
export type TurnFailure =
  | { kind: "tool"; toolName: string; message: string }
  | { kind: "model"; code: string; message: string };

/** Everything the bridge needs to decide how one eve turn should be rendered. */
export interface TurnOutcome {
  message: string;
  status: MessageResult["status"];
  inputRequests: readonly InputRequest[];
  sessionId: string;
  streamIndex: number;
  /** Failures seen on the stream, in order. Empty on a clean turn. */
  failures: readonly TurnFailure[];
}

const clip = (text: unknown, max = 200): string => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Read a failure out of one stream event, or nothing when the event is not one. */
export function failureFromEvent(event: { type: string; data?: unknown }): TurnFailure | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (event.type === "action.result") {
    const result = (data.result ?? {}) as Record<string, unknown>;
    const failed = data.status === "failed" || data.status === "rejected" || result.isError === true;
    if (!failed) return null;
    const error = (data.error ?? {}) as Record<string, unknown>;
    const output = typeof result.output === "string" ? result.output : result.output !== undefined ? JSON.stringify(result.output) : "";
    return {
      kind: "tool",
      toolName: String(result.toolName ?? "a tool"),
      message: clip(error.message ?? output ?? data.status),
    };
  }
  if (event.type === "step.failed" || event.type === "turn.failed") {
    return { kind: "model", code: String(data.code ?? event.type), message: clip(data.message) };
  }
  return null;
}

/**
 * What to post when a turn produced no text.
 *
 * Names every distinct failure the stream reported, verbatim; a genuinely
 * empty completion keeps the old sentence. Nothing here is invented: every
 * tool name and message comes from an event the bridge saw.
 */
export function silentTurnReply(failures: readonly TurnFailure[]): string {
  if (failures.length === 0) return "I didn't get an answer back for that one — ask me again and I'll retry.";
  const tools = new Map<string, { count: number; message: string }>();
  const models: string[] = [];
  for (const f of failures) {
    if (f.kind === "tool") {
      const key = `${f.toolName}\u0000${f.message}`;
      const seen = tools.get(key);
      if (seen) seen.count += 1;
      else tools.set(key, { count: 1, message: f.message });
    } else {
      models.push(`${f.code}: ${f.message}`);
    }
  }
  const lines: string[] = [];
  for (const [key, { count, message }] of tools) {
    const toolName = key.split("\u0000")[0];
    const times = count === 1 ? "" : ` ${count} times`;
    lines.push(`I tried \`${toolName}\`${times} and it answered "${message}".`);
  }
  if (models.length) lines.push(`The model call failed (${[...new Set(models)].join("; ")}).`);
  lines.push("So I have nothing to give you yet. Say the word and I'll try another way.");
  return lines.join(" ");
}

/** The bridge's log line for a turn with no text: which of the three cases it was. */
export function describeSilentTurn(failures: readonly TurnFailure[]): string {
  const tools = failures.filter((f) => f.kind === "tool").length;
  const models = failures.filter((f) => f.kind === "model") as Extract<TurnFailure, { kind: "model" }>[];
  if (models.length) return `no text: model error (${models.map((m) => m.code).join(", ")})`;
  if (tools) return `no text: tool failures (${tools})`;
  return "no text: empty completion";
}

/** Convert one inbound Buzz message into an eve-compatible turn. */
export async function composeMessage(
  text: string,
  attachments: MediaRef[],
  fetchAttachment: (ref: MediaRef) => Promise<FetchedMedia>,
  log: (message: string) => void = () => {},
): Promise<TurnMessage> {
  if (attachments.length === 0) return text;

  const parts: Exclude<TurnMessage, string> = [];
  if (text) parts.push({ type: "text", text });

  for (const ref of attachments) {
    try {
      const media = await fetchAttachment(ref);
      if (isImage(media.mediaType)) {
        parts.push(createDataUrlFilePart({
          bytes: media.bytes,
          mediaType: media.mediaType,
        }));
      } else {
        parts.push({
          type: "text",
          text: `[The sender attached a ${media.mediaType} file, which cannot be read as an image. Tell them what you received and ask for it in a readable form if you need it.]`,
        });
      }
    } catch (error) {
      log(`could not fetch an attachment: ${(error as Error).message}`);
      parts.push({
        type: "text",
        text: `[The sender attached a file, and it could not be retrieved (${(error as Error).message}). Say so rather than answering as if there were no attachment.]`,
      });
    }
  }
  return parts;
}

interface SilenceWatchdog {
  readonly signal: AbortSignal;
  arm(phase: AgentSilencePhase): void;
  dispose(): void;
  throwIfTimedOut(): void;
}

function silenceWatchdog(timeouts: AgentTimeouts): SilenceWatchdog {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timeout: AgentSilenceTimeoutError | undefined;

  return {
    signal: controller.signal,
    arm(phase) {
      if (timer) clearTimeout(timer);
      const intervalMs = isWorkPhase(phase) ? timeouts.workMs : timeouts.silenceMs;
      timer = setTimeout(() => {
        timeout = new AgentSilenceTimeoutError(phase, intervalMs);
        controller.abort(timeout);
      }, intervalMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    throwIfTimedOut() {
      if (timeout) throw timeout;
    },
  };
}

async function drainUnread(
  stream: (signal: AbortSignal) => AsyncIterable<MessageStreamEvent>,
  timeouts: AgentTimeouts,
): Promise<number> {
  const watchdog = silenceWatchdog(timeouts);
  let unread = 0;
  watchdog.arm("unread drain");
  try {
    try {
      for await (const _ of stream(watchdog.signal)) {
        unread += 1;
        watchdog.arm("unread drain");
      }
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    // Eve normally swallows an external stream abort as clean iterator completion.
    watchdog.throwIfTimedOut();
    return unread;
  } finally {
    watchdog.dispose();
  }
}

const isTurnBoundary = (type: string): boolean =>
  type === "session.waiting" || type === "session.completed" || type === "session.failed";

async function collectResponse(
  response: MessageResponse,
  watchdog: SilenceWatchdog,
  phase: AgentSilencePhase,
  streamIndex: () => number,
  continueStream?: (signal: AbortSignal) => AsyncIterable<MessageStreamEvent>,
  log: (message: string) => void = () => {},
): Promise<TurnOutcome> {
  let message = "";
  let status: MessageResult["status"] = "completed";
  let inputRequests: InputRequest[] = [];
  let failures: TurnFailure[] = [];
  let sawTurnStart = false;
  let endedAtOwnBoundary = false;
  let staleBoundaryFirst = false;
  let seen = 0;

  /**
   * One event of this turn, or of the turn before it.
   *
   * The client ends a send's stream at the first session boundary after the
   * cursor. When the send itself ends an earlier, still-running turn (a person
   * asks again while a twenty-minute delegation is under way), that earlier
   * turn's `session.waiting` is the first thing on the wire, before this
   * turn's `turn.started`. Read as ours it made an empty answer, and the
   * abandoned stream then closed the request, which cancelled the real turn
   * five minutes into its work. So: nothing counts until this turn has
   * started, and a boundary only ends the collection once it has.
   */
  const consume = (event: MessageStreamEvent): boolean => {
    watchdog.arm(phase);
    seen += 1;
    // A boundary as the very first event, before anything of this turn, is the
    // earlier turn's. Anything else is treated as ours (a stream without
    // turn.started still answers as before).
    if (seen === 1 && isTurnBoundary(event.type) && !sawTurnStart) staleBoundaryFirst = true;
    if (event.type === "turn.started") {
      sawTurnStart = true;
      message = "";
      status = "completed";
      inputRequests = [];
      failures = [];
      return false;
    }
    const failure = failureFromEvent(event as { type: string; data?: unknown });
    if (failure) failures.push(failure);
    if (event.type === "message.completed" && event.data.finishReason !== "tool-calls") {
      message = event.data.message ?? "";
    } else if (event.type === "input.requested") {
      inputRequests.push(...event.data.requests);
    } else if (event.type === "session.waiting") {
      status = "waiting";
    } else if (event.type === "session.failed") {
      status = "failed";
    } else if (event.type === "session.completed") {
      status = "completed";
    }
    if (isTurnBoundary(event.type) && !staleBoundaryFirst) {
      endedAtOwnBoundary = true;
      return true;
    }
    if (isTurnBoundary(event.type) && staleBoundaryFirst && sawTurnStart) {
      endedAtOwnBoundary = true;
      return true;
    }
    return false;
  };

  watchdog.arm(phase);
  try {
    try {
      for await (const event of response) {
        if (consume(event)) break;
      }
      if (staleBoundaryFirst && !endedAtOwnBoundary && continueStream) {
        log("the stream ended on an earlier turn's boundary before this turn started; following the session until this turn ends");
        for await (const event of continueStream(watchdog.signal)) {
          if (consume(event)) break;
        }
      }
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    watchdog.throwIfTimedOut();
    return {
      message,
      status,
      inputRequests,
      sessionId: response.sessionId,
      streamIndex: streamIndex(),
      failures,
    };
  } finally {
    watchdog.dispose();
  }
}

async function sendExisting(
  responsePromise: (signal: AbortSignal) => Promise<MessageResponse>,
  streamIndex: () => number,
  timeouts: AgentTimeouts,
  continueStream?: (signal: AbortSignal) => AsyncIterable<MessageStreamEvent>,
  log: (message: string) => void = () => {},
): Promise<TurnOutcome> {
  const watchdog = silenceWatchdog(timeouts);
  watchdog.arm("send acknowledgement");
  try {
    let response: MessageResponse;
    try {
      response = await responsePromise(watchdog.signal);
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    watchdog.throwIfTimedOut();
    return await collectResponse(response, watchdog, "response stream", streamIndex, continueStream, log);
  } finally {
    watchdog.dispose();
  }
}

/** Continue a channel's existing conversation, replacing it only when it is explicitly stale. */
export async function answerTurn(
  client: Client,
  sessions: SessionStore,
  channel: string,
  message: TurnMessage,
  community: string,
  log: (message: string) => void = () => {},
  agentSilenceTimeoutMs = DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
  agentWorkTimeoutMs = DEFAULT_AGENT_WORK_TIMEOUT_MS,
): Promise<TurnOutcome> {
  const intervalMs: AgentTimeouts = {
    silenceMs: validateAgentSilenceTimeoutMs(agentSilenceTimeoutMs),
    workMs: validateAgentSilenceTimeoutMs(agentWorkTimeoutMs),
  };
  const existing = sessions.get(community, channel);
  if (existing) {
    try {
      // attach() is local in eve 0.49 and performs no network I/O.
      const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });

      /**
       * Move to the true end of the conversation before speaking.
       *
       * `send()` opens its response stream at the position the handle already
       * holds and stops at the FIRST turn boundary it meets. Draining first
       * repairs any cursor that was left behind by a prior disconnected reader.
       */
      const unread = await drainUnread(
        (signal) => session.stream({ follow: false, startIndex: existing.streamIndex, signal }),
        intervalMs,
      );
      if (unread > 0) {
        log(`caught up on ${unread} unread event(s) in ${channel.slice(0, 8)} before answering`);
      }

      const result = await sendExisting(
        (signal) => session.send(message, {
          clientContext: { buzzCommunity: community, buzzChannel: channel },
          signal,
        }),
        () => session.state.streamIndex,
        intervalMs,
        (signal) => session.stream({ follow: true, startIndex: session.state.streamIndex, signal }),
        log,
      );
      sessions.set(community, channel, {
        id: existing.id,
        streamIndex: session.state.streamIndex,
      });
      return result;
    } catch (error) {
      // Transport uncertainty, request rejection, and our own timeout do not
      // prove the durable server conversation is stale. Preserve its mapping.
      if (!isSessionGone(error)) throw error;

      log(`session for ${channel.slice(0, 8)} could not continue (${(error as ClientError).message}); starting a new one`);
      sessions.delete(community, channel);
    }
  }

  log(
    existing
      ? `starting a new conversation in ${channel.slice(0, 8)} (the previous session could not continue)`
      : `starting a new conversation in ${channel.slice(0, 8)} (no session on record for this channel)`,
  );
  const watchdog = silenceWatchdog(intervalMs);
  watchdog.arm("create acknowledgement");
  try {
    let created: Awaited<ReturnType<Client["sessions"]["create"]>>;
    try {
      created = await client.sessions.create({
        message,
        clientContext: { buzzCommunity: community, buzzChannel: channel },
        signal: watchdog.signal,
      });
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    watchdog.throwIfTimedOut();
    const result = await collectResponse(
      created.response,
      watchdog,
      "create response stream",
      () => created.session.state.streamIndex,
      (signal) => created.session.stream({ follow: true, startIndex: created.session.state.streamIndex, signal }),
      log,
    );
    sessions.set(community, channel, {
      id: created.session.state.sessionId,
      streamIndex: created.session.state.streamIndex,
    });
    return result;
  } finally {
    watchdog.dispose();
  }
}

/** What the room is told when eve refuses the turn itself. */
/**
 * The two answers from eve that mean the stored session cannot carry another
 * turn: an unknown session id (404), and a session that ended (409 with
 * `session_not_active`, "The session is no longer active."). A session ends
 * when one of its turns fails hard, for instance a model call that 404s at
 * the gateway; the channel must then start a fresh one.
 *
 * Only these replace the mapping. A 400 about the message, a timeout, or a
 * transport failure says nothing about whether the session is alive, and
 * discarding it on those is how conversations were lost (KYB-502). The 409
 * was missed when the timeout work narrowed the rule to 404 alone, and a
 * channel then failed every message with "The session is no longer active."
 * until someone edited the store by hand.
 */
export function isSessionGone(error: unknown): boolean {
  if (!(error instanceof ClientError)) return false;
  if (error.status === 404) return true;
  return (
    error.status === 409 &&
    (error.code === "session_not_active" || /no longer active/i.test(String(error.message ?? "")))
  );
}

export function rejectedTurnReply(error: unknown): string | null {
  if (!(error instanceof ClientError) || error.status !== 400) return null;
  const detail = String(error.message ?? "").split("\n")[0].trim().slice(0, 160);
  return detail
    ? `I couldn't read that message (${detail}). Try sending it again, or as plain text.`
    : "I couldn't read that message. Try sending it again, or as plain text.";
}

/** Give the originating channel one accurate recovery message for bridge-owned silence. */
export function agentSilenceReply(error: unknown): string | null {
  if (!(error instanceof AgentSilenceTimeoutError)) return null;
  return "The agent was silent for too long, so I stopped waiting. I kept this conversation, and you can try again here.";
}
