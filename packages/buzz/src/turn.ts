import {
  ClientError,
  createDataUrlFilePart,
  resolveTextToResponses,
  type Client,
  type InputRequest,
  type InputResponse,
  type SendTurnInput,
} from "eve/client";
import { isImage, type FetchedMedia, type MediaRef } from "./media.js";
import { SessionStore } from "./sessions.js";

/** A message shape accepted by the certified eve client's send contract. */
export type TurnMessage = SendTurnInput["message"];

/** Everything the bridge needs to deliver or continue a completed request. */
export interface TurnOutcome {
  message: string;
  status: "completed" | "failed" | "waiting";
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

function outcome(
  result: { message?: string; status: TurnOutcome["status"]; inputRequests?: readonly InputRequest[]; sessionId?: string },
  session: { state: { sessionId: string; streamIndex: number } },
): TurnOutcome {
  return {
    message: result.message ?? "",
    status: result.status,
    inputRequests: result.inputRequests ?? [],
    sessionId: result.sessionId ?? session.state.sessionId,
    streamIndex: session.state.streamIndex,
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

      // A pending request is never a normal turn. The bridge routes replies to
      // respondTurn before this function, so reaching this guard means a caller
      // violated that ordering boundary. Refuse rather than batch behind HITL.
      if (existing.pending?.length) {
        throw new Error("cannot send a normal Buzz message while input is pending");
      }

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
      const value = outcome(result, session);
      sessions.set(community, channel, {
        id: existing.id,
        streamIndex: value.streamIndex,
      });
      return value;
    } catch (error) {
      if (error instanceof ClientError && error.status === 400) throw error;
      if (sessions.get(community, channel)?.pending?.length) throw error;

      log(`session for ${channel.slice(0, 8)} could not continue (${(error as Error).message}); starting a new one`);
      sessions.delete(community, channel);
    }
  }

  const created = await client.sessions.create({
    message,
    clientContext: { buzzCommunity: community, buzzChannel: channel },
  });
  const result = await created.response.result();
  const value = outcome(result, created.session);
  sessions.set(community, channel, {
    id: value.sessionId,
    streamIndex: value.streamIndex,
  });
  return value;
}

/** Answer a parked turn without sending a new user message. */
export async function respondTurn(
  client: Client,
  sessions: SessionStore,
  channel: string,
  inputResponses: readonly InputResponse[],
  community: string,
): Promise<TurnOutcome> {
  const existing = sessions.get(community, channel);
  if (!existing) throw new Error("cannot answer input for a Buzz session that no longer exists");
  const session = client.sessions.attach(existing.id, { streamIndex: existing.streamIndex });
  const response = await session.respond(inputResponses, {
    clientContext: { buzzCommunity: community, buzzChannel: channel },
  });
  const result = await response.result();
  const value = outcome(result, session);
  sessions.set(community, channel, {
    id: existing.id,
    streamIndex: value.streamIndex,
  });
  return value;
}

/** Map Buzz plain text exactly as eve's own channel adapters do. */
export function resolveInputReply(text: string, requests: readonly InputRequest[]): readonly InputResponse[] {
  return resolveTextToResponses(text, requests);
}

/** Render HITL controls into the plain text Buzz rooms support. */
export function formatInputRequests(requests: readonly InputRequest[]): string {
  const blocks = requests.map((request, requestIndex) => {
    const heading = requests.length > 1 ? `Question ${requestIndex + 1}: ${request.prompt}` : request.prompt;
    const options = request.options ?? [];
    const choices = options.map((option, index) =>
      `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
    );
    const instruction = options.length > 0
      ? request.allowFreeform
        ? "Reply with a number, option name, option id, or your own answer."
        : "Reply with a number, option name, or option id."
      : "Reply with your answer.";
    return [heading, ...choices, instruction].join("\n");
  });
  return blocks.join("\n\n");
}

/** What the room is told when eve refuses the turn itself. */
export function rejectedTurnReply(error: unknown): string | null {
  if (!(error instanceof ClientError) || error.status !== 400) return null;
  const detail = String(error.message ?? "").split("\n")[0].trim().slice(0, 160);
  return detail
    ? `I couldn't read that message (${detail}). Try sending it again, or as plain text.`
    : "I couldn't read that message. Try sending it again, or as plain text.";
}
