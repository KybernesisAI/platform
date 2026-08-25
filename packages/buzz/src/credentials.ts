import type { SpeakerResolution } from "@kybernesis/enterprise";

/** What the eve client needs to authenticate one person's turn. */
export interface SpeakerCredentials {
  /** Bearer resolver — called by the client before every HTTP request. */
  bearer: () => Promise<string>;
  /** Header resolver, for the same reason and on the same schedule. */
  headers: () => Promise<Readonly<Record<string, string>>>;
}

/**
 * Credentials for a turn, resolved per request rather than captured once.
 *
 * @remarks
 * An identity token lives about five minutes. That was invisible while turns
 * ended early, and became a failure the moment they ran to completion: a turn
 * doing six minutes of real work reconnected its stream with the token it began
 * with, the agent answered "Authorization is required for this route", and the
 * reply was lost after every tool call had already succeeded. In a channel that
 * reads as the agent typing for five minutes and then saying nothing at all.
 *
 * Resolving per request costs nothing in the normal case, because the resolver
 * caches and re-mints only near expiry. It also preserves the property the
 * short lifetime exists for: access withdrawn mid-turn stops the next request
 * rather than being noticed after the work is done.
 */
export function speakerCredentials(
  resolve: (externalId: string) => Promise<SpeakerResolution>,
): (externalId: string) => SpeakerCredentials {
  return (externalId) => {
    const current = async (): Promise<{ token: string; bundle: string }> => {
      const speaker = await resolve(externalId);
      if (!speaker.linked) {
        // Failing here is the point: the alternative is finishing a turn with a
        // credential the control plane has already withdrawn.
        throw new Error(`no longer authorized (${speaker.reason})`);
      }
      return { token: speaker.token, bundle: speaker.bundle };
    };
    return {
      bearer: async () => (await current()).token,
      headers: async (): Promise<Readonly<Record<string, string>>> => {
        const { bundle } = await current();
        return bundle ? { "x-kybernesis-bundle": bundle } : {};
      },
    };
  };
}
