/**
 * Slack credentials held by the Kybernesis control plane instead of the host.
 *
 * @remarks
 * Each customer agent has its own Slack app, made for it by the control plane
 * with the agent's own name, handle and picture. The app's signing secret and,
 * once the customer installs it, its bot token live in the customer's org on
 * the control plane. The agent reads them with its own credential at call
 * time, so installing, reinstalling or removing the app takes effect with no
 * restart and nothing Slack-related is ever written to `.env.local`.
 *
 * The signing secret exists from the moment the app is made, before anyone
 * installs it. That is what lets Slack verify the events URL while the app is
 * still being set up.
 */

export interface ControlPlaneSlackOptions {
  /** The control plane. Defaults to KYBERNESIS_ISSUER, then agent.kybernesis.ai. */
  issuer?: string;
  /** This agent's credential. Defaults to KYBERNESIS_AGENT_CREDENTIAL. */
  credential?: string;
  /** How long one answer is reused. Default 60 seconds. */
  ttlMs?: number;
  /** Reject a request whose Slack timestamp is further off than this. Default 5 minutes. */
  maxSkewSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** What the control plane hands this agent. */
export interface ControlPlaneSlackApp {
  signingSecret: string;
  botToken: string | null;
  teamId: string | null;
  botUserId: string | null;
}

const DEFAULT_ISSUER = "https://agent.kybernesis.ai";

/**
 * `credentials` for `multiplayerSlackChannel` (or eve's `slackChannel`) read
 * from the control plane.
 *
 * ```ts title="agent/channels/slack.ts"
 * import { controlPlaneSlackCredentials, multiplayerSlackChannel } from "@kybernesis/multiplayer/slack";
 *
 * export default multiplayerSlackChannel({ credentials: controlPlaneSlackCredentials() });
 * ```
 *
 * An unreachable control plane throws on the token and refuses on the verifier,
 * so an outage reads as an error in the log rather than as Slack being
 * unconfigured.
 */
export function controlPlaneSlackCredentials(options: ControlPlaneSlackOptions = {}) {
  const ttl = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const maxSkew = options.maxSkewSeconds ?? 300;
  let cached: { value: ControlPlaneSlackApp | null; at: number } | null = null;
  let inflight: Promise<ControlPlaneSlackApp | null> | null = null;

  const load = async (force = false): Promise<ControlPlaneSlackApp | null> => {
    if (!force && cached && now() - cached.at < ttl) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const value = await fetchSlackApp(options);
        cached = { value, at: now() };
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    async botToken(): Promise<string> {
      let app = await load();
      // Installed a moment ago: the cached answer predates the token.
      if (!app?.botToken) app = await load(true);
      if (!app?.botToken) throw new Error("Slack is not installed for this agent yet. The owner adds it from the Channels page.");
      return app.botToken;
    },

    async webhookVerifier(request: Request, body: string): Promise<boolean> {
      let app: ControlPlaneSlackApp | null;
      try {
        app = await load();
      } catch (error) {
        console.error(`[slack] could not read this agent's Slack app from the control plane: ${String(error)}`);
        return false;
      }
      if (!app) return false;
      if (await verifySlackSignature(request.headers, body, app.signingSecret, now(), maxSkew)) return true;
      // A secret Slack rotated, or an app made again: one fresh read before refusing.
      const fresh = await load(true).catch(() => null);
      return Boolean(fresh && fresh.signingSecret !== app.signingSecret && (await verifySlackSignature(request.headers, body, fresh.signingSecret, now(), maxSkew)));
    },
  };
}

async function fetchSlackApp(options: ControlPlaneSlackOptions): Promise<ControlPlaneSlackApp | null> {
  const issuer = (options.issuer ?? process.env.KYBERNESIS_ISSUER ?? DEFAULT_ISSUER).replace(/\/$/, "");
  const credential = options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;
  if (!credential) throw new Error("KYBERNESIS_AGENT_CREDENTIAL is not set, so this agent cannot read its Slack app.");
  const res = await (options.fetchImpl ?? fetch)(`${issuer}/api/agent/slack`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`control plane answered ${res.status}`);
  const body = (await res.json()) as Partial<ControlPlaneSlackApp>;
  if (typeof body.signingSecret !== "string" || !body.signingSecret) return null;
  return {
    signingSecret: body.signingSecret,
    botToken: typeof body.botToken === "string" && body.botToken ? body.botToken : null,
    teamId: typeof body.teamId === "string" ? body.teamId : null,
    botUserId: typeof body.botUserId === "string" ? body.botUserId : null,
  };
}

/** Slack's v0 request signature, checked with Web Crypto so no Node builtin is needed. */
export async function verifySlackSignature(
  headers: Headers,
  body: string,
  signingSecret: string,
  nowMs: number,
  maxSkewSeconds = 300,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const signature = headers.get("x-slack-signature") ?? "";
  const seconds = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(seconds)) return false;
  if (Math.abs(nowMs / 1000 - seconds) > maxSkewSeconds) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const expected = `v0=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
