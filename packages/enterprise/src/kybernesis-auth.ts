/**
 * Prototype of @kybernesis/enterprise's kybernesisAuth(): admit only callers holding a valid
 * control-plane IdentitySession WITH a grant for THIS agent.
 *
 * The caller presents two compact JWS strings, both minted by the control plane and verified
 * offline against its JWKS:
 *   Authorization: Bearer <identity token>     (who the user is)
 *   X-Kybernesis-Bundle: <policy bundle>       (what they may touch, incl. agentGrants)
 *
 * Outcomes: no/invalid credentials → null (the auth walk 401s, fail-closed); valid credentials
 * but no grant for this agent → 403 with a precise message. Revocation needs no callback:
 * grants are re-resolved at every mint and tokens are short-TTL, so a revoked user's next
 * session simply lacks the grant, and a suspended user cannot mint at all.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ForbiddenError, extractBearerToken, type AuthFn } from "eve/channels/auth";

interface AgentGrant {
  agent: string;
  level: string;
}

export interface KybernesisAuthOptions {
  /** Control-plane issuer URL (e.g. https://agent.kybernesis.ai). Must match the token `iss`. */
  issuer: string;
  /** This agent's registered name in the control plane (agent_ref.name). */
  agent: string;
}

export function kybernesisAuth(options: KybernesisAuthOptions): AuthFn<Request> {
  // Lazy JWKS init: building the URL eagerly makes a missing/invalid issuer
  // fail at MODULE LOAD, which kills agent compile/boot (a freshly scaffolded
  // agent without envs couldn't even run `eve info`). Deferring to first use
  // means misconfiguration degrades to "governed callers get 401" instead.
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const bundle = request.headers.get("x-kybernesis-bundle");
    if (!token || !bundle) return null;

    if (!jwks) {
      try {
        jwks = createRemoteJWKSet(new URL(`${options.issuer}/api/jwks`));
      } catch {
        return null; // invalid issuer config → fall through to 401, never crash
      }
    }

    let identity: JWTPayload;
    let policy: JWTPayload;
    try {
      identity = (await jwtVerify(token, jwks, { issuer: options.issuer })).payload;
      policy = (await jwtVerify(bundle, jwks, { issuer: options.issuer })).payload;
    } catch {
      return null; // bad signature, wrong issuer, or expired — fall through to 401
    }

    // The bundle must belong to the same user+org the identity token names.
    if (policy.user !== identity.sub || policy.org !== identity.org) return null;

    const grants = (policy.agentGrants ?? []) as AgentGrant[];
    const grant = grants.find((g) => g.agent === options.agent);
    if (!grant) {
      throw new ForbiddenError({
        code: "agent_not_granted",
        message: `You do not have access to agent "${options.agent}". Ask your admin for a grant.`,
      });
    }

    return {
      authenticator: "kybernesis",
      issuer: options.issuer,
      principalId: String(identity.sub),
      principalType: "user",
      subject: String(identity.sub),
      attributes: {
        org: String(identity.org),
        ...(typeof identity.email === "string" ? { email: identity.email } : {}),
        agentGrantLevel: grant.level,
        kybernesisGrants: grants.map((g) => `${g.agent}:${g.level}`),
      },
    };
  };
}
