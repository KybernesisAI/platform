import { channelIdentity, type SpeakerResolution } from "@kybernesis/enterprise";
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

  const clientFor = (token: string, bundle: string) =>
    // `host`, not `baseUrl`: a wrong key is ignored rather than rejected, and the client then
    // builds a nonsense URL — an error about a malformed URL rather than about a mistyped option.
    new Client({
      host: options.agentUrl,
      auth: { bearer: token },
      headers: bundle ? { "x-kybernesis-bundle": bundle } : {},
    });

  async function ask(channel: string, text: string, token: string, bundle: string): Promise<string> {
    // Built per turn, for the person whose turn it is.
    const client = clientFor(token, bundle);

    const existing = sessions.get(channel);
    if (existing) {
      try {
        const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });
        const response = await session.send(text);
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
    const created = await client.sessions.create({ message: text });
    const message = (await created.response.result()).message ?? "";
    sessions.set(channel, {
      id: created.session.state.sessionId,
      streamIndex: created.session.state.streamIndex,
    });
    return message;
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
    if (!text) return;

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

    log(`asked in ${channel.slice(0, 8)} by ${speaker.user.email}: ${text.slice(0, 60)}`);
    void relay.react(event.id, SEEN);
    const stopTyping = relay.typingIn(channel);
    try {
      const reply = await ask(channel, text, speaker.token, speaker.bundle);
      if (!reply) {
        log("the agent produced no text");
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
