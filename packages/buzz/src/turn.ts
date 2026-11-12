import {
  ClientError,
  ClientSessionStrandedError,
  type Client,
  type ClientSession,
  type CreatedClientSession,
  type MessagePart,
  type SendTurnInput,
  type SessionStreamEvent,
} from "eve/client";
import {
  cardsOf,
  newStepState,
  noteCall,
  openedRequests,
  progressGate,
  progressNotes,
  readStep,
  replyText,
  settledRequestIds,
  turnIdOf,
  type CallNames,
  type Card,
  type StreamEvent,
} from "@kybernesis/cards";
import { inputRequestFrom, type InputRequest } from "./eve-input.js";
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

/**
 * A phase that runs BEFORE the message is sent to the agent.
 *
 * The unread drain runs before the send, so a timeout here means the message
 * never reached the agent and no run was created. Every other phase — the
 * send/create acknowledgement and the response stream — is after the POST that
 * delivers it, so by then the agent has the message. This is the difference
 * between a lost message and a lost turn, and the recovery text turns on it.
 */
const isPreSendPhase = (phase: AgentSilencePhase): boolean => phase === "unread drain";


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

/**
 * Called with a turn's "on it" note the moment the agent sends one: a short
 * line saying it has started a long job, posted before the result so the room
 * can tell work from a hang (the `working_on_it` tool, see @kybernesis/cards
 * `progressNotes`). At most once per turn.
 */
export type ProgressListener = (text: string) => void;

/** The receipt eve hands back for one accepted message. */
type Delivery = Awaited<ReturnType<ClientSession["send"]>>;

/** How a turn's request ended: answered, waiting on a person, or failed. */
export type TurnStatus = "completed" | "waiting" | "failed";

/** Everything the bridge needs to decide how one eve turn should be rendered. */
export interface TurnOutcome {
  message: string;
  status: TurnStatus;
  inputRequests: readonly InputRequest[];
  sessionId: string;
  streamIndex: number;
  /** Failures seen on the stream, in order. Empty on a clean turn. */
  failures: readonly TurnFailure[];
  /** Cards the turn's tools handed back, read the way the apps read them. */
  cards: readonly Card[];
}

const clip = (text: unknown, max = 200): string => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Read a failure out of one stream event, or nothing when the event is not one.
 *
 * eve 1.0 settles a call with only its id, so pass the calls seen so far
 * (`noteCall`) for the failure to name its tool. eve 0.81 events are read too.
 */
export function failureFromEvent(event: { type: string; data?: unknown }, calls?: CallNames): TurnFailure | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const error = (data.error ?? {}) as Record<string, unknown>;
  if (event.type === "call.settled") {
    if (data.outcome !== "failed" && data.outcome !== "rejected") return null;
    const output = typeof data.output === "string" ? data.output : data.output !== undefined ? JSON.stringify(data.output) : "";
    const name = typeof data.callId === "string" ? calls?.get(data.callId)?.name : undefined;
    return { kind: "tool", toolName: name ?? "a tool", message: clip(error.message ?? (output || data.outcome)) };
  }
  if (event.type === "model.settled") {
    if (data.outcome !== "failed") return null;
    return { kind: "model", code: String(error.code ?? "model.failed"), message: clip(error.message) };
  }
  if (event.type === "turn.settled") {
    if (data.outcome !== "failed") return null;
    return { kind: "model", code: String(error.code ?? "turn.failed"), message: clip(error.message) };
  }
  if (event.type === "action.result") {
    const result = (data.result ?? {}) as Record<string, unknown>;
    const failed = data.status === "failed" || data.status === "rejected" || result.isError === true;
    if (!failed) return null;
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
  const dataUrl = (bytes: Uint8Array, mediaType: string) => `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

  const parts: MessagePart[] = [];
  if (text) parts.push({ type: "text", text });

  for (const ref of attachments) {
    try {
      const media = await fetchAttachment(ref);
      if (isImage(media.mediaType)) {
        parts.push({ type: "file", data: dataUrl(media.bytes, media.mediaType), mediaType: media.mediaType });
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
  stream: (signal: AbortSignal) => AsyncIterable<SessionStreamEvent>,
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

/**
 * Read one request's events, from the line that admitted it to the line that
 * settled it.
 *
 * eve 1.0 hands every send a delivery whose stream is exactly that, so the
 * stale-tail problem 0.81 had (a send's stream opening on the previous turn's
 * boundary and reading it as the answer) is gone by construction. Events of
 * another turn can still sit inside the window, such as the turn this message
 * cancelled settling: only events of this delivery's own turn count.
 */
async function collectDelivery(
  delivery: Delivery,
  watchdog: SilenceWatchdog,
  phase: AgentSilencePhase,
  streamIndex: () => number,
  log: (message: string) => void = () => {},
  onProgress?: ProgressListener,
): Promise<TurnOutcome> {
  const freshNote = progressGate();
  const calls: CallNames = new Map();
  let message = "";
  let status: TurnStatus = "completed";
  let inputRequests: InputRequest[] = [];
  const failures: TurnFailure[] = [];
  const steps = newStepState();
  let ownTurn: string | undefined;

  let settledOwn = false;
  /** Events of some turn, read before this delivery named its own: kept until it does. */
  let early: StreamEvent[] = [];

  const take = (event: StreamEvent): void => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    noteCall(calls, event);
    readStep(steps, event.type, event.data, event.meta, event.scope);
    if (onProgress) {
      for (const note of progressNotes(event.type, event.data, event.scope)) {
        if (!freshNote(note)) continue;
        try {
          onProgress(note.text);
        } catch (error) {
          log(`could not post the progress note: ${(error as Error).message}`);
        }
      }
    }
    const failure = failureFromEvent(event, calls);
    if (failure) failures.push(failure);
    // The last answer the turn gave, as before: a turn held for its tasks says
    // "I've asked the researcher", then the answer once the task reports.
    const reply = replyText(event);
    if (reply?.trim()) message = reply;
    inputRequests.push(...openedRequests(event, calls).map(inputRequestFrom));
    const settled = new Set(settledRequestIds(event));
    if (settled.size) inputRequests = inputRequests.filter((r) => !settled.has(r.requestId));
    if (event.type === "turn.settled" && data.outcome === "failed") status = "failed";
    if (event.type === "session.ended") status = data.outcome === "failed" ? "failed" : "completed";
  };

  const learnTurn = (turnId: string) => {
    if (ownTurn) return;
    ownTurn = turnId;
    const kept = early.filter((e) => turnIdOf(e) === turnId);
    early = [];
    for (const e of kept) take(e);
  };

  const consume = (raw: SessionStreamEvent): void => {
    watchdog.arm(phase);
    const event = raw as unknown as StreamEvent;
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "delivery.consumed" && data.deliveryId === delivery.deliveryId && typeof data.turnId === "string") {
      learnTurn(data.turnId);
      return;
    }
    if (event.type === "delivery.settled" && data.deliveryId === delivery.deliveryId) {
      if (typeof data.turnId === "string") learnTurn(data.turnId);
      status = data.outcome === "awaiting-input" ? "waiting" : data.outcome === "failed" || data.outcome === "refused" ? "failed" : "completed";
      settledOwn = true;
      return;
    }
    const turn = turnIdOf(event);
    if (turn && !ownTurn) {
      early.push(event);
      return;
    }
    if (turn && turn !== ownTurn) return;
    take(event);
  };

  watchdog.arm(phase);
  try {
    try {
      for await (const event of delivery.stream({ signal: watchdog.signal })) {
        consume(event);
        // The settlement's whole line is read, then this request is done.
        if (settledOwn && (event as { meta?: { endOfLine?: boolean } }).meta?.endOfLine !== false) break;
      }
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    watchdog.throwIfTimedOut();
    // A stream that never named this delivery's turn: what it read is all there is.
    if (!ownTurn) for (const e of early.splice(0)) take(e);
    return {
      message,
      status,
      inputRequests,
      sessionId: delivery.sessionId,
      streamIndex: streamIndex(),
      failures,
      cards: cardsOf(steps.steps.values()),
    };
  } finally {
    watchdog.dispose();
  }
}

async function sendExisting(
  send: (signal: AbortSignal) => Promise<Delivery>,
  streamIndex: () => number,
  timeouts: AgentTimeouts,
  log: (message: string) => void = () => {},
  onProgress?: ProgressListener,
): Promise<TurnOutcome> {
  const watchdog = silenceWatchdog(timeouts);
  watchdog.arm("send acknowledgement");
  try {
    let delivery: Delivery;
    try {
      delivery = await send(watchdog.signal);
    } catch (error) {
      watchdog.throwIfTimedOut();
      throw error;
    }
    watchdog.throwIfTimedOut();
    return await collectDelivery(delivery, watchdog, "response stream", streamIndex, log, onProgress);
  } finally {
    watchdog.dispose();
  }
}

/**
 * How long reading the backlog of a conversation on record may take before the
 * conversation is treated as gone. An idle session's unread events arrive in
 * well under a second; a session whose durable run died under a runtime
 * upgrade never finishes. On 2026-10-05 a Buzz channel's stored run had failed
 * replay after the eve 0.68 cutover, and every message in that channel sat at
 * "typing" with nothing reaching the agent, for as long as anyone waited.
 */
export const DEFAULT_UNREAD_DRAIN_TIMEOUT_MS = 20_000;

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
  unreadDrainTimeoutMs = DEFAULT_UNREAD_DRAIN_TIMEOUT_MS,
  onProgress?: ProgressListener,
): Promise<TurnOutcome> {
  const intervalMs: AgentTimeouts = {
    silenceMs: validateAgentSilenceTimeoutMs(agentSilenceTimeoutMs),
    workMs: validateAgentSilenceTimeoutMs(agentWorkTimeoutMs),
  };
  // Never longer than the silence bound, so a caller that tightened silence tightened this too.
  const drainMs = Math.min(validateAgentSilenceTimeoutMs(unreadDrainTimeoutMs), intervalMs.silenceMs);
  const existing = sessions.get(community, channel);
  if (existing) {
    try {
      // attach() is local and performs no network I/O.
      const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });

      /**
       * Move to the true end of the conversation before speaking.
       *
       * `send()` opens its response stream at the position the handle already
       * holds and stops at the FIRST turn boundary it meets. Draining first
       * repairs any cursor that was left behind by a prior disconnected reader.
       * Bounded on its own, tightly: this read is of a backlog, not of work.
       * A backlog that does not finish is not proof of anything by itself —
       * the run behind it may be dead (eve 0.68 cutover, 2026-10-05: a stored
       * run that failed replay streamed nothing, and the channel sat at
       * "typing" for good) or the transport may be having a moment. So the
       * stall is logged and the send goes ahead: the agent's answer to the
       * send decides. 404 / "no longer active" replaces the session below; a
       * real reply continues it; a transport failure preserves it.
       */
      let unread = 0;
      try {
        unread = await drainUnread(
          (signal) => session.stream({ follow: false, startIndex: existing.streamIndex, signal }),
          { silenceMs: drainMs, workMs: drainMs },
        );
      } catch (error) {
        if (!(error instanceof AgentSilenceTimeoutError)) throw error;
        log(`backlog of ${channel.slice(0, 8)} (${existing.id}) did not finish reading in ${drainMs}ms; asking the agent directly`);
      }
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
        log,
        onProgress,
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

      log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
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
    // `sessions.create` is overloaded (message → first turn; none → idle) and
    // ReturnType picks the last overload, so the first-turn shape is named.
    let created: CreatedClientSession;
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
    const result = await collectDelivery(
      created.delivery,
      watchdog,
      "create response stream",
      () => created.session.state.streamIndex,
      log,
      onProgress,
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
 * The answers from eve that mean the stored session cannot carry another
 * turn: an unknown session id (404), a session that ended (409 with
 * `session_not_active`, "The session is no longer active."), and one whose
 * history expired (410 `session_expired`). A session ends
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
  // An eve upgrade strands every conversation the old version ran (409
  // session_stranded): it can never take another turn, so start over.
  if (ClientSessionStrandedError.is(error)) return true;
  if (!(error instanceof ClientError)) return false;
  if (error.status === 409 && error.code === "session_stranded") return true;
  // 410 session_expired, "Session history is no longer available.": a run that
  // ended (a failed turn ends the session) can no longer be read. Seen on
  // 2026-10-24 when the next message in a channel failed instead of starting over.
  if (error.status === 404 || error.status === 410) return true;
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

/**
 * Give the originating channel one accurate recovery message for bridge-owned silence.
 *
 * Two different failures wear the same timeout. Before the send, a stalled
 * unread drain means the message never reached the agent: "try again here" is
 * actively wrong, because there is nothing to resume and the agent will answer
 * whatever it last genuinely received — a confident reply to a question nobody
 * asked. After the send, the message did reach the agent and the conversation
 * is kept, so trying again is the right advice. The phase on the error tells
 * the two apart.
 */
export function agentSilenceReply(error: unknown): string | null {
  if (!(error instanceof AgentSilenceTimeoutError)) return null;
  if (isPreSendPhase(error.phase)) {
    return "I couldn't get your message to the agent before it went quiet, so it was not delivered — nothing was sent and no answer is coming. Please send it again.";
  }
  return "The agent was silent for too long, so I stopped waiting. I kept this conversation, and you can try again here.";
}
