/**
 * multiplayerSlackChannel — Kybernesis multiplayer conversations for eve agents on Slack.
 *
 * What it configures (all proven in production on the Kybernesis company agent):
 * - Thread = one shared durable session driven by MULTIPLE verified speakers:
 *   `auth.current` is the sender of each message; `auth.initiator` stays pinned to
 *   whoever started the thread.
 * - No-re-mention continuation: once the agent is active in a thread, anyone can keep
 *   talking to it (mention OR subscribed-thread message), so the thread becomes a real
 *   multi-party conversation.
 * - Attributed context: thread messages between agent replies are injected with stable
 *   per-speaker Slack ids, so the model sees who said what.
 * - Dual surface: public-channel sessions are stamped `surface: "channel"`, DMs
 *   `surface: "dm"` — a verified principal attribute downstream code gates on.
 * - `/new` (configurable) resets a DM conversation to a fresh session.
 *
 * v1 caveats (documented, deliberate):
 * - HITL approvals are session-scoped: any thread member can answer an approval
 *   prompt. Person-scoped approvals arrive with @kybernesis/enterprise integration.
 * - Access to the agent on Slack = Slack workspace membership; per-user grant gating
 *   on the Slack door is a planned enterprise module.
 */
import { defaultSlackAuth, slackChannel, type SlackContext, type SlackMessage } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

import { withSurface, type Surface } from "./surface.js";

export { controlPlaneSlackCredentials, verifySlackSignature, type ControlPlaneSlackOptions, type ControlPlaneSlackApp } from "./control-plane.js";

type SlackChannelInput = NonNullable<Parameters<typeof slackChannel>[0]>;

export interface MultiplayerSlackOptions {
  /** Slack credentials — e.g. `connectSlackCredentials("slack/<connector>")`. */
  credentials: SlackChannelInput["credentials"];
  /**
   * When the agent responds in public channels.
   * - "subscribed-threads" (default): explicit @mentions PLUS any message in a
   *   thread that already has an active session — no repeated mentions needed.
   *   Requires the `message.channels` trigger + `channels:history` scope on the
   *   Slack connector (add `message.groups`/`groups:history` for private channels).
   * - "mention-only": only explicit @mentions start or continue a turn.
   */
  continuation?: "subscribed-threads" | "mention-only";
  /** DM command that retires the session and starts fresh. Default "/new"; false disables. */
  dmReset?: string | false;
  /**
   * What thread history each mention injects (attributed per speaker).
   * - "incremental" (default): only messages since the agent's last reply.
   * - "full": the whole thread every time.
   * - false: only the triggering message.
   * Requires the matching Slack history scope.
   */
  threadContext?: "incremental" | "full" | false;
  /** Optional renderers, passed through to the underlying channel; each wraps eve's default rendering. */
  renderers?: SlackChannelInput["renderers"];
  /**
   * Run every message as a control-plane person instead of a bare Slack user.
   * Pass `channelIdentity({ issuer, credential })` from `@kybernesis/enterprise`.
   *
   * A linked sender runs as themselves (their memory, connections, grants). An
   * unlinked sender gets one private DM with a claim link and the message is
   * not answered; receiving the DM is what proves they are that Slack user. A
   * known but refused sender gets silence. Omitted: Slack users run as Slack
   * principals, as before.
   */
  identity?: SpeakerIdentity | null;
  /** The agent's name, used in the claim DM. Defaults to KYBERNESIS_AGENT. */
  agentName?: string;
  /** The claim DM. Receives the one-time link. */
  claimText?: (link: string) => string;
}

/** The part of `@kybernesis/enterprise`'s `channelIdentity()` this channel uses. */
export interface SpeakerIdentity {
  resolve(
    provider: string,
    externalId: string,
    label?: string,
  ): Promise<
    | { linked: true; issuer: string; user: { id: string; email: string; displayName: string } }
    | { linked: false; reason: string; link?: string }
  >;
}

type SlackSender = { userId: string; userName?: string; fullName?: string; teamId?: string | null };
type SlackApi = { request(operation: string, body: unknown): Promise<{ ok?: boolean; channel?: { id?: string } } & Record<string, unknown>> };

/** One claim DM per person per ten minutes, however many times they write. */
const CLAIM_INTERVAL_MS = 10 * 60 * 1000;

function identityResolver(options: MultiplayerSlackOptions) {
  const identity = options.identity;
  if (!identity) return null;
  const name = (options.agentName ?? process.env.KYBERNESIS_AGENT ?? "").trim();
  const claimText =
    options.claimText ??
    ((link: string) =>
      `Hi${name ? `, I'm ${name}` : ""}. Before I can help here, link your Slack account to your company account (one time): ${link}`);
  const claimed = new Map<string, number>();

  return async (sender: SlackSender, surface: Surface, slack: SlackApi, base: SessionAuthContext | null): Promise<SessionAuthContext | null> => {
    // Team-qualified: a Slack user id is only unique within its workspace.
    const externalId = sender.teamId ? `${sender.teamId}:${sender.userId}` : sender.userId;
    const who = await identity.resolve("slack", externalId, sender.fullName ?? sender.userName);
    if (who.linked) {
      return {
        authenticator: "kybernesis",
        issuer: who.issuer,
        principalId: who.user.id,
        principalType: "user",
        subject: who.user.id,
        attributes: {
          ...(base?.attributes ?? {}),
          email: who.user.email,
          display_name: who.user.displayName,
          user_id: sender.userId,
          ...(sender.teamId ? { team_id: sender.teamId } : {}),
          surface,
        },
      } as SessionAuthContext;
    }
    if (who.reason === "not_linked" && who.link) {
      const last = claimed.get(externalId) ?? 0;
      if (Date.now() - last > CLAIM_INTERVAL_MS) {
        claimed.set(externalId, Date.now());
        // Always a DM, never the channel: the link is only proof if only they see it.
        const opened = await slack.request("conversations.open", { users: sender.userId });
        const channel = opened.ok ? opened.channel?.id : undefined;
        if (channel) await slack.request("chat.postMessage", { channel, text: claimText(who.link) });
        else console.error(`[slack] could not open a DM to send a claim link (${String(opened.error ?? "unknown")})`);
      }
    }
    return null;
  };
}

export function multiplayerSlackChannel(options: MultiplayerSlackOptions) {
  const continuation = options.continuation ?? "subscribed-threads";
  const dmReset = options.dmReset === undefined ? "/new" : options.dmReset;
  const threadContextMode = options.threadContext ?? "incremental";
  const asPerson = identityResolver(options);
  const authFor = async (message: SlackMessage, ctx: SlackContext, surface: Surface) => {
    const base = withSurface(defaultSlackAuth(message, ctx), surface);
    if (!asPerson || !message.author) return base;
    return asPerson(
      { userId: message.author.userId, userName: message.author.userName, fullName: message.author.fullName, teamId: message.teamId ?? null },
      surface,
      ctx.slack as unknown as SlackApi,
      base,
    );
  };

  return slackChannel({
    credentials: options.credentials,
    ...(threadContextMode === false
      ? {}
      : {
          threadContext: {
            since:
              threadContextMode === "incremental"
                ? ("last-agent-reply" as const)
                : ("thread-root" as const),
          },
        }),
    ...(options.renderers ? { renderers: options.renderers } : {}),
    // With identity on, a button answer runs as the person who pressed it,
    // and someone who is not linked cannot answer for someone who is.
    ...(asPerson
      ? {
          async onInputResponse(ctx, submission) {
            const surface: Surface = ctx.slack.channelId.startsWith("D") ? "dm" : "channel";
            const auth = await asPerson(
              { userId: submission.user.id, userName: submission.user.username ?? submission.user.name, teamId: ctx.slack.teamId ?? null },
              surface,
              ctx.slack as unknown as SlackApi,
              withSurface(ctx.defaultAuth, surface),
            );
            return auth ? { auth } : null;
          },
        }
      : {}),

    // DMs: a private 1:1 personal-assistant session for this specific user.
    async onDirectMessage(ctx, message) {
      if (!message.author || message.author.isBot) return null;

      if (dmReset && message.text.trim() === dmReset) {
        await ctx.reset({ reason: `Slack user requested ${dmReset}` });
        await ctx.thread.post("Started a fresh conversation.");
        return null;
      }

      const auth = await authFor(message, ctx, "dm");
      if (!auth) return null;
      await ctx.thread.startTyping("Thinking...");
      return { auth };
    },

    // Channels: respond to explicit @mentions, and (in "subscribed-threads" mode)
    // keep replying in threads that already have an active session.
    async onMessage(ctx, message) {
      if (!message.author || message.author.isBot) return null;
      if (message.raw.channel_type === "im") return null;

      const engaged =
        ctx.isBotMentioned() ||
        (continuation === "subscribed-threads" && (await ctx.isSubscribed()));
      if (!engaged) return null;

      const auth = await authFor(message, ctx, "channel");
      if (!auth) return null;
      await ctx.thread.startTyping("Thinking...");
      return { auth };
    },
  });
}
