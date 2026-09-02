import {
  ClientError,
  createDataUrlFilePart,
  type Client,
  type InputRequest,
  type MessageResult,
  type SendTurnInput,
} from "eve/client";
import { isImage, type FetchedMedia, type MediaRef } from "./media.js";
import { SessionStore } from "./sessions.js";

/** A message shape accepted by the certified eve client's send contract. */
export type TurnMessage = SendTurnInput["message"];

/** Everything the bridge needs to decide how one eve turn should be rendered. */
export interface TurnOutcome {
  message: string;
  status: MessageResult["status"];
  inputRequests: readonly InputRequest[];
  sessionId: string;
  streamIndex: number;
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

function outcome(result: MessageResult, streamIndex: number): TurnOutcome {
  return {
    message: result.message ?? "",
    status: result.status,
    inputRequests: result.inputRequests,
    sessionId: result.sessionId,
    streamIndex,
  };
}

/** Continue a channel's existing conversation, replacing it only when it is stale. */
export async function answerTurn(
  client: Client,
  sessions: SessionStore,
  channel: string,
  message: TurnMessage,
  community: string,
  log: (message: string) => void = () => {},
): Promise<TurnOutcome> {
  const existing = sessions.get(community, channel);
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
       *
       * Do not call this path while HITL is pending: the bridge's follower owns
       * that unread stream until the parked turn reaches its next boundary.
       */
      let unread = 0;
      for await (const _ of session.stream({ follow: false, startIndex: existing.streamIndex })) {
        unread += 1;
      }
      if (unread > 0) {
        log(`caught up on ${unread} unread event(s) in ${channel.slice(0, 8)} before answering`);
      }

      const response = await session.send(message, {
        clientContext: { buzzCommunity: community, buzzChannel: channel },
      });
      const result = await response.result();
      sessions.set(community, channel, {
        id: existing.id,
        streamIndex: session.state.streamIndex,
      });
      return outcome(result, session.state.streamIndex);
    } catch (error) {
      // A malformed turn does not make its durable session stale. Rethrow so
      // the bridge can tell the room (see `rejectedTurnReply`), and keep the
      // mapping so the next valid message continues the same conversation.
      if (error instanceof ClientError && error.status === 400) throw error;

      log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
      sessions.delete(community, channel);
    }
  }

  // Every fresh conversation is logged, whatever the reason. The silent case
  // used to be the common one: after a bridge restart the map was empty, the
  // message fell straight through to create(), and eight exchanges of context
  // vanished without a line anyone could read (KYB-502).
  log(
    existing
      ? `starting a new conversation in ${channel.slice(0, 8)} (the previous session could not continue)`
      : `starting a new conversation in ${channel.slice(0, 8)} (no session on record for this channel)`,
  );
  const created = await client.sessions.create({
    message,
    clientContext: { buzzCommunity: community, buzzChannel: channel },
  });
  const result = await created.response.result();
  sessions.set(community, channel, {
    id: created.session.state.sessionId,
    streamIndex: created.session.state.streamIndex,
  });
  return outcome(result, created.session.state.streamIndex);
}

/**
 * What the room is told when eve refuses the turn itself.
 *
 * A 400 means the request was malformed — a part eve does not accept, a body
 * it could not parse — not that the agent failed to think of an answer. The
 * session survives it (`answerTurn` keeps the mapping), but the person who
 * sent the message is still waiting, and a log line nobody is reading is not
 * an answer. Returns `null` for anything that is not a request rejection, so
 * the caller's ordinary failure path stays as it was.
 */
export function rejectedTurnReply(error: unknown): string | null {
  if (!(error instanceof ClientError) || error.status !== 400) return null;
  const detail = String(error.message ?? "").split("\n")[0].trim().slice(0, 160);
  return detail
    ? `I couldn't read that message (${detail}). Try sending it again, or as plain text.`
    : "I couldn't read that message. Try sending it again, or as plain text.";
}
