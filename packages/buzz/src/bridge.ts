import { channelIdentity, type SpeakerResolution } from "@kybernesis/enterprise";
import { fetchMedia, parseMedia } from "./media.js";
import { speakerCredentials } from "./credentials.js";
import { SessionStore } from "./sessions.js";
import { answerTurn, composeMessage, rejectedTurnReply } from "./turn.js";
import {
  followPendingConversation,
  formatInputRequests,
  invalidInputReply,
  resolveInputReply,
  respondToPendingConversation,
} from "./hitl.js";
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
  function serialize<T>(community: string, channel: string, work: () => Promise<T>): Promise<T> {
    const key = SessionStore.key(community, channel);
    const queued = (inFlight.get(key) ?? Promise.resolve()).then(work, work);
    // Kept only while it matters: the chain holds the LAST promise, not a history.
    inFlight.set(key, queued.catch(() => {}));
    return queued;
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

  /** One abortable durable-stream follower owns each parked conversation. */
  const followers = new Map<string, AbortController>();
  let stopped = false;

  function stopFollower(community: string, channel: string): void {
    const conversation = SessionStore.key(community, channel);
    followers.get(conversation)?.abort();
    followers.delete(conversation);
  }

  function startFollower(community: string, channel: string): void {
    if (stopped) return;
    const conversation = SessionStore.key(community, channel);
    if (followers.has(conversation)) return;
    const stored = sessions.get(community, channel);
    const relay = relays.get(community);
    if (!stored?.pendingInputRequests?.length || !stored.speakerPublicKey || !relay) return;

    const controller = new AbortController();
    followers.set(conversation, controller);
    const session = clientFor(stored.speakerPublicKey).sessions.attach(stored.id, {
      streamIndex: stored.streamIndex,
    });
    void followPendingConversation(
      session,
      stored,
      {
        onState: (state) => sessions.set(community, channel, state),
        onInputRequested: (requests) => {
          relay.reply(channel, formatInputRequests(requests));
          log(`posted another input request in ${channel.slice(0, 8)}`);
        },
        onMessage: (message) => {
          relay.reply(channel, message);
          log(`posted resumed reply in ${channel.slice(0, 8)} (${message.length} chars)`);
        },
        onLog: log,
      },
      controller.signal,
    ).catch((error) => {
      if (!controller.signal.aborted) {
        // Keep the persisted request, cursor and public identity. A later reply
        // or process restart can refresh credentials and reattach.
        log(`pending follower for ${channel.slice(0, 8)} disconnected (${(error as Error).message})`);
      }
    }).finally(() => {
      if (followers.get(conversation) === controller) followers.delete(conversation);
      if (!controller.signal.aborted && sessions.get(community, channel)?.pendingInputRequests?.length) {
        setTimeout(() => startFollower(community, channel), 1_000);
      }
    });
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

    void relay.react(event.id, SEEN);
    const stopTyping = relay.typingIn(channel);
    try {
      await serialize(from, channel, async () => {
        const pending = sessions.get(from, channel);
        if (pending?.pendingInputRequests?.length) {
          const responses = resolveInputReply(text, pending.pendingInputRequests);
          if (!responses) {
            relay.reply(channel, invalidInputReply(pending.pendingInputRequests), event);
            return;
          }

          // Reattach both POST and follower with the current responder's freshly
          // resolved credentials. The follower remains the sole output reader.
          stopFollower(from, channel);
          sessions.set(from, channel, {
            ...pending,
            speakerPublicKey: event.pubkey,
          });
          startFollower(from, channel);
          const session = clientFor(event.pubkey).sessions.attach(pending.id, {
            streamIndex: pending.streamIndex,
          });
          await respondToPendingConversation(session, responses, from, channel);
          log(`submitted ${responses.length} input response(s) in ${channel.slice(0, 8)}`);
          return;
        }

        /** Drop only a message with NOTHING in it — pending HITL replies are handled above. */
        if (!text && attachments.length === 0) {
          log(`nothing to answer in ${channel.slice(0, 8)} from ${event.pubkey.slice(0, 8)} — no text, no attachments`);
          return;
        }

        /** Images become file parts; unreadable files become explicit model context. */
        const message = await composeMessage(text, attachments, (ref) => fetchMedia(key, ref), log);
        const result = await answerTurn(clientFor(event.pubkey), sessions, channel, message, from, log);

        if (result.status === "waiting" && result.inputRequests.length > 0) {
          sessions.set(from, channel, {
            id: result.sessionId,
            streamIndex: result.streamIndex,
            pendingInputRequests: result.inputRequests,
            speakerPublicKey: event.pubkey,
          });
          relay.reply(channel, formatInputRequests(result.inputRequests), event);
          log(`posted ${result.inputRequests.length} input request(s) in ${channel.slice(0, 8)}`);
          startFollower(from, channel);
          return;
        }

        if (!result.message) {
          log(`no text for ${channel.slice(0, 8)} — telling them rather than going quiet`);
          relay.reply(
            channel,
            "I didn't get an answer back for that one — ask me again and I'll retry.",
            event,
          );
          return;
        }
        relay.reply(channel, result.message, event);
        log(`replied (${result.message.length} chars)`);
      });
    } catch (error) {
      /** A rejected HITL response stays pending; the room gets a concrete retry path. */
      const stillPending = sessions.get(from, channel)?.pendingInputRequests;
      if (stillPending?.length) {
        log(`could not submit pending input for ${channel.slice(0, 8)}: ${(error as Error).message}`);
        relay.reply(channel, invalidInputReply(stillPending), event);
        startFollower(from, channel);
        return;
      }

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
      stopped = false;
      for (const relay of relays.values()) relay.connect();
      for (const { community, channel, session } of sessions.entries()) {
        if (session.pendingInputRequests?.length && session.speakerPublicKey) {
          startFollower(community, channel);
        }
      }
      log(
        urls.length > 1
          ? `listening on ${urls.length} communities — turns run as whoever sent them`
          : "listening — turns run as whoever sent them",
      );
    },
    /** Say goodbye rather than letting presence lapse: a stopped agent should not look online. */
    stop(): void {
      stopped = true;
      for (const controller of followers.values()) controller.abort();
      followers.clear();
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
