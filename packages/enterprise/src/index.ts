export { kybernesisAuth, type KybernesisAuthOptions } from "./kybernesis-auth.js";
export {
  verifyKybernesisRequest,
  type VerifiedPrincipal,
  type VerifyOptions,
  type VerifyResult,
} from "./verify.js";
/**
 * Exported so a client can recognise "the agent could not check your sign-in"
 * and retry, rather than treat it as a rejected session and sign the user out
 * over a network blip.
 */
export { VERIFICATION_UNAVAILABLE, VERIFICATION_UNAVAILABLE_CODE } from "./jwks-failure.js";
