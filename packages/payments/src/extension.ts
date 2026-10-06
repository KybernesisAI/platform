import link from "@stripe/link-integrations-eve";
import { linkCliAuth, type LinkCliAuthOptions } from "./link-cli-auth.js";

/**
 * Stripe's Link eve extension, mounted behind the owner's link-cli sign-in.
 *
 * ```ts title="agent/extensions/link.ts"
 * import { linkWallet } from "@kybernesis/payments";
 * export default linkWallet();
 * ```
 */
export function linkWallet(options: LinkCliAuthOptions = {}) {
  return link({ auth: linkCliAuth(options) });
}
