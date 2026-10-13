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

/** The part of `@kybernesis/enterprise`'s `channelIdentity()` the gate uses. */
export interface LinqSenderResolver {
  resolve(
    provider: string,
    externalId: string,
    label?: string,
  ): Promise<
    | { linked: true; user: { id: string; email: string; displayName: string } }
    | { linked: false; reason: "not_linked"; link: string }
    | { linked: false; reason: string }
  >;
}

/** The parts of a Linq message and thread the gate reads. */
interface LinqInbound {
  author: { isBot: boolean | "unknown"; userId: string; userName: string };
}
interface LinqThreadLike {
  post(text: string): Promise<unknown>;
}

export interface LinqSenderIdentityOptions {
  /** The resolver, or null when the agent has no control-plane credential. Every message is then dropped. */
  identity: LinqSenderResolver | null;
  /** The control plane the minted session belongs to. */
  issuer: string;
  /** How the agent introduces itself in the one claim text an unlinked number gets. */
  agentName?: string;
  /** Override the claim text. Receives the one-time link; must include it. */
  claimText?: (link: string) => string;
  log?: (message: string) => void;
}

type LinqAuth = {
  authenticator: string;
  issuer: string;
  principalId: string;
  principalType: "user";
  subject: string;
  attributes: Record<string, string>;
};

/**
 * `onMessage` for `linqChannel` that runs every text as a control-plane person.
 *
 * Who a text is from decides everything downstream (memory, connections,
 * grants, the vault), so a sender is not a phone number: each message resolves
 * the number through the control plane's channel identity. A linked person
 * runs as themselves. An unlinked number gets one text with a claim link and
 * nothing else; receiving it is what proves they control the number. A known
 * but refused sender (suspended, or no grant on this agent) gets silence that
 * reveals neither case. A control plane that is unreachable throws, so the
 * webhook fails instead of an outage reading as a refusal.
 *
 * ```ts title="agent/channels/linq.ts"
 * import { channelIdentity } from "@kybernesis/enterprise";
 * import { linqEnvCredentials, linqSenderIdentity } from "@kybernesis/exe/linq";
 * import { linqChannel } from "eve/channels/linq";
 *
 * const issuer = process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
 * const credential = process.env.KYBERNESIS_AGENT_CREDENTIAL;
 * export default linqChannel({
 *   credentials: linqEnvCredentials(),
 *   onMessage: linqSenderIdentity({ issuer, identity: credential ? channelIdentity({ issuer, credential }) : null }),
 * });
 * ```
 */
export function linqSenderIdentity(options: LinqSenderIdentityOptions) {
  const log = options.log ?? ((message: string) => console.error(message));
  const name = options.agentName?.trim();
  const claimText =
    options.claimText ??
    ((link: string) =>
      `Hi${name ? `, I'm ${name}` : ""}. Before I can help over text, link this number to your account here (one time): ${link}`);

  return async (
    ctx: { thread: LinqThreadLike },
    message: LinqInbound,
  ): Promise<{ auth: LinqAuth } | null> => {
    if (message.author.isBot) return null;
    if (!options.identity) {
      log("[linq] KYBERNESIS_AGENT_CREDENTIAL is not set; no sender can be identified, message dropped");
      return null;
    }
    const externalId = message.author.userId;
    const who = await options.identity.resolve("linq", externalId, message.author.userName);
    if (who.linked) {
      return {
        auth: {
          authenticator: "kybernesis",
          issuer: options.issuer,
          principalId: who.user.id,
          principalType: "user",
          subject: who.user.id,
          attributes: {
            email: who.user.email,
            display_name: who.user.displayName,
            surface: "linq",
            linq_user_id: externalId,
          },
        },
      };
    }
    if (who.reason === "not_linked" && "link" in who) {
      await ctx.thread.post(claimText(who.link));
    }
    return null;
  };
}
