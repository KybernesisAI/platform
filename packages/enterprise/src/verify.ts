import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Verify a control-plane identity the same way `kybernesisAuth` does, for code
 * that is not an eve channel authenticator.
 *
 * This exists because custom channels do not run the channel authenticator, and
 * the alternative — inventing a second credential for them — produces a key the
 * user has to fetch from a server's env file and paste into a client. That is
 * not authentication, it is a workaround with a password box. Anything an agent
 * exposes should admit the SAME identity the user already signed in with.
 */

export interface VerifyOptions {
  /** Control-plane issuer, e.g. https://agent.kybernesis.ai */
  issuer: string;
  /** This agent's registered name, for the grant check. */
  agent: string;
}

export interface VerifiedPrincipal {
  userId: string;
  org: string;
  email?: string;
  /** `use` or `manage` on THIS agent. */
  level: string;
}

export type VerifyResult =
  | { ok: true; principal: VerifiedPrincipal }
  | { ok: false; status: 401 | 403; error: string };

interface AgentGrant {
  agent: string;
  level: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> | null {
  const cached = jwksCache.get(issuer);
  if (cached) return cached;
  try {
    const set = createRemoteJWKSet(new URL(`${issuer}/api/jwks`));
    jwksCache.set(issuer, set);
    return set;
  } catch {
    return null;
  }
}

/**
 * Both headers are required and checked against each other: the token says who
 * you are, the bundle says what you may reach, and a bundle belonging to a
 * different user is not evidence about this one.
 */
export async function verifyKybernesisRequest(
  request: Request,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const bundle = request.headers.get("x-kybernesis-bundle") ?? "";

  if (!token || !bundle) {
    return {
      ok: false,
      status: 401,
      error:
        "This route needs your Kybernesis identity: an Authorization bearer token and an " +
        "X-Kybernesis-Bundle header, both from signing in to the control plane.",
    };
  }

  const jwks = jwksFor(options.issuer);
  if (!jwks) {
    return { ok: false, status: 401, error: `Invalid issuer configured: ${options.issuer}` };
  }

  let identity: JWTPayload;
  let policy: JWTPayload;
  try {
    identity = (await jwtVerify(token, jwks, { issuer: options.issuer })).payload;
    policy = (await jwtVerify(bundle, jwks, { issuer: options.issuer })).payload;
  } catch {
    return { ok: false, status: 401, error: "Your session is not valid for this agent." };
  }

  if (policy.user !== identity.sub || policy.org !== identity.org) {
    return { ok: false, status: 401, error: "Identity and policy bundle do not match." };
  }

  const grants = (policy.agentGrants ?? []) as AgentGrant[];
  const grant = grants.find((g) => g.agent === options.agent);
  if (!grant) {
    return {
      ok: false,
      status: 403,
      error: `You do not have access to agent "${options.agent}".`,
    };
  }

  return {
    ok: true,
    principal: {
      userId: String(identity.sub),
      org: String(identity.org),
      email: typeof identity.email === "string" ? identity.email : undefined,
      level: String(grant.level),
    },
  };
}
