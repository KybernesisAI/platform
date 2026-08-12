/**
 * Telling "this token is not valid" apart from "we could not fetch the keys to
 * judge it".
 *
 * jose reports both as a thrown error, and collapsing them is a real problem in
 * production: a momentary failure reaching the control plane's JWKS turns into
 * "your session is not valid for this agent", which sends the user off to check
 * an issuer setting that was correct the whole time. The token was fine. The
 * agent simply could not ask.
 *
 * The distinction is not cosmetic. An invalid token is a verdict and must stay
 * fail-closed. A retrieval failure is an outage: it is transient, it is the
 * agent's problem rather than the caller's, and it is worth one retry before
 * anyone is told anything.
 */

/** What a failed verification actually meant. */
export type VerifyFailure =
  /** The credential was judged and rejected: bad signature, expired, wrong issuer. */
  | "invalid"
  /** The signing keys were unavailable, so nothing was judged at all. */
  | "unavailable";

/**
 * jose stamps its own errors with an `ERR_*` code. Anything without one reached
 * us from underneath — a DNS failure, a refused socket, `TypeError: fetch
 * failed` — which is the network, not the caller.
 *
 * `ERR_JWKS_NO_MATCHING_KEY` sits in between: the usual cause is a rotated key
 * whose JWKS has not been re-fetched, which a retry fixes. If it survives a
 * re-fetch the key genuinely is not published, and that is a verdict.
 */
export function classifyVerifyFailure(error: unknown, refetched: boolean): VerifyFailure {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code !== "string") return "unavailable";
  if (code === "ERR_JWKS_TIMEOUT") return "unavailable";
  if (code === "ERR_JWKS_NO_MATCHING_KEY") return refetched ? "invalid" : "unavailable";
  if (code.startsWith("ERR_JWKS")) return "unavailable";
  return "invalid";
}

/** True while a first failure is still worth retrying against a fresh JWKS. */
export function worthRetrying(error: unknown): boolean {
  return classifyVerifyFailure(error, false) === "unavailable";
}

/** Message shown when the agent could not reach the control plane to verify. */
export const VERIFICATION_UNAVAILABLE =
  "This agent could not reach the Kybernesis control plane to check your sign-in, so it " +
  "cannot admit you right now. Nothing is wrong with your session — try again in a moment.";

/** Machine-readable code for the same, so clients can retry instead of alarming. */
export const VERIFICATION_UNAVAILABLE_CODE = "verification_unavailable";
