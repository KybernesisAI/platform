import {
  ClientError,
  createDataUrlFilePart,
  resolveTextToResponses,
  type Client,
  type InputRequest,
  type MessageResponse,
  type MessageStreamEvent,
  type SendTurnInput,
} from "eve/client";
import { isImage, type FetchedMedia, type MediaRef } from "./media.js";
import type { BuzzRelay, NostrEvent } from "./relay.js";
import { SessionStore } from "./sessions.js";

export type TurnMessage = SendTurnInput["message"];

type RelaySurface = Pick<BuzzRelay, "reply" | "typingIn">;
type ClientFactory = (pubkey: string) => Client;
type RelayFactory = (community: string) => RelaySurface | undefined;

type TurnProjection = { anchor?: NostrEvent; message?: string };
type FollowerRuntime = {
  sessionId: string;
  abort: AbortController;
  ready: Promise<void>;
  anchors: NostrEvent[];
  turns: Map<string, TurnProjection>;
  submittingRequestIds: Set<string>;
  seenEventIds: Set<string>;
  stopTyping?: () => void;
};

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
        parts.push(createDataUrlFilePart({ bytes: media.bytes, mediaType: media.mediaType }));
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

/** Render every request in an Eve HITL batch without assuming its kind. */
export function renderInputRequests(requests: readonly InputRequest[]): string {
  const lines = ["Input needed before I can continue:"];
  requests.forEach((request, requestIndex) => {
    if (requests.length > 1) lines.push("", `${requestIndex + 1}. ${request.prompt}`);
    else lines.push("", request.prompt);
    request.options?.forEach((option, optionIndex) => {
      const description = option.description ? ` — ${option.description}` : "";
      lines.push(`   ${optionIndex + 1}. ${option.label}${description} [${option.id}]`);
    });
    if (request.allowFreeform === true || !request.options?.length) {
      lines.push("   A written answer is allowed.");
    }
  });
  lines.push("", "Reply to this prompt with an option number, label, ID, or allowed written answer.");
  return lines.join("\n");
}

export function invalidInputReply(requests: readonly InputRequest[]): string {
  const choices = requests.flatMap((request) => request.options?.map((option, index) =>
    `${index + 1}, ${option.label}, or ${option.id}`) ?? []);
  return choices.length > 0
    ? `That does not match this prompt. Reply with ${choices.join("; ")}${requests.some((r) => r.allowFreeform) ? ", or a written answer" : ""}.`
    : "That reply could not be used for this prompt. Reply with a non-empty written answer.";
}

/**
 * Owns one durable Eve stream follower per Buzz channel. Submission HTTP
 * responses are drained only to release their bodies; this projection is the
 * sole owner of visible assistant output.
 */
export class SessionCoordinator {
  readonly #sessions: SessionStore;
  readonly #clientFor: ClientFactory;
  readonly #relayFor: RelayFactory;
  readonly #log: (message: string) => void;
  readonly #followers = new Map<string, FollowerRuntime>();
  #stopped = false;

  constructor(options: {
    sessions: SessionStore;
    clientFor: ClientFactory;
    relayFor: RelayFactory;
    log?: (message: string) => void;
  }) {
    this.#sessions = options.sessions;
    this.#clientFor = options.clientFor;
    this.#relayFor = options.relayFor;
    this.#log = options.log ?? (() => {});
  }

  resumeStored(): void {
    for (const { community, channel, session } of this.#sessions.entries()) {
      if (session.speakerPubkey) {
        void this.ensureFollower(community, channel, session.speakerPubkey).catch((error) =>
          this.#log(`could not resume Buzz session for ${channel.slice(0, 8)}: ${(error as Error).message}`));
      }
    }
  }

  async submitMessage(
    community: string,
    channel: string,
    pubkey: string,
    message: TurnMessage,
    anchor: NostrEvent,
  ): Promise<void> {
    const existing = this.#sessions.get(community, channel);
    if (existing) {
      try {
        const runtime = await this.ensureFollower(community, channel, pubkey);
        runtime.anchors.push(anchor);
        this.#sessions.update(community, channel, (stored) => ({ ...stored, speakerPubkey: pubkey }));
        const session = this.#clientFor(pubkey).sessions.attach(existing.id, {
          streamIndex: this.#sessions.get(community, channel)?.streamIndex ?? existing.streamIndex,
        });
        const response = await session.send(message, {
          clientContext: { buzzCommunity: community, buzzChannel: channel },
        });
        this.#drain(response);
        return;
      } catch (error) {
        if (error instanceof ClientError && error.status === 400) throw error;
        this.#log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
        this.replaceSession(community, channel);
      }
    }

    const created = await this.#clientFor(pubkey).sessions.create({
      message,
      clientContext: { buzzCommunity: community, buzzChannel: channel },
    });
    this.#sessions.set(community, channel, {
      id: created.session.state.sessionId,
      streamIndex: 0,
      speakerPubkey: pubkey,
      pendingPrompts: [],
      deliveredTurnIds: [],
    });
    await this.ensureFollower(community, channel, pubkey, anchor);
    this.#drain(created.response);
  }

  async respondToPrompt(
    community: string,
    channel: string,
    pubkey: string,
    text: string,
    reply: NostrEvent,
  ): Promise<"ordinary" | "invalid" | "submitted"> {
    const stored = this.#sessions.get(community, channel);
    if (!stored) return "ordinary";
    const references = new Set(reply.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]));
    const prompt = stored.pendingPrompts?.find((candidate) => references.has(candidate.promptEventId));
    if (!prompt) return "ordinary";

    const runtime = await this.ensureFollower(community, channel, pubkey);
    const requests = prompt.requests.filter((request) => !runtime.submittingRequestIds.has(request.requestId));
    const responses = resolveTextToResponses(text, requests);
    if (responses.length === 0) return "invalid";

    for (const response of responses) runtime.submittingRequestIds.add(response.requestId);
    runtime.anchors.push(reply);
    this.#sessions.update(community, channel, (session) => ({ ...session, speakerPubkey: pubkey }));
    try {
      const latest = this.#sessions.get(community, channel);
      if (!latest?.pendingPrompts?.some((candidate) => candidate.promptEventId === prompt.promptEventId)) {
        for (const response of responses) runtime.submittingRequestIds.delete(response.requestId);
        runtime.anchors.pop();
        return "invalid";
      }
      const session = this.#clientFor(pubkey).sessions.attach(stored.id, { streamIndex: latest.streamIndex });
      const response = await session.respond(responses, {
        clientContext: { buzzCommunity: community, buzzChannel: channel },
      });
      this.#drain(response);
      return "submitted";
    } catch (error) {
      for (const response of responses) runtime.submittingRequestIds.delete(response.requestId);
      const index = runtime.anchors.lastIndexOf(reply);
      if (index >= 0) runtime.anchors.splice(index, 1);
      throw error;
    }
  }

  correctionFor(community: string, channel: string, reply: NostrEvent): string {
    const references = new Set(reply.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]));
    const prompt = this.#sessions.get(community, channel)?.pendingPrompts?.find((candidate) =>
      references.has(candidate.promptEventId));
    return invalidInputReply(prompt?.requests ?? []);
  }

  replaceSession(community: string, channel: string): void {
    const key = SessionStore.key(community, channel);
    const runtime = this.#followers.get(key);
    runtime?.abort.abort();
    runtime?.stopTyping?.();
    this.#followers.delete(key);
    this.#sessions.delete(community, channel);
  }

  stop(): void {
    this.#stopped = true;
    for (const runtime of this.#followers.values()) {
      runtime.abort.abort();
      runtime.stopTyping?.();
    }
    this.#followers.clear();
  }

  async ensureFollower(
    community: string,
    channel: string,
    pubkey: string,
    initialAnchor?: NostrEvent,
  ): Promise<FollowerRuntime> {
    const stored = this.#sessions.get(community, channel);
    if (!stored) throw new Error("Buzz channel has no Eve session");
    const key = SessionStore.key(community, channel);
    const current = this.#followers.get(key);
    if (current?.sessionId === stored.id && !current.abort.signal.aborted) {
      await current.ready;
      return current;
    }
    current?.abort.abort();
    current?.stopTyping?.();

    const abort = new AbortController();
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const runtime: FollowerRuntime = {
      sessionId: stored.id,
      abort,
      ready: new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      }),
      anchors: initialAnchor ? [initialAnchor] : [],
      turns: new Map(),
      submittingRequestIds: new Set(),
      seenEventIds: new Set(),
    };
    this.#followers.set(key, runtime);
    void this.#runFollower(community, channel, pubkey, runtime, readyResolve, readyReject);
    await runtime.ready;
    return runtime;
  }

  async #runFollower(
    community: string,
    channel: string,
    pubkey: string,
    runtime: FollowerRuntime,
    ready: () => void,
    rejectReady: (error: unknown) => void,
  ): Promise<void> {
    let first = true;
    try {
      while (!runtime.abort.signal.aborted && !this.#stopped) {
        const stored = this.#sessions.get(community, channel);
        if (!stored || stored.id !== runtime.sessionId) return;
        const session = this.#clientFor(stored.speakerPubkey ?? pubkey).sessions.attach(stored.id, {
          streamIndex: stored.streamIndex,
        });
        try {
          if (first) {
            let caughtUp = 0;
            for await (const event of session.stream({
              follow: false,
              startIndex: stored.streamIndex,
              signal: runtime.abort.signal,
              streamReconnectPolicy: { reconnect: false },
            })) {
              caughtUp += 1;
              this.#project(community, channel, runtime, event);
              this.#persistCursor(community, channel, session.state.streamIndex);
            }
            if (caughtUp > 0) this.#log(`caught up on ${caughtUp} unread event(s) in ${channel.slice(0, 8)}`);
            first = false;
            ready();
          }
          const latest = this.#sessions.get(community, channel);
          if (!latest) return;
          const following = this.#clientFor(latest.speakerPubkey ?? pubkey).sessions.attach(latest.id, {
            streamIndex: latest.streamIndex,
          });
          for await (const event of following.stream({
            follow: true,
            startIndex: latest.streamIndex,
            signal: runtime.abort.signal,
            streamReconnectPolicy: { reconnect: false },
          })) {
            this.#project(community, channel, runtime, event);
            this.#persistCursor(community, channel, following.state.streamIndex);
          }
          if (!runtime.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          if (runtime.abort.signal.aborted) return;
          if (first) throw error;
          this.#log(`Buzz session stream for ${channel.slice(0, 8)} disconnected (${(error as Error).message}); reconnecting`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      rejectReady(error);
      if (this.#followers.get(SessionStore.key(community, channel)) === runtime) {
        this.#followers.delete(SessionStore.key(community, channel));
      }
    }
  }

  #project(community: string, channel: string, runtime: FollowerRuntime, event: MessageStreamEvent): void {
    if (event.meta?.id && runtime.seenEventIds.has(event.meta.id)) return;
    if (event.meta?.id) runtime.seenEventIds.add(event.meta.id);
    const relay = this.#relayFor(community);
    if (!relay) return;

    if (event.type === "turn.started") {
      runtime.turns.set(event.data.turnId, { anchor: runtime.anchors.shift() });
      runtime.stopTyping?.();
      runtime.stopTyping = relay.typingIn(channel);
      return;
    }
    if (event.type === "message.completed") {
      const text = event.data.message?.trim();
      if (text) {
        const turn = runtime.turns.get(event.data.turnId) ?? {};
        turn.message = text;
        runtime.turns.set(event.data.turnId, turn);
      }
      return;
    }
    if (event.type === "input.requested") {
      const turn = runtime.turns.get(event.data.turnId);
      const promptEvent = relay.reply(channel, renderInputRequests(event.data.requests), turn?.anchor);
      this.#sessions.update(community, channel, (session) => ({
        ...session,
        pendingPrompts: [
          ...(session.pendingPrompts ?? []).filter((pending) =>
            !pending.requests.some((old) => event.data.requests.some((request) => request.requestId === old.requestId))),
          { promptEventId: promptEvent.id, requests: event.data.requests },
        ],
      }));
      runtime.stopTyping?.();
      runtime.stopTyping = undefined;
      return;
    }
    if (event.type === "input.resolved") {
      const resolved = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
      for (const requestId of resolved) runtime.submittingRequestIds.delete(requestId);
      this.#sessions.update(community, channel, (session) => ({
        ...session,
        pendingPrompts: (session.pendingPrompts ?? []).flatMap((pending) => {
          const requests = pending.requests.filter((request) => !resolved.has(request.requestId));
          return requests.length > 0 ? [{ ...pending, requests }] : [];
        }),
      }));
      return;
    }
    if (event.type === "turn.completed") {
      this.#flushTurn(community, channel, runtime, event.data.turnId, relay);
      return;
    }
    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      runtime.turns.delete(event.data.turnId);
      runtime.stopTyping?.();
      runtime.stopTyping = undefined;
      return;
    }
    if (event.type === "session.failed") {
      runtime.stopTyping?.();
      runtime.stopTyping = undefined;
      this.#log(`Eve session failed in ${channel.slice(0, 8)}: ${event.data.message}`);
    }
  }

  #flushTurn(
    community: string,
    channel: string,
    runtime: FollowerRuntime,
    turnId: string,
    relay: RelaySurface,
  ): void {
    const turn = runtime.turns.get(turnId);
    runtime.turns.delete(turnId);
    runtime.stopTyping?.();
    runtime.stopTyping = undefined;
    if (!turn?.message) return;
    const stored = this.#sessions.get(community, channel);
    if (stored?.deliveredTurnIds?.includes(turnId)) return;
    relay.reply(channel, turn.message, turn.anchor);
    this.#sessions.update(community, channel, (session) => ({
      ...session,
      deliveredTurnIds: [...(session.deliveredTurnIds ?? []), turnId],
    }));
    this.#log(`replied (${turn.message.length} chars)`);
  }

  #persistCursor(community: string, channel: string, streamIndex: number): void {
    this.#sessions.update(community, channel, (session) => ({ ...session, streamIndex }));
  }

  #drain(response: MessageResponse<unknown>): void {
    void (async () => {
      try {
        for await (const _ of response) {
          // Durable follower owns projection; consume only to release the HTTP body.
        }
      } catch (error) {
        this.#log(`initiating Eve response stream ended (${(error as Error).message}); durable follower remains attached`);
      }
    })();
  }
}

export function rejectedTurnReply(error: unknown): string | null {
  if (!(error instanceof ClientError) || error.status !== 400) return null;
  const detail = String(error.message ?? "").split("\n")[0].trim().slice(0, 160);
  return detail
    ? `I couldn't read that message (${detail}). Try sending it again, or as plain text.`
    : "I couldn't read that message. Try sending it again, or as plain text.";
}
