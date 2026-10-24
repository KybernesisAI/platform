import { createHash, randomUUID } from "node:crypto";
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
/** Relay-signed channel metadata (NIP-29); its first `t` tag is the channel type. */
export const KIND_CHANNEL_METADATA = 39000;
/** Relay-signed channel roster (NIP-29): one `p` tag per member. */
export const KIND_CHANNEL_MEMBERS = 39002;

/**
 * A receiving client expires a typing indicator shortly after the event's own timestamp, so
 * anything slower than that has to keep saying so.
 */
export const TYPING_INTERVAL_MS = 3_000;
export const PRESENCE_INTERVAL_MS = 60_000;
/** Enough overlap for same-second redelivery without retaining every event forever. */
export const MAX_SEEN_EVENT_IDS = 10_000;
/** How often to re-read which direct conversations this agent is in. */
export const DIRECT_REFRESH_MS = 30_000;
/** Ids per `#d`/`#h` filter, and filters per request: the relay caps a request at ten. */
const IDS_PER_FILTER = 200;
const MAX_FILTERS = 8;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** How long to wait before the next attempt, and what was last refused. */
  private backoff = 5_000;
  private refusal: string | null = null;
  /** Answered already, so a redelivery in two overlapping polls is not answered twice. */
  private readonly seen = new Set<string>();
  private cursor = now();
  /** Prompts this agent posted; replies to them are polled for even when they carry no mention. */
  private readonly replyWatch = new Set<string>();
  /**
   * One-to-one direct conversations this agent is in, by channel id.
   *
   * @remarks
   * A direct message used to reach the bridge because the client tagged every other
   * participant, so the `#p` poll found it like a mention. The current Buzz app tags only
   * explicit mentions, so a person typing to the agent in a DM was never seen: the agent
   * answered in a DM only when named, which is not how anyone talks to one person. Buzz's own
   * agents decide by the channel instead (a DM of exactly two members is addressed to the
   * other one), and so does this: the relay's signed rosters say which DMs the agent is in,
   * and those channels are polled whole.
   */
  private direct = new Set<string>();
  /** The relay's own signing key (NIP-11 `self`), which every roster must carry. */
  private relaySelf: string | null | undefined = undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** One discovery at a time: rosters first, then the metadata for those channels. */
  private discovery: {
    rosterSub: string;
    metadataSub: string | null;
    rosters: Map<string, Set<string>>;
    dms: Set<string>;
    startedAt: number;
  } | null = null;
  /** Since when a newly found DM is read back, so a message sent before it was found is not lost. */
  private discoveredAt: number | null = null;

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

  /** Also poll for replies to these events — a person answering a prompt rarely mentions the asker. */
  watchReplies(ids: Iterable<string>): void {
    for (const id of ids) this.replyWatch.add(id);
  }

  unwatchReplies(ids: Iterable<string>): void {
    for (const id of ids) this.replyWatch.delete(id);
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

  /** Whether this channel is a one-to-one DM with this agent: every message in it is addressed. */
  isDirect(channel: string): boolean {
    return this.direct.has(channel);
  }

  close(): void {
    this.closed = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.presenceTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.discoveryTimer = null;
    try {
      this.socket?.close();
    } catch {
      /* closing a closed socket is not an error worth raising */
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.presenceTimer = null;
    this.pollTimer = null;
    this.discoveryTimer = null;
    this.discovery = null;
    if (this.reconnectTimer) return;
    // Backs off rather than hammering. A membership refusal is the common case
    // here — an agent whose invite has not happened yet — and it is not
    // something a retry a second from now can fix, though a retry eventually
    // can, which is why this slows down instead of giving up.
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.log(`disconnected; reconnecting in ${Math.round(wait / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
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
      this.discoverDirect();
      this.poll();
      return;
    }

    if (type === "EOSE") {
      // One poll's worth delivered. Closing it matters: the relay caps how many subscriptions one
      // connection may hold, and a bridge that never closes them stops receiving within minutes.
      this.send(["CLOSE", String(frame[1])]);
      this.discoveryDone(String(frame[1]));
      return;
    }

    if (type === "CLOSED") {
      // A refused discovery must not wedge the next one.
      this.discoveryDone(String(frame[1]), true);
      return;
    }

    if (type !== "EVENT") return;
    if (this.discovery && (frame[1] === this.discovery.rosterSub || frame[1] === this.discovery.metadataSub)) {
      this.discovered(frame[2] as NostrEvent | undefined);
      return;
    }
    const event = frame[2] as NostrEvent | undefined;
    if (!event || event.pubkey === this.key.publicKey) return;
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    // Nostr timestamps have one-second precision and `since` is inclusive. Keep
    // the latest second in the next poll; the seen set removes redelivery while
    // allowing another event created during that same second to arrive.
    if (event.created_at > this.cursor) this.cursor = event.created_at;
    this.onMessage(event);
  }

  private send(frame: unknown[]): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
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
  poll(): void {
    if (this.closed) return;
    const filters: Record<string, unknown>[] = [
      { kinds: [KIND_MESSAGE], "#p": [this.key.publicKey], since: this.cursor },
    ];
    if (this.replyWatch.size > 0) {
      filters.push({ kinds: [KIND_MESSAGE], "#e": [...this.replyWatch], since: this.cursor });
    }
    for (const ids of chunks([...this.direct], MAX_FILTERS - filters.length)) {
      filters.push({ kinds: [KIND_MESSAGE], "#h": ids, since: this.cursor });
    }
    this.send(["REQ", `m${Date.now()}`, ...filters]);
    this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
  }

  /**
   * Find the one-to-one DMs this agent is in: its rosters, then which of those channels are DMs.
   *
   * @remarks
   * Rosters and metadata are relay-signed; anything else claiming to be one is ignored, so a
   * member cannot publish a roster that makes the agent answer every message in a room.
   */
  private discoverDirect(): void {
    if (this.closed) return;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => this.discoverDirect(), DIRECT_REFRESH_MS);
    if (this.discovery && now() - this.discovery.startedAt < 60) return;
    void this.relayKey().then((self) => {
      if (this.closed || self === undefined) return;
      const rosterSub = `r${Date.now()}`;
      this.discovery = { rosterSub, metadataSub: null, rosters: new Map(), dms: new Set(), startedAt: now() };
      this.send(["REQ", rosterSub, { kinds: [KIND_CHANNEL_MEMBERS], "#p": [this.key.publicKey], limit: 1000 }]);
    });
  }

  /** NIP-11 `self`: null when the relay names none, undefined when it could not be asked. */
  private async relayKey(): Promise<string | null | undefined> {
    if (this.relaySelf !== undefined) return this.relaySelf;
    try {
      const response = await fetch(this.rest, {
        headers: { accept: "application/nostr+json" },
        signal: AbortSignal.timeout(10_000),
      });
      const info = (await response.json()) as { self?: unknown; pubkey?: unknown };
      const self = [info.self, info.pubkey].find((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
      this.relaySelf = (self as string | undefined) ?? null;
    } catch (error) {
      this.log(`could not read the relay's information document (${(error as Error).message}); direct messages wait for the next try`);
    }
    return this.relaySelf;
  }

  private discovered(event: NostrEvent | undefined): void {
    const discovery = this.discovery;
    if (!discovery || !event) return;
    if (this.relaySelf && event.pubkey !== this.relaySelf) return;
    const id = event.tags.find((t) => t[0] === "d")?.[1];
    if (!id) return;
    if (event.kind === KIND_CHANNEL_MEMBERS) {
      discovery.rosters.set(id, new Set(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]!)));
      return;
    }
    // NIP-29 as Buzz writes it: the FIRST `t` is the channel's type; later ones are labels.
    const type = event.tags.find((t) => t[0] === "t")?.[1];
    const members = discovery.rosters.get(id);
    if (event.kind === KIND_CHANNEL_METADATA && type === "dm" && members?.size === 2 && members.has(this.key.publicKey)) {
      discovery.dms.add(id);
    }
  }

  private discoveryDone(sub: string, refused = false): void {
    const discovery = this.discovery;
    if (!discovery) return;
    if (refused) {
      // Only a subscription still in flight can be refused. This relay answers every CLOSE we
      // send with a CLOSED of its own, so the roster's echo arrives after the metadata request
      // has gone out; treating it as a refusal dropped every discovery.
      const inFlight = discovery.metadataSub === null ? discovery.rosterSub : discovery.metadataSub;
      if (sub === inFlight) this.discovery = null;
      return;
    }
    if (sub === discovery.rosterSub) {
      const ids = [...discovery.rosters.keys()];
      if (ids.length === 0) return this.adopt(new Set());
      discovery.metadataSub = `g${Date.now()}`;
      this.send([
        "REQ",
        discovery.metadataSub,
        ...chunks(ids, MAX_FILTERS).map((chunk) => ({ kinds: [KIND_CHANNEL_METADATA], "#d": chunk })),
      ]);
      return;
    }
    if (sub === discovery.metadataSub) this.adopt(discovery.dms);
  }

  /** Take the DMs just found; read back any that are new, from when they could last have been missed. */
  private adopt(found: Set<string>): void {
    // Overlap the last discovery by a few seconds; the first one starts where polling did.
    const since = this.discoveredAt === null ? this.cursor : this.discoveredAt - 5;
    const fresh = [...found].filter((id) => !this.direct.has(id));
    this.direct = new Set(found);
    this.discovery = null;
    this.discoveredAt = now();
    if (fresh.length > 0) {
      this.log(`direct messages: ${found.size} conversation(s), ${fresh.length} new`);
      // The poll's cursor may already be past a message sent in a DM before it was found.
      const filters = chunks(fresh, MAX_FILTERS).map((ids) => ({ kinds: [KIND_MESSAGE], "#h": ids, since }));
      this.send(["REQ", `m${Date.now()}c`, ...filters]);
    }
  }

  /** Publish one event; returns its id when it left this process, null when the socket was down. */
  publish(event: { kind: number; tags: string[][]; content: string }): string | null {
    const signed = finalizeEvent({ created_at: now(), ...event }, this.key.secretKey);
    return this.send(["EVENT", signed]) ? signed.id : null;
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

  reply(channel: string, text: string, replyTo?: NostrEvent): string | null {
    const tags: string[][] = [["h", channel]];
    if (replyTo) {
      tags.push(["e", replyTo.id], ["p", replyTo.pubkey]);
    }
    return this.publish({ kind: KIND_MESSAGE, tags, content: text });
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
          // A nonce, because the relay rejects a repeated auth event as a replay.
          // Without it two identical requests — the same query twice, the same
          // reaction twice — sign byte-identically and the second is refused. The
          // refusal does not always look like one either: a duplicated read came
          // back as an empty list, so an agent reported an empty workspace instead
          // of a rejected request.
          ["nonce", randomUUID()],
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

/** Split ids into at most `max` filters' worth; ids beyond that are dropped, never a filter too many. */
function chunks(ids: string[], max: number): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < ids.length && out.length < max; at += IDS_PER_FILTER) {
    out.push(ids.slice(at, at + IDS_PER_FILTER));
  }
  return out;
}
