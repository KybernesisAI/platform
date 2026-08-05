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
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

import { withSurface } from "./surface.js";

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
  /** Optional event-handler overrides, passed through to the underlying channel. */
  events?: SlackChannelInput["events"];
}

export function multiplayerSlackChannel(options: MultiplayerSlackOptions) {
  const continuation = options.continuation ?? "subscribed-threads";
  const dmReset = options.dmReset === undefined ? "/new" : options.dmReset;
  const threadContextMode = options.threadContext ?? "incremental";

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
    ...(options.events ? { events: options.events } : {}),

    // DMs: a private 1:1 personal-assistant session for this specific user.
    async onDirectMessage(ctx, message) {
      if (!message.author || message.author.isBot) return null;

      if (dmReset && message.text.trim() === dmReset) {
        await ctx.reset({ reason: `Slack user requested ${dmReset}` });
        await ctx.thread.post("Started a fresh conversation.");
        return null;
      }

      await ctx.thread.startTyping("Thinking...");
      return { auth: withSurface(defaultSlackAuth(message, ctx), "dm") };
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

      await ctx.thread.startTyping("Thinking...");
      return { auth: withSurface(defaultSlackAuth(message, ctx), "channel") };
    },
  });
}
