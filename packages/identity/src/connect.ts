import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { DEFAULT_ISSUER, readIdentityFile, saveIdentity, storeKind } from "./store.js";

export interface ConnectOptions {
  /** Issuers this runtime accepts connect tokens from. Default: ARP_ISSUER or https://gateway.arp.run. */
  issuers?: string[];
  fetchImpl?: typeof fetch;
}

export interface ConnectRequest {
  token?: string;
  issuer?: string;
}

/**
 * "Connect your agent" — the runtime's half.
 *
 * ARP Cloud posts a short-lived ES256 connect token here. We verify it
 * against the issuer's JWKS (offline trust, no shared secret), check it was
 * minted for THIS host, redeem it at `<issuer>/agent-api/bootstrap` for the
 * agent's DID + credential, and keep those in the identity file. From then
 * on `arpAuth()` accepts deliveries and `arpPeers()` can call peers — with
 * no environment variable and no restart.
 */
export async function handleConnect(
  body: ConnectRequest,
  requestHost: string | null,
  options: ConnectOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const allowed = (options.issuers ?? [process.env.ARP_ISSUER ?? DEFAULT_ISSUER]).map((i) => i.replace(/\/+$/, ""));
  const issuer = (body.issuer ?? "").replace(/\/+$/, "");
  const token = body.token ?? "";
  if (!token || !issuer) return { status: 400, body: { ok: false, error: "bad_request" } };
  if (!allowed.includes(issuer)) return { status: 403, body: { ok: false, error: "unknown_issuer" } };

  // First bind wins: an identity file written by another issuer is not
  // overwritten (the owner disconnects there first).
  const bound = readIdentityFile();
  if (bound.did && bound.issuer && bound.issuer.replace(/\/+$/, "") !== issuer) {
    return { status: 409, body: { ok: false, error: "bound_to_another_issuer" } };
  }

  let payload: { kind?: unknown; did?: unknown; challenge?: unknown; aud?: string | string[] };
  try {
    const res = await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const jwks = createLocalJWKSet((await res.json()) as { keys: JWK[] });
    ({ payload } = await jwtVerify(token, jwks, { issuer }));
  } catch (err) {
    return { status: 401, body: { ok: false, error: "invalid_token", detail: (err as Error).message } };
  }
  if (payload.kind !== "arp-connect" || typeof payload.did !== "string") return { status: 401, body: { ok: false, error: "invalid_token" } };
  // The token names the host it was minted for; refuse one minted for a different origin.
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (requestHost && aud) {
    let audHost = "";
    try { audHost = new URL(aud).host; } catch { audHost = aud; }
    if (audHost.toLowerCase() !== requestHost.toLowerCase()) return { status: 401, body: { ok: false, error: "audience_mismatch", detail: `token is for ${audHost}` } };
  }

  if (storeKind() === "none" && !process.env.ARP_AGENT_CREDENTIAL) {
    return { status: 503, body: { ok: false, error: "store_unwritable", store: "none" } };
  }

  let cfg: { did?: string; issuer?: string; credential?: string; challenge?: string; error?: string };
  let redeem: Response;
  try {
    redeem = await fetchImpl(`${issuer}/agent-api/bootstrap`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    cfg = (await redeem.json().catch(() => ({}))) as typeof cfg;
  } catch (err) {
    return { status: 502, body: { ok: false, error: "issuer_unreachable", detail: (err as Error).message } };
  }
  if (!redeem.ok || !cfg.did || !cfg.credential || !cfg.challenge) {
    return { status: 502, body: { ok: false, error: cfg.error ?? "bootstrap_failed" } };
  }
  try {
    saveIdentity({ did: cfg.did, issuer: cfg.issuer ?? issuer, credential: cfg.credential, challenge: cfg.challenge });
  } catch (err) {
    return { status: 503, body: { ok: false, error: "store_unwritable", store: "none", detail: (err as Error).message } };
  }
  return { status: 200, body: { ok: true, did: cfg.did, store: "file" } };
}

/** Host of the incoming request (proxy-aware), for the audience check. */
export function requestHostOf(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd) return fwd.split(",")[0]!.trim();
  const host = req.headers.get("host");
  if (host) return host;
  try { return new URL(req.url).host; } catch { return null; }
}
