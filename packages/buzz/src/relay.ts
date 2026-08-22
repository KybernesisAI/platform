import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import type { AgentKey } from "./keys.js";

/**
 * The workspace protocol, as far as a member needs it.
 *
 * @remarks
 * Two transports, and which one carries what is not a style choice. Messages and the presence
 * signals go over the socket, because they are either addressed to a room or ephemeral. Anything
 * the server has to answer — a reaction it stores, a conversation it has to create and name —
 * goes over HTTP with a signed request, because the answer is the point.
 *
 * Getting that backwards is expensive: a reaction published on the socket is accepted and then
 * simply does not appear, which reads as a broken feature rather than a wrong door.
 */

/** Message in a channel. */
export const KIND_MESSAGE = 9;
/** NIP-25 reaction. */
export const KIND_REACTION = 7;
/** NIP-42 relay authentication. */
export const KIND_AUTH = 22242;
/** NIP-98 HTTP authentication. */
export const KIND_HTTP_AUTH = 27235;
/** Presence: "online" | "away" | "offline". */
export const KIND_PRESENCE = 20001;
/** Typing, scoped to a channel. */
export const KIND_TYPING = 20002;
/** Open (or find) a direct conversation with a set of people. */
export const KIND_DM_OPEN = 41010;

/**
 * A receiving client expires a typing indicator shortly after the event's own timestamp, so
 * anything slower than that has to keep saying so.
 */
export const TYPING_INTERVAL_MS = 3_000;
export const PRESENCE_INTERVAL_MS = 60_000;

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type PresenceStatus = "online" | "away" | "offline";

const now = () => Math.floor(Date.now() / 1000);

export type RelayOptions = {
  url: string;
  key: AgentKey;
  /** How often to ask for new messages. The relay answers with what it has and stops. */
  pollMs?: number;
  onMessage: (event: NostrEvent) => void;
  onLog?: (message: string) => void;
};

/**
 * The payload out of a command acknowledgement.
 *
 * @remarks
 * A command's answer arrives as `response:{…}` rather than as bare JSON, and the prefix is easy
 * to miss because the request itself succeeds: the server accepts the command, does the work,
 * and reports it — and a parser that chokes on the prefix reports the whole thing as a failure.
 * The visible symptom is a feature that silently never happens.
 */
function stripAckPrefix(message: string): string {
  return message.startsWith("response:") ? message.slice("response:".length) : message;
}

export class BuzzRelay {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** How long to wait before the next attempt, and what was last refused. */
  private backoff = 5_000;
  private refusal: string | null = null;
  /** Answered already, so a redelivery in two overlapping polls is not answered twice. */
  private readonly seen = new Set<string>();
  private cursor = now();

  private readonly url: string;
  private readonly rest: string;
  private readonly key: AgentKey;
  private readonly pollMs: number;
  private readonly onMessage: (event: NostrEvent) => void;
  private readonly log: (message: string) => void;

  constructor(options: RelayOptions) {
    this.url = options.url;
    this.rest = options.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
    this.key = options.key;
    this.pollMs = options.pollMs ?? 4_000;
    this.onMessage = options.onMessage;
    this.log = options.onLog ?? (() => {});
  }

  get pubkey(): string {
    return this.key.publicKey;
  }

  connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.authenticated = false;

    socket.addEventListener("open", () => this.log(`connected to ${this.url}`));
    socket.addEventListener("message", (raw: MessageEvent) => this.receive(String(raw.data)));
    socket.addEventListener("close", () => this.reconnect());
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* the close handler reconnects */
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try {
      this.socket?.close();
    } catch {
      /* closing a closed socket is not an error worth raising */
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    // Backs off rather than hammering. A membership refusal is the common case
    // here — an agent whose invite has not happened yet — and it is not
    // something a retry a second from now can fix, though a retry eventually
    // can, which is why this slows down instead of giving up.
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.log(`disconnected; reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => this.connect(), wait);
  }

  private receive(data: string): void {
    let frame: unknown[];
    try {
      frame = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    const type = frame[0];

    if (type === "AUTH") {
      this.send([
        "AUTH",
        finalizeEvent(
          {
            kind: KIND_AUTH,
            created_at: now(),
            tags: [
              ["relay", this.url],
              ["challenge", String(frame[1])],
            ],
            content: "",
          },
          this.key.secretKey,
        ),
      ]);
      return;
    }

    if (type === "OK" && !this.authenticated) {
      if (frame[2] !== true) {
        // Said once. Repeating it every few seconds buries everything else in
        // the log while somebody works out who has to send the invite.
        const reason = String(frame[3] ?? "");
        if (this.refusal !== reason) {
          this.refusal = reason;
          this.log(
            reason.includes("not a relay member")
              ? `not a member of this community yet — invite ${this.key.npub}`
              : `the relay refused this identity: ${reason}`,
          );
        }
        return;
      }
      this.authenticated = true;
      // A connection that works resets both.
      this.backoff = 5_000;
      this.refusal = null;
      this.log(`authenticated as ${this.key.publicKey.slice(0, 12)}…`);
      this.keepPresent();
      this.poll();
      return;
    }

    if (type === "EOSE") {
      // One poll's worth delivered. Closing it matters: the relay caps how many subscriptions one
      // connection may hold, and a bridge that never closes them stops receiving within minutes.
      this.send(["CLOSE", String(frame[1])]);
      return;
    }

    if (type !== "EVENT") return;
    const event = frame[2] as NostrEvent | undefined;
    if (!event || event.pubkey === this.key.publicKey) return;
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (event.created_at >= this.cursor) this.cursor = event.created_at + 1;
    this.onMessage(event);
  }

  private send(frame: unknown[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Ask for what is new, rather than waiting to be told.
   *
   * @remarks
   * This relay answers a subscription with the events it has and then stops; it does not hold the
   * subscription open and push what arrives next. Assuming otherwise produces the worst kind of
   * failure — a process that connects, authenticates, logs that it is listening, and silently
   * ignores every message addressed to it.
   */
  private poll(): void {
    if (this.closed) return;
    this.send(["REQ", `m${Date.now()}`, { kinds: [KIND_MESSAGE], "#p": [this.key.publicKey], since: this.cursor }]);
    this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
  }

  publish(event: { kind: number; tags: string[][]; content: string }): void {
    this.send(["EVENT", finalizeEvent({ created_at: now(), ...event }, this.key.secretKey)]);
  }

  setPresence(status: PresenceStatus): void {
    this.publish({ kind: KIND_PRESENCE, tags: [], content: status });
  }

  private keepPresent(): void {
    this.setPresence("online");
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => this.setPresence("online"), PRESENCE_INTERVAL_MS);
  }

  /** Say "typing" in a channel until the returned function is called. */
  typingIn(channel: string): () => void {
    const tick = () => this.publish({ kind: KIND_TYPING, tags: [["h", channel]], content: "" });
    tick();
    const timer = setInterval(tick, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  reply(channel: string, text: string, replyTo?: NostrEvent): void {
    const tags: string[][] = [["h", channel]];
    if (replyTo) {
      tags.push(["e", replyTo.id], ["p", replyTo.pubkey]);
    }
    this.publish({ kind: KIND_MESSAGE, tags, content: text });
  }

  /** Sign one HTTP request as this agent (NIP-98), binding the signature to the body. */
  private httpAuth(url: string, body: string): string {
    const auth = finalizeEvent(
      {
        kind: KIND_HTTP_AUTH,
        created_at: now(),
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
        content: "",
      },
      this.key.secretKey,
    );
    return `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`;
  }

  private async submit(event: unknown): Promise<{ ok: boolean; status: number; message: string }> {
    const url = `${this.rest}/events`;
    const body = JSON.stringify(event);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: this.httpAuth(url, body), "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let message = text;
    try {
      message = String((JSON.parse(text) as { message?: unknown }).message ?? text);
    } catch {
      /* a non-JSON body is its own message */
    }
    return { ok: response.ok, status: response.status, message };
  }

  /** React to a message. Stored by the server, so it goes over HTTP rather than the socket. */
  async react(eventId: string, emoji: string): Promise<void> {
    const event = finalizeEvent(
      { kind: KIND_REACTION, created_at: now(), tags: [["e", eventId]], content: emoji },
      this.key.secretKey,
    );
    const result = await this.submit(event);
    if (!result.ok) this.log(`reaction ${emoji} refused: ${result.status} ${result.message.slice(0, 120)}`);
  }

  /**
   * Open a private conversation with someone, and answer with its channel id.
   *
   * @remarks
   * Needed for anything that must reach ONE person rather than a room. Opening a conversation
   * that already exists returns the existing one, so this is safe to call whenever it is needed
   * instead of tracking which conversations exist.
   */
  async openDirectMessage(pubkey: string): Promise<string | null> {
    const event = finalizeEvent(
      { kind: KIND_DM_OPEN, created_at: now(), tags: [["p", pubkey]], content: "" },
      this.key.secretKey,
    );
    const result = await this.submit(event);
    if (!result.ok) {
      this.log(`could not open a direct message: ${result.status} ${result.message.slice(0, 120)}`);
      return null;
    }
    try {
      const ack = JSON.parse(stripAckPrefix(result.message)) as { channel_id?: unknown };
      return typeof ack.channel_id === "string" ? ack.channel_id : null;
    } catch {
      this.log(`could not read the reply to opening a direct message: ${result.message.slice(0, 120)}`);
      return null;
    }
  }
}
