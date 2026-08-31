import {
  ClientError,
  createDataUrlFilePart,
  type Client,
  type SendTurnInput,
} from "eve/client";
import { isImage, type FetchedMedia, type MediaRef } from "./media.js";
import { SessionStore } from "./sessions.js";

/** A message shape accepted by the certified eve client's send contract. */
export type TurnMessage = SendTurnInput["message"];

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

/** Continue a channel's existing conversation, replacing it only when it is stale. */
export async function answerTurn(
  client: Client,
  sessions: SessionStore,
  channel: string,
  message: TurnMessage,
  community: string,
  log: (message: string) => void = () => {},
): Promise<string> {
  const existing = sessions.get(community, channel);
  if (existing) {
    try {
      const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });

      // Move to the true end before speaking. This repairs a cursor left behind
      // by an interrupted turn without changing the durable session identity.
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
      return result.message ?? "";
    } catch (error) {
      // A malformed turn does not make its durable session stale. Let the
      // bridge report the failed answer while preserving continuity for the
      // next valid message.
      if (error instanceof ClientError && error.status === 400) throw error;

      log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
      sessions.delete(community, channel);
    }
  }

  const created = await client.sessions.create({
    message,
    clientContext: { buzzCommunity: community, buzzChannel: channel },
  });
  const reply = (await created.response.result()).message ?? "";
  sessions.set(community, channel, {
    id: created.session.state.sessionId,
    streamIndex: created.session.state.streamIndex,
  });
  return reply;
}
