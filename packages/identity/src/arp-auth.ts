import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from "jose";
import { UnauthenticatedError, extractBearerToken, type AuthFn } from "eve/channels/auth";
import { resolveIdentity } from "./store.js";

export interface ArpAuthOptions {
  /** ARP Cloud gateway origin. Defaults to ARP_ISSUER, then https://gateway.arp.run. */
  issuer?: string;
  /** This agent's identity, e.g. `did:web:samantha.agent`. Defaults to ARP_AGENT_DID. */
  agentDid?: string;
  /** fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** JWKS cache lifetime (ms). Default 5 min. */
  jwksTtlMs?: number;
}

/**
 * Route auth for messages ARP Cloud delivers to this agent.
 *
 * ARP Cloud (the gateway) signs every delivery with an ES256 key published at
 * `<issuer>/.well-known/jwks.json`; the token names THIS agent as audience and
 * the paired peer as subject. Policy, obligations and audit were evaluated by
 * ARP Cloud before delivery, so a verified token is the authorization — the
 * same offline-verification shape `@kybernesis/enterprise` uses.
 *
 * Returns `null` (skip to the next auth entry) for requests without an ARP
 * token; throws a structured 401 only when the JWKS is unreachable, so a
 * gateway outage is distinguishable from a bad credential.
 */
export function arpAuth(options: ArpAuthOptions = {}): AuthFn<Request> {
  // Identity is resolved per request (options → env → identity file) so a
  // "Connect your agent" that lands mid-life takes effect without a restart.
  const identity = () => resolveIdentity({ ...(options.issuer ? { issuer: options.issuer } : {}), ...(options.agentDid ? { agentDid: options.agentDid } : {}) });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ttl = options.jwksTtlMs ?? 5 * 60_000;
  let cached: { at: number; set: ReturnType<typeof createLocalJWKSet> } | null = null;

  // JWKS via global fetch (stubbable, same as the peers module) with a short
  // cache; one refetch when a key id is unknown (rotation).
  async function keySet(issuer: string, force = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!force && cached && Date.now() - cached.at < ttl) return cached.set;
    const res = await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw Object.assign(new Error(`jwks ${res.status}`), { code: "ERR_JWKS_FETCH" });
    const doc = (await res.json()) as { keys: JWK[] };
    cached = { at: Date.now(), set: createLocalJWKSet(doc) };
    return cached.set;
  }

  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const { did: agentDid, issuer } = identity();
    if (!token || !agentDid) return null;

    // Only ARP tokens are ours; anything else falls through to the next entry.
    let unverified: JWTPayload;
    try {
      unverified = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as JWTPayload;
    } catch {
      return null;
    }
    if (unverified.kind !== "arp-push" || unverified.iss !== issuer) return null;

    let payload: JWTPayload;
    try {
      try {
        ({ payload } = await jwtVerify(token, await keySet(issuer), { issuer, audience: agentDid }));
      } catch (first) {
        const code = (first as { code?: unknown } | null)?.code;
        if (code === "ERR_JWKS_NO_MATCHING_KEY") {
          ({ payload } = await jwtVerify(token, await keySet(issuer, true), { issuer, audience: agentDid }));
        } else {
          throw first;
        }
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const name = (error as { name?: unknown } | null)?.name;
      if ((typeof code === "string" && code.startsWith("ERR_JWKS")) || name === "TimeoutError" || name === "AbortError") {
        throw new UnauthenticatedError({
          code: "verification_unavailable",
          message: "ARP Cloud's signing keys could not be fetched; try again shortly.",
        } as never);
      }
      return null;
    }
    const peerDid = String(payload.sub ?? payload.peer_did ?? "");
    if (!peerDid) return null;
    const obligations = Array.isArray(payload.obligations) ? (payload.obligations as unknown[]) : [];
    return {
      authenticator: "arp",
      issuer,
      principalId: peerDid,
      principalType: "agent",
      subject: `arp:${peerDid}`,
      attributes: {
        kind: "arp-push",
        peerDid,
        peerName: peerDid.replace(/^did:web:/, "").replace(/\.agent$/, ""),
        connectionId: String(payload.connection_id ?? ""),
        msgId: String(payload.msg_id ?? ""),
        thid: String(payload.thid ?? ""),
        ...(typeof payload.purpose === "string" ? { purpose: payload.purpose } : {}),
        obligations: JSON.stringify(obligations),
        obligationTypes: obligations
          .map((o) => (o && typeof o === "object" ? String((o as { type?: unknown }).type ?? "") : ""))
          .filter((t) => t.length > 0),
      },
    };
  };
}
