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
import {
  ForbiddenError,
  UnauthenticatedError,
  extractBearerToken,
  type AuthFn,
} from "eve/channels/auth";
import {
  VERIFICATION_UNAVAILABLE,
  VERIFICATION_UNAVAILABLE_CODE,
  classifyVerifyFailure,
  worthRetrying,
} from "./jwks-failure.js";

interface AgentGrant {
  agent: string;
  level: string;
}

/** The caller's claim about who prompted an A2A call, shaped as the mint writes it. */
function isAssertedAsker(value: unknown): value is { id: string; label?: string } {
  if (typeof value !== "object" || value === null) return false;
  const asker = value as { id?: unknown; label?: unknown };
  return (
    typeof asker.id === "string" &&
    asker.id.length > 0 &&
    (asker.label === undefined || typeof asker.label === "string")
  );
}

export interface KybernesisAuthOptions {
  /** Control-plane issuer URL (e.g. https://agent.kybernesis.ai). Must match the token `iss`. */
  issuer: string;
  /** This agent's registered name in the control plane (agent_ref.name). */
  agent: string;
}

/**
 * Verify every credential the caller presented, retrying once when the signing
 * keys could not be fetched.
 *
 * Returns null when a credential was judged and rejected — the auth walk turns
 * that into its own 401, unchanged and fail-closed. Throws when the keys stayed
 * out of reach, because that is the agent's outage to report and not a claim
 * about the caller: a client that is told "invalid session" logs the user out,
 * while one told "cannot verify right now" simply tries again.
 */
async function verifyAll(
  tokens: readonly string[],
  jwks: ReturnType<typeof createRemoteJWKSet>,
  issuer: string,
): Promise<JWTPayload[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payloads: JWTPayload[] = [];
      for (const token of tokens) {
        payloads.push((await jwtVerify(token, jwks, { issuer })).payload);
      }
      return payloads;
    } catch (error) {
      if (attempt === 0 && worthRetrying(error)) {
        // jose re-fetches the key set when it has none cached, which is exactly
        // the case after a failed fetch. A short pause covers an agent that is
        // still booting and a control plane that blinked.
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (classifyVerifyFailure(error, attempt > 0) === "unavailable") {
        throw new UnauthenticatedError({
          code: VERIFICATION_UNAVAILABLE_CODE,
          message: VERIFICATION_UNAVAILABLE,
        });
      }
      return null;
    }
  }
  return null;
}

export function kybernesisAuth(options: KybernesisAuthOptions): AuthFn<Request> {
  // Lazy JWKS init: building the URL eagerly makes a missing/invalid issuer
  // fail at MODULE LOAD, which kills agent compile/boot (a freshly scaffolded
  // agent without envs couldn't even run `eve info`). Deferring to first use
  // means misconfiguration degrades to "governed callers get 401" instead.
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return null;

    if (!jwks) {
      try {
        jwks = createRemoteJWKSet(new URL(`${options.issuer}/api/jwks`));
      } catch {
        return null; // invalid issuer config → fall through to 401, never crash
      }
    }

    const bundle = request.headers.get("x-kybernesis-bundle");
    if (!bundle) {
      // AGENT branch: an A2A session token arrives ALONE (no bundle). Minted by
      // POST /api/agent/session only for an active caller→callee edge, so a
      // verified token that names THIS agent as callee IS the authorization —
      // grant/status checks happened at the mint, ≤300s ago (the revocation SLA).
      const verified = await verifyAll([token], jwks, options.issuer);
      if (!verified) return null;
      const a2a = verified[0]!;
      if (a2a.kind !== "a2a" || typeof a2a.caller !== "string") return null;
      if (a2a.callee !== options.agent) {
        throw new ForbiddenError({
          code: "wrong_callee",
          message: `This A2A token was minted for "${String(a2a.callee)}", not "${options.agent}".`,
        });
      }
      return {
        authenticator: "kybernesis",
        issuer: options.issuer,
        principalId: String(a2a.sub),
        principalType: "agent",
        subject: `agent:${String(a2a.org)}/${a2a.caller}`,
        attributes: {
          org: String(a2a.org),
          callerAgent: a2a.caller,
          kind: "a2a",
          ...(typeof a2a.purpose === "string" ? { purpose: a2a.purpose } : {}),
          // Who the CALLER says prompted this call, so a peer can address the
          // right person and refuse work that is not theirs.
          //
          // The principal above is still the calling agent, and that is the only
          // thing authenticated here. This is the caller's word: it was never
          // verified against the control plane's users, and a caller could put
          // any id in it. So it is safe to greet someone by, and unsafe to widen
          // anything by — a tool that reaches personal data must check the
          // authenticated principal, never this.
          ...(isAssertedAsker(a2a.assertedOnBehalfOf)
            ? {
                assertedAskerId: a2a.assertedOnBehalfOf.id,
                ...(a2a.assertedOnBehalfOf.label
                  ? { assertedAskerLabel: a2a.assertedOnBehalfOf.label }
                  : {}),
              }
            : {}),
        },
      };
    }

    // bad signature, wrong issuer, or expired → null, and the walk 401s. Keys
    // unreachable → verifyAll throws, so the caller is told the agent could not
    // check rather than that their sign-in is bad.
    const verified = await verifyAll([token, bundle], jwks, options.issuer);
    if (!verified) return null;
    const [identity, policy] = verified as [JWTPayload, JWTPayload];

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
