import { channelIdentity, type SpeakerResolution } from "@kybernesis/enterprise";
import { fetchMedia, parseMedia } from "./media.js";
import { speakerCredentials } from "./credentials.js";
import { SessionStore } from "./sessions.js";
import {
  answerTurn,
  composeMessage,
  formatInputRequests,
  rejectedTurnReply,
  resolveInputReply,
  respondTurn,
  type TurnOutcome,
} from "./turn.js";
import { followPendingSession } from "./pending.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { Client } from "eve/client";
import { BuzzRelay, type NostrEvent } from "./relay.js";
import { loadKey, npubEncode, type AgentKey } from "./keys.js";

/**
 * An agent as a member of a workspace, answering as whoever spoke to it.
 *
 * @remarks
 * The design decision this file exists to express: a message is answered as the PERSON who sent
 * it, not as the agent's owner and not as one shared service account. The sender is a verified
 * public key — the workspace signed it — so it can be resolved to a real identity, and the turn
 * can run with that person's memory, connections and grants.
 *
 * The bridge itself is deliberately powerless. It holds the agent's key and the agent's own
 * credential, and neither of those can act as any person; every turn's authority is minted at
 * the moment it is needed and expires shortly after. A stolen copy of this process buys an
 * attacker the ability to be the agent, which the workspace already knows about, and nothing else.
 */

/** How the workspace names people, in the control plane's records. */
const PROVIDER = "buzz";

/** Acknowledge receipt before doing any work: silence and thinking look identical otherwise. */
const SEEN = "👀";

export type BuzzBridgeOptions = {
  /**
   * The workspace relay, or several of them.
   *
   * @remarks
   * One agent, one identity, many communities. A workspace's membership is the
   * relay's to grant, so being in two of them is two connections rather than
   * two agents — and the same public key is invited to each. Sessions stay
   * keyed by channel, and a channel belongs to exactly one community, so the
   * conversations never mix.
   */
  relay: string | readonly string[];
  /** Where the agent is listening, e.g. `http://127.0.0.1:8000`. */
  agentUrl: string;
  /** The agent's own key file. Its public half is what the workspace invited. */
  keyFile: string;
  /** The control plane, e.g. `https://control.example.com`. */
  issuer: string;
  /** This agent's credential from the control plane. The only durable secret here. */
  credential: string;
  pollMs?: number;
  onLog?: (message: string) => void;
};

export function buzzBridge(options: BuzzBridgeOptions) {
  const key: AgentKey = loadKey(options.keyFile);
  const identity = channelIdentity({ issuer: options.issuer, credential: options.credential });
  const log = options.onLog ?? ((message: string) => console.log(new Date().toISOString().slice(11, 19), message));

  /**
   * One conversation per channel — the SESSION ID, not a handle to it.
   *
   * @remarks
   * This distinction is the difference between multiplayer working and quietly
   * not. A session handle carries the client that made it, and that client
   * carries one person's bearer token. Cache the handle and every later turn in
   * the channel runs as whoever spoke first: a second person asks about their
   * own mail and is shown the first person's, with nothing anywhere reporting
   * an error.
   *
   * So the id is shared and the credentials are not. Each turn attaches to the
   * same conversation through a client built for the person sending it, which
   * is what the runtime reads to decide whose memory and whose connections the
   * turn may touch.
   *
   * The stream position is kept beside the id for a reason that cost an
   * afternoon: attaching defaults to index 0, so a turn reads the conversation
   * from its beginning and reports the FIRST completed message it finds — the
   * previous person's answer. The turn itself runs correctly, as the right
   * person, against the right connections; only the text posted back is
   * somebody else's, which is the most convincing way to look broken.
   *
   * Kept on DISK, not in memory. The eve session is durable; the knowledge of
   * which session belongs to a channel was not, so a restart orphaned every
   * conversation — the next message opened a new session and the agent said it
   * had no context, while the old session sat intact holding a reply nobody was
   * left to read.
   */
  const legacySessionsFile = ".buzz-sessions.json";
  const sessionsFile =
    process.env.BUZZ_SESSIONS_FILE ??
    (existsSync(legacySessionsFile)
      ? legacySessionsFile
      : join(dirname(options.keyFile), "buzz-sessions.json"));
  const sessions = new SessionStore(sessionsFile, { onError: log });
  if (sessions.size > 0) log(`resumed ${sessions.size} conversation(s) from the last run`);
  /** Who has already been sent a link, so a room full of strangers is not a room full of spam. */
  const invited = new Map<string, number>();

  /**
   * A client whose credentials are resolved per request, not captured once.
   *
   * The identity token a turn starts with lives about five minutes. That was
   * invisible while turns ended early — and became a failure the moment they
   * were allowed to run to completion: a turn doing real work for six minutes
   * reconnected its stream with the token it began with, the agent answered
   * "Authorization is required for this route", and the reply was lost after
   * all the work had been done. In a channel that reads as the agent typing
   * for five minutes and then saying nothing.
   *
   * Resolving per request costs nothing in the normal case — the resolver
   * caches and re-mints only near expiry — and it keeps the property the short
   * lifetime exists for: a person whose access is revoked mid-turn stops being
   * able to act on the next request rather than at the end of the turn.
   */
  const credentialsFor = speakerCredentials((externalId) =>
    identity.resolve(PROVIDER, externalId, npubEncode(externalId)),
  );

  const clientFor = (pubkey: string) => {
    const credentials = credentialsFor(pubkey);
    // `host`, not `baseUrl`: a wrong key is ignored rather than rejected, and the client then
    // builds a nonsense URL — an error about a malformed URL rather than about a mistyped option.
    return new Client({
      host: options.agentUrl,
      auth: { bearer: credentials.bearer },
      headers: credentials.headers,
    });
  };

  /**
   * One turn at a time per channel.
   *
   * Two people asking at once used to interleave: both turns read and wrote the
   * same stored stream position, so one of them read the other's boundary and
   * came back with the wrong answer or none. A channel is a conversation; its
   * turns are ordered whether or not the people in it take turns.
   */
  const inFlight = new Map<string, Promise<unknown>>();
  function serialize<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const queued = (inFlight.get(channel) ?? Promise.resolve()).then(work, work);
    // Kept only while it matters: the chain holds the LAST promise, not a history.
    inFlight.set(channel, queued.catch(() => {}));
    return queued;
  }

  /** One durable follower only while a channel is parked for human input. */
  const followers = new Map<string, { controller: AbortController; task: Promise<void> }>();
  let stopping = false;

  async function stopFollower(community: string, channel: string): Promise<void> {
    const key = SessionStore.key(community, channel);
    const follower = followers.get(key);
    if (!follower) return;
    follower.controller.abort();
    await follower.task;
  }

  function startFollower(community: string, channel: string): void {
    const key = SessionStore.key(community, channel);
    if (stopping || followers.has(key)) return;
    const stored = sessions.get(community, channel);
    const relay = relays.get(community);
    if (!stored?.pending?.length || !stored.speaker || !relay) return;

    const controller = new AbortController();
    const task = (async () => {
      let delay = 250;
      while (!controller.signal.aborted && !stopping) {
        const current = sessions.get(community, channel);
        if (!current?.pending?.length || !current.speaker) return;
        try {
          const result = await followPendingSession({
            client: clientFor(current.speaker),
            session: current,
            signal: controller.signal,
            onProgress: ({ streamIndex, pending }) => {
              const latest = sessions.get(community, channel);
              if (!latest) return;
              sessions.set(community, channel, {
                id: latest.id,
                streamIndex,
                pending: pending.length > 0 ? pending : latest.pending,
                speaker: latest.speaker,
              });
            },
            onPrompt: (requests) => serialize(channel, async () => {
              relay.reply(channel, formatInputRequests(requests));
              log(`asked for input in ${channel.slice(0, 8)}`);
            }),
            onMessage: (message) => serialize(channel, async () => {
              const latest = sessions.get(community, channel);
              if (!latest) return;
              sessions.set(community, channel, { id: latest.id, streamIndex: latest.streamIndex });
              relay.reply(channel, message);
              log(`delivered resumed reply (${message.length} chars)`);
            }),
            onFailed: (message) => serialize(channel, async () => {
              const latest = sessions.get(community, channel);
              if (latest) sessions.set(community, channel, { id: latest.id, streamIndex: latest.streamIndex });
              log(`parked session failed in ${channel.slice(0, 8)}: ${message}`);
            }),
          });
          if (result !== "ended") return;
        } catch (error) {
          log(`pending follower for ${channel.slice(0, 8)} disconnected: ${(error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5_000);
      }
    })().finally(() => {
      if (followers.get(key)?.controller === controller) followers.delete(key);
    });
    followers.set(key, { controller, task });
  }

  function deliverOutcome(
    relay: BuzzRelay,
    community: string,
    channel: string,
    speaker: string,
    result: TurnOutcome,
    replyTo?: NostrEvent,
  ): boolean {
    if (result.inputRequests.length > 0 || result.status === "waiting") {
      if (result.inputRequests.length === 0) {
        log(`session ${result.sessionId} reported waiting without input requests`);
        return false;
      }
      sessions.set(community, channel, {
        id: result.sessionId,
        streamIndex: result.streamIndex,
        pending: result.inputRequests,
        speaker,
      });
      relay.reply(channel, formatInputRequests(result.inputRequests), replyTo);
      log(`asked for input in ${channel.slice(0, 8)}`);
      return true;
    }

    sessions.set(community, channel, { id: result.sessionId, streamIndex: result.streamIndex });
    if (result.message) {
      relay.reply(channel, result.message, replyTo);
      log(`replied (${result.message.length} chars)`);
    }
    return false;
  }

  /**
   * Where this conversation is happening, handed to the agent with the turn.
   *
   * An agent in two communities was asked "what projects exist in this relay?"
   * and could not know which relay "this" was — so it reached for a
   * human-in-the-loop question, which parks a turn until somebody answers it.
   * In a channel nobody does, so the turn never finished and the room got
   * nothing. The bridge knew the answer the whole time: it is the connection
   * the message arrived on.
   */
  /**
   * Send someone the link that makes them known, privately.
   *
   * @remarks
   * Privately is not a nicety. Holding the link is what proves control of the account it names,
   * so posting it in a room would let anyone in that room claim to be that person. It goes to a
   * direct conversation or it does not go at all.
   */
  async function invite(relay: BuzzRelay, sender: string, link: string): Promise<void> {
    const last = invited.get(sender) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    invited.set(sender, Date.now());

    const dm = await relay.openDirectMessage(sender);
    if (!dm) {
      log(`could not reach ${npubEncode(sender).slice(0, 16)}… privately to send a sign-in link`);
      return;
    }
    relay.reply(
      dm,
      `Hi — before I can help, I need to know who you are.\n\nSign in here and I will work as you, with your own memory and access:\n${link}\n\nThe link is for this account only, and it expires shortly.`,
    );
    log(`sent a sign-in link to ${npubEncode(sender).slice(0, 16)}…`);
  }

  /** What to say to someone who is known but not allowed. Said privately, for the same reason. */
  async function refuse(relay: BuzzRelay, sender: string, reason: string): Promise<void> {
    const dm = await relay.openDirectMessage(sender);
    const text =
      reason === "agent_not_granted"
        ? "You are signed in, but you do not have access to this agent yet. An administrator can grant it."
        : "Your account is not active, so I cannot act as you.";
    if (dm) relay.reply(dm, text);
    log(`refused ${npubEncode(sender).slice(0, 16)}…: ${reason}`);
  }

  const urls = (typeof options.relay === "string" ? [options.relay] : [...options.relay])
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) throw new Error("a workspace relay is required");

  /** Which connection a message arrived on, so the reply goes back the same way. */
  const relays = new Map<string, BuzzRelay>();
  for (const url of urls) {
    relays.set(
      url,
      new BuzzRelay({
        url,
        key,
        pollMs: options.pollMs,
        // Which community is speaking matters once there is more than one.
        onLog: (message) => log(urls.length > 1 ? `${label(url)} ${message}` : message),
        onMessage: (event) => {
          void handle(event, url);
        },
      }),
    );
  }

  async function handle(event: NostrEvent, from: string): Promise<void> {
    const relay = relays.get(from);
    if (!relay) return;
    const channel = event.tags.find((t) => t[0] === "h")?.[1];
    // Addressed by TAG, not by text. A name in prose is a string anyone can type; a p tag is what
    // the client emits when someone actually picks this member out of a mention list.
    const addressed = event.tags.some((t) => t[0] === "p" && t[1] === key.publicKey);
    if (!channel || !addressed) return;

    const text = String(event.content ?? "").trim();
    const attachments = parseMedia(event);

    /**
     * Drop only a message with NOTHING in it — and say so when we do.
     *
     * This guard used to test the text alone, and sat above the log line, so an
     * image sent without a caption was discarded before anything was written
     * down. From the outside the agent had simply ignored someone; from the
     * inside there was no record that a message had ever arrived. The reply
     * path was hardened against exactly this failure — an empty answer now
     * says so out loud — and the receiving path was left as it was.
     */
    if (!text && attachments.length === 0) {
      log(`nothing to answer in ${channel.slice(0, 8)} from ${event.pubkey.slice(0, 8)} — no text, no attachments`);
      return;
    }

    let speaker: SpeakerResolution;
    try {
      speaker = await identity.resolve(PROVIDER, event.pubkey, npubEncode(event.pubkey));
    } catch (error) {
      // The control plane being unreachable is not a refusal. Saying nothing and retrying on the
      // next message is better than telling someone they are not allowed when they are.
      log(`could not check who sent this (${(error as Error).message}); leaving it unanswered`);
      return;
    }

    if (!speaker.linked) {
      if (speaker.reason === "not_linked") await invite(relay, event.pubkey, speaker.link);
      else await refuse(relay, event.pubkey, speaker.reason);
      return;
    }

    log(
      `asked in ${channel.slice(0, 8)} by ${speaker.user.email}: ${text.slice(0, 60)}` +
        (attachments.length ? ` [+${attachments.length} attachment(s)]` : ""),
    );

    /**
     * Attachments become parts of the turn, or become words about themselves.
     *
     * An image the model can see goes in as bytes. Anything else — a zip, a
     * PDF the model cannot read, a fetch that failed — goes in as a sentence
     * saying so, because the alternative is an agent that answers the caption
     * while the person waits for a reply about the file they sent. Being told
     * "I got a file I cannot read" is a worse answer than the truth only if
     * you never wanted the truth.
     */
    void relay.react(event.id, SEEN);
    const stopTyping = relay.typingIn(channel);
    try {
      const parked = sessions.get(from, channel);
      if (parked?.pending?.length) {
        const responses = attachments.length === 0
          ? resolveInputReply(text, parked.pending)
          : [];
        if (responses.length === 0) {
          // Invalid input is still input for the parked turn. Never enqueue it as
          // a new message behind the request it failed to answer.
          relay.reply(channel, `I still need an answer to continue.\n\n${formatInputRequests(parked.pending)}`, event);
          return;
        }
        await stopFollower(from, channel);
        const result = await serialize(channel, () =>
          respondTurn(clientFor(event.pubkey), sessions, channel, responses, from),
        );
        if (deliverOutcome(relay, from, channel, event.pubkey, result, event)) {
          startFollower(from, channel);
        }
        return;
      }

      const message = await composeMessage(text, attachments, (ref) => fetchMedia(key, ref), log);
      const result = await serialize(channel, () =>
        answerTurn(clientFor(event.pubkey), sessions, channel, message, from, log),
      );
      if (deliverOutcome(relay, from, channel, event.pubkey, result, event)) {
        startFollower(from, channel);
        return;
      }
      if (!result.message) {
        log(`no text for ${channel.slice(0, 8)} — telling them rather than going quiet`);
        relay.reply(channel, "I didn't get an answer back for that one.", event);
      }
    } catch (error) {
      /**
       * eve refused the turn as malformed. The conversation is intact — the
       * session mapping was kept — but silence here is indistinguishable from
       * being ignored, the same failure the empty-reply branch above exists
       * for. Say what happened; the log gets the full error.
       */
      const rejected = rejectedTurnReply(error);
      if (rejected) {
        log(`turn rejected for ${channel.slice(0, 8)}: ${(error as Error).message}`);
        relay.reply(channel, rejected, event);
        return;
      }
      log(`failed to answer: ${(error as Error).message}`);
    } finally {
      stopTyping();
    }
  }

  return {
    /** The key the workspace has to invite for any of this to happen. */
    npub: key.npub,
    pubkey: key.publicKey,
    /** The communities this agent is a member of. */
    relays: urls,
    start(): void {
      for (const relay of relays.values()) relay.connect();
      for (const { community, channel } of sessions.pending()) startFollower(community, channel);
      log(
        urls.length > 1
          ? `listening on ${urls.length} communities — turns run as whoever sent them`
          : "listening — turns run as whoever sent them",
      );
    },
    /** Say goodbye rather than letting presence lapse: a stopped agent should not look online. */
    stop(): void {
      stopping = true;
      for (const follower of followers.values()) follower.controller.abort();
      for (const relay of relays.values()) relay.setPresence("offline");
      setTimeout(() => {
        for (const relay of relays.values()) relay.close();
      }, 250);
    },
  };
}

export type BuzzBridge = ReturnType<typeof buzzBridge>;

/** A relay's host, short enough to prefix a log line with. */
function label(url: string): string {
  try {
    return `[${new URL(url).hostname.split(".")[0]}]`;
  } catch {
    return "[relay]";
  }
}
