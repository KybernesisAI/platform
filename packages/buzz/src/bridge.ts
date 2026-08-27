import { channelIdentity, type SpeakerResolution } from "@kybernesis/enterprise";
import { fetchMedia, isImage, parseMedia, type MediaRef } from "./media.js";
import { speakerCredentials } from "./credentials.js";

/**
 * What one turn can carry: prose, or prose with the things attached to it.
 *
 * Narrower than the client's own union on purpose — this is what a chat message
 * can actually contain, and a wider type here would invite parts the bridge has
 * no way to produce.
 */
type TurnMessage =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; image: Uint8Array; mediaType: string }
    >;
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
   */
  const sessions = new Map<string, { id: string; streamIndex: number }>();
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
   * One inbound message, as the parts a turn can carry.
   *
   * @remarks
   * Returns a plain string when there is nothing but text, so the common case
   * stays exactly as it was — a change in the shape of every ordinary turn is
   * not worth paying for the rare one.
   *
   * A failed fetch does NOT throw. The person is owed an answer either way, and
   * an agent told "there was an attachment I could not retrieve" can say so;
   * an agent told nothing answers the caption and looks like it ignored the
   * picture, which is the bug being fixed.
   */
  async function composeMessage(text: string, attachments: MediaRef[]): Promise<TurnMessage> {
    if (attachments.length === 0) return text;

    const parts: Exclude<TurnMessage, string> = [];
    if (text) parts.push({ type: "text", text });

    for (const ref of attachments) {
      try {
        const media = await fetchMedia(key, ref);
        if (isImage(media.mediaType)) {
          parts.push({ type: "image", image: media.bytes, mediaType: media.mediaType });
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

  async function ask(channel: string, message: TurnMessage, pubkey: string, community: string): Promise<string> {
    // Built per turn, for the person whose turn it is — and kept current for as
    // long as that turn runs.
    const client = clientFor(pubkey);

    const existing = sessions.get(channel);
    if (existing) {
      try {
        const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });

        /**
         * Move to the true end of the conversation before speaking.
         *
         * `send()` opens its response stream at the position the handle already
         * holds and stops at the FIRST turn boundary it meets. If anything is
         * still unread there — the tail of a turn that outlived its reader, a
         * turn that was running when the bridge restarted — that boundary
         * belongs to the older turn. The read ends on it, this turn's answer is
         * never collected, and the stored position stays one turn behind.
         *
         * Which makes it permanent: every later turn reads the previous turn's
         * tail. The channel answers nothing, then answers a question from ten
         * minutes ago, and a fresh conversation elsewhere works perfectly —
         * because a fresh conversation has nothing left over to trip on.
         *
         * Draining first costs one bounded read of only what is unread, and it
         * repairs a position that has already drifted rather than requiring
         * anyone to notice. Non-following, so it ends at the tail instead of
         * waiting for the future.
         */
        let unread = 0;
        for await (const _ of session.stream({ follow: false, startIndex: existing.streamIndex })) {
          unread += 1;
        }
        if (unread > 0) {
          log(`caught up on ${unread} unread event(s) in ${channel.slice(0, 8)} before answering`);
        }

        const response = await session.send(message, { clientContext: { buzzCommunity: community, buzzChannel: channel } });
        const result = await response.result();
        // Where this turn left the conversation, so the next one starts after it.
        sessions.set(channel, { id: existing.id, streamIndex: session.state.streamIndex });
        return result.message ?? "";
      } catch (error) {
        // A session the agent no longer holds cannot be resumed. Starting a new one loses the
        // thread but keeps the conversation alive, which is the better of the two failures.
        log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
        sessions.delete(channel);
      }
    }
    const created = await client.sessions.create({
      message,
      clientContext: { buzzCommunity: community, buzzChannel: channel },
    });
    const reply = (await created.response.result()).message ?? "";
    sessions.set(channel, {
      id: created.session.state.sessionId,
      streamIndex: created.session.state.streamIndex,
    });
    return reply;
  }

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
    const message = await composeMessage(text, attachments);
    void relay.react(event.id, SEEN);
    const stopTyping = relay.typingIn(channel);
    try {
      const reply = await serialize(channel, () => ask(channel, message, event.pubkey, from));
      if (!reply) {
        /**
         * Silence is the worst answer available.
         *
         * An empty result used to end here, with a line in a log nobody was
         * reading. In a room that is indistinguishable from the agent ignoring
         * you — so people ask again, which is how one unanswered question
         * became five, none of which looked like a fault to anyone watching.
         */
        log(`no text for ${channel.slice(0, 8)} — telling them rather than going quiet`);
        relay.reply(
          channel,
          "I didn't get an answer back for that one — ask me again and I'll retry.",
          event,
        );
        return;
      }
      relay.reply(channel, reply, event);
      log(`replied (${reply.length} chars)`);
    } catch (error) {
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
      log(
        urls.length > 1
          ? `listening on ${urls.length} communities — turns run as whoever sent them`
          : "listening — turns run as whoever sent them",
      );
    },
    /** Say goodbye rather than letting presence lapse: a stopped agent should not look online. */
    stop(): void {
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
