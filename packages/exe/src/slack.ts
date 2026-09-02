/**
 * Slack on exe.dev — OPTIONAL. Import from `@kybernesis/exe/slack` only when
 * the agent uses Slack; the core package assumes no channel.
 *
 * ## How Slack works on a self-hosted host
 *
 * **Inbound (no credential on the host).** The exe.dev Slack Bot integration
 * holds the bot and app tokens server-side. A forwarder process calls
 * `apps.connections.open` through the integration hostname — no token in the
 * request — receives a ticketed `wss://` URL, and POSTs each event to eve's
 * Slack route. eve's channel layer verifies inbound requests *before* the
 * Slack adapter's own socket-forwarding branch runs, so the channel must be
 * given {@link forwardedSocketVerifier} as its `webhookVerifier`.
 *
 * **Outbound (credential still on the host).** eve's `SlackChannelCredentials`
 * is `{ botToken, signingSecret, webhookVerifier }` — there is no `apiUrl`, so
 * outbound Web API calls cannot be routed through the integration even though
 * the underlying adapter supports `apiUrl` and reads `SLACK_API_URL`. Until
 * eve plumbs that through, `SLACK_BOT_TOKEN` must live in the host env.
 * Verified against eve 0.38.3; nothing in the changelog through 0.49.0 changes it.
 */

/** Options for {@link forwardedSocketVerifier}. */
export interface ForwardedSocketVerifierOptions {
  /**
   * Shared secret the forwarder presents as `x-slack-socket-token`. Defaults to
   * `SLACK_SOCKET_FORWARDING_SECRET`. Generate with `openssl rand -hex 24`.
   */
  secret?: string;
  /**
   * Reject events older than this (default 5 minutes). This path bypasses
   * Slack's own timestamp tolerance, so freshness is enforced here instead.
   */
  maxEventAgeMs?: number;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A `webhookVerifier` that authenticates events relayed by the exe.dev Slack
 * forwarder instead of by Slack signing secret.
 *
 * ```ts title="agent/channels/slack.ts"
 * import { slackChannel } from "eve/channels/slack";
 * import { forwardedSocketVerifier } from "@kybernesis/exe/slack";
 *
 * export default slackChannel({
 *   credentials: {
 *     // Outbound still needs the real token (see module docs).
 *     botToken: process.env.SLACK_BOT_TOKEN!,
 *     webhookVerifier: forwardedSocketVerifier(),
 *   },
 * });
 * ```
 *
 * Returns `false` (→ eve responds 401) when the header is absent, the secret
 * mismatches, the body is unparseable, or the event is outside the freshness
 * window.
 */
export function forwardedSocketVerifier(
  options: ForwardedSocketVerifierOptions = {},
): (request: Request, body: string) => boolean {
  const maxAge = options.maxEventAgeMs ?? 5 * 60 * 1000;
  return (request: Request, body: string): boolean => {
    const secret = options.secret ?? process.env.SLACK_SOCKET_FORWARDING_SECRET ?? "";
    const presented = request.headers.get("x-slack-socket-token") ?? "";
    if (!secret || !timingSafeEqual(presented, secret)) return false;
    try {
      const parsed = JSON.parse(body) as {
        event?: { ts?: string };
        event_time?: number;
      };
      const tsSeconds = Number(parsed.event?.ts) || Number(parsed.event_time);
      if (Number.isFinite(tsSeconds) && Math.abs(Date.now() - tsSeconds * 1000) > maxAge) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  };
}

/**
 * Path to the bundled forwarder script (`scripts/slack-forwarder.py`), for
 * copying onto the host or referencing from a supervisor unit. Run it with:
 *
 * ```bash
 * EXE_SLACK_GW=https://<integration>.int.exe.xyz/api/ \
 * EVE_URL=http://127.0.0.1:8000 \
 * SLACK_SOCKET_FORWARDING_SECRET=... \
 *   python3 slack-forwarder.py
 * ```
 *
 * Requires `websockets` (`pip install websockets`). Exactly ONE forwarder may
 * run per Slack app: Slack round-robins events across open Socket Mode
 * connections, so a second (or leaked) connection silently swallows events.
 * The `hello` frame reports `num_connections` — it must read 1.
 */
export function forwarderScriptPath(): string {
  return new URL("../scripts/slack-forwarder.py", import.meta.url).pathname;
}
