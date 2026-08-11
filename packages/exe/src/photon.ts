/**
 * iMessage (Photon) on exe.dev — OPTIONAL. Import from `@kybernesis/exe/photon`
 * only when the agent uses iMessage.
 *
 * Photon is markedly simpler to self-host than Slack: it delivers over a plain
 * inbound webhook (`/eve/v1/photon`) rather than a socket, and a Photon signing
 * secret takes precedence over eve's default Vercel-OIDC verifier — so there is
 * no Vercel dependency and no forwarder process to supervise.
 *
 * The trade is that the host needs a **publicly reachable HTTPS URL**. On
 * exe.dev every VM has one (`https://<vm>.exe.xyz`), but it is PRIVATE by
 * default and returns a 307 to an exe login page — Photon's webhook delivery
 * would fail silently against that. Open it explicitly:
 *
 * ```bash
 * ssh exe.dev share port <vm> 8000     # proxy the port eve listens on
 * ssh exe.dev share set-public <vm>    # required: webhooks need anonymous access
 * curl -s -o /dev/null -w '%{http_code}' https://<vm>.exe.xyz/eve/v1/health   # expect 200, not 307
 * ```
 *
 * Then register the webhook in Photon against `https://<vm>.exe.xyz/eve/v1/photon`
 * and put its signing secret in `IMESSAGE_WEBHOOK_SECRET`.
 *
 * Because the route is public, the signing secret is the ONLY thing standing
 * between the internet and the agent — treat it as a real credential, and never
 * run Photon on a host whose eve route auth is `none()`.
 */

/** Photon project credentials, resolved from the host environment. */
export interface PhotonCredentials {
  projectId: string;
  projectSecret: string;
}

/**
 * Lazy env-backed credentials for `photonIMessageChannel`, with errors that name
 * the missing variable instead of failing deep inside the adapter.
 *
 * ```ts title="agent/channels/photon.ts"
 * import { photonIMessageChannel } from "eve/channels/photon";
 * import { photonEnvCredentials } from "@kybernesis/exe/photon";
 *
 * export default photonIMessageChannel({
 *   credentials: photonEnvCredentials(),
 *   webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
 * });
 * ```
 *
 * Resolution is deferred to first use so the agent still compiles and
 * `eve info` still runs on a machine without Photon configured.
 */
export function photonEnvCredentials(): () => Promise<PhotonCredentials> {
  return async () => {
    const projectId = process.env.IMESSAGE_PROJECT_ID;
    const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
    if (!projectId || !projectSecret) {
      const missing = [
        !projectId ? "IMESSAGE_PROJECT_ID" : null,
        !projectSecret ? "IMESSAGE_PROJECT_SECRET" : null,
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `photonEnvCredentials: missing ${missing}. Note that \`eve start\` does not read .env.local — export these into the server process.`,
      );
    }
    return { projectId, projectSecret };
  };
}

/** Env vars a Photon-on-exe host must have set. Pass to `hostPreflight({ requiredEnv })`. */
export const PHOTON_REQUIRED_ENV = [
  "IMESSAGE_PROJECT_ID",
  "IMESSAGE_PROJECT_SECRET",
  "IMESSAGE_WEBHOOK_SECRET",
] as const;

/**
 * Check that the agent's Photon webhook URL is publicly reachable — the failure
 * mode this catches is a private exe.dev VM answering Photon's delivery with a
 * 307 login redirect, which looks like "iMessage just doesn't work" with no
 * error anywhere in the agent's logs.
 */
export async function checkPhotonWebhookReachable(
  publicUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  const base = publicUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/eve/v1/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200) return { ok: true, detail: `${base} is public (200)` };
    if (res.status === 307 || res.status === 302) {
      return {
        ok: false,
        detail: `${base} redirects (${res.status}) to a login page — the VM is private. Run: ssh exe.dev share set-public <vm>`,
      };
    }
    return { ok: false, detail: `${base} returned HTTP ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      detail: `${base} unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
