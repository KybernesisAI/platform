/**
 * iMessage and SMS via Linq on exe.dev — OPTIONAL. Import from
 * `@kybernesis/exe/linq` only when the agent uses Linq.
 *
 * Linq delivers over a plain inbound webhook (`/eve/v1/linq`) signed with a
 * secret, so there is no Vercel dependency and no forwarder: the host needs a
 * publicly reachable HTTPS URL (every exe VM has one; share the eve port and
 * set it public, see `@kybernesis/exe/photon` for the exe commands). Register
 * the webhook in Linq for `https://<vm>.exe.xyz:8000/eve/v1/linq` with the
 * `message.received`, `reaction.added` and `reaction.removed` events, and put
 * its signing secret in `LINQ_WEBHOOK_SECRET`.
 *
 * Because the route is public, the signing secret is the ONLY thing between
 * the internet and the agent — treat it as a real credential.
 */
import type { LinqChannelCredentials } from "eve/channels/linq";

/**
 * Lazy env-backed credentials for `linqChannel`, with errors that name the
 * missing variable instead of failing deep inside the adapter.
 *
 * ```ts title="agent/channels/linq.ts"
 * import { linqChannel } from "eve/channels/linq";
 * import { linqEnvCredentials } from "@kybernesis/exe/linq";
 * export default linqChannel({ credentials: linqEnvCredentials() });
 * ```
 */
export function linqEnvCredentials(): LinqChannelCredentials {
  const need = (name: string) => (): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`linqEnvCredentials: ${name} is not set. Note that \`eve start\` does not read .env.local — export it into the server process.`);
    }
    return value;
  };
  return { apiKey: need("LINQ_API_KEY"), signingSecret: need("LINQ_WEBHOOK_SECRET") };
}
