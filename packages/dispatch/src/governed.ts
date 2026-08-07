/**
 * Governed mode: edges resolved from the Kybernesis control plane instead of
 * hand-enumerated peers. The caller authenticates to the control plane with its
 * agent credential (KYBERNESIS_AGENT_CREDENTIAL env), receives a short-TTL A2A
 * session token for a GRANTED caller→callee edge plus the callee's deployment
 * URL — so the registry doubles as discovery, and revoking the edge in the
 * admin takes effect at the next mint (≤ the token TTL, default 300 s).
 */

export interface GovernedOptions {
  /** Control-plane issuer URL (e.g. https://agent.kybernesis.ai). */
  issuer: string;
}

interface MintedSession {
  token: string;
  callee: { name: string; deploymentUrl: string | null };
  expiresAt: number; // unix seconds
}

/** Re-mint 30 s before expiry so an in-flight dispatch never carries a stale token. */
const EXPIRY_BUFFER_SEC = 30;

/**
 * Per-edge mint cache. url() and auth() both need the mint result and are
 * invoked independently by eve — a shared in-flight promise keeps them to one
 * control-plane call per TTL window.
 */
export function createA2ASessionSource(issuer: string, callee: string) {
  let cached: MintedSession | null = null;
  let inflight: Promise<MintedSession> | null = null;

  const mint = async (): Promise<MintedSession> => {
    const credential = process.env.KYBERNESIS_AGENT_CREDENTIAL;
    if (!credential) {
      throw new Error(
        "governed remotePeer: KYBERNESIS_AGENT_CREDENTIAL is not set — mint it in the control plane (agent panel) and add it to this deployment's env.",
      );
    }
    const res = await fetch(`${issuer.replace(/\/$/, "")}/api/agent/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ callee }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        `governed remotePeer: A2A mint for callee "${callee}" failed (${res.status} ${body.error ?? "unknown"}) — check the edge grant and both agents' status in the control plane.`,
      );
    }
    return (await res.json()) as MintedSession;
  };

  return async (): Promise<MintedSession> => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (cached && cached.expiresAt - EXPIRY_BUFFER_SEC > nowSec) return cached;
    if (!inflight) {
      inflight = mint().finally(() => {
        inflight = null;
      });
    }
    cached = await inflight;
    return cached;
  };
}
