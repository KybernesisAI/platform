import type { AgentKey } from "./keys.js";
import * as profile from "./profile.js";
import type { Profile } from "./profile.js";

/**
 * An agent's `.agent` name is the source of truth for how it presents itself.
 *
 * @remarks
 * The name's public profile document carries the name, description, picture and NIP-05
 * handle. The bridge keeps each community's copy of the profile in step with it, so a change
 * made on the name — a new picture, a new description, or the name's address moving — reaches
 * every community without anyone running a command on the agent's host. A one-off copy is
 * exactly what went stale when the addresses moved: the profile kept pointing at a picture URL
 * that no longer existed.
 */

/** Where names serve their public documents: `<name>.agentid.dev`. */
export const DEFAULT_MIRROR_SUFFIX = ".agentid.dev";

export type NameProfile = { name: string; description: string; picture: string | null; nip05: string | null };

/** `did:web:kyber.agent`, `kyber.agent` or `kyber` → `kyber`. Anything else is not a `.agent` name. */
export function nameFromDid(did: string): string | null {
  const match = /^(?:did:web:)?([a-z0-9-]+)(?:\.agent)?$/i.exec(did.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** The name's public profile document. `AGENTID_MIRROR_SUFFIX` overrides the host, for staging. */
export function profileDocumentUrl(name: string, suffix = process.env.AGENTID_MIRROR_SUFFIX ?? DEFAULT_MIRROR_SUFFIX): string {
  return `https://${name}${suffix.startsWith(".") ? suffix : `.${suffix}`}/.well-known/agent-profile.json`;
}

export async function fetchNameProfile(name: string, fetchImpl: typeof fetch = fetch): Promise<NameProfile> {
  const url = profileDocumentUrl(name);
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${name}.agent has no profile document yet (${res.status} from ${url})`);
  const doc = (await res.json()) as Partial<NameProfile>;
  return { name: doc.name ?? name, description: doc.description ?? "", picture: doc.picture ?? null, nip05: doc.nip05 ?? null };
}

/** The profile fields the name decides. */
export function profileFromName(name: string, doc: NameProfile): Profile {
  return {
    name,
    display_name: doc.name,
    ...(doc.description ? { about: doc.description } : {}),
    ...(doc.picture ? { picture: doc.picture } : {}),
    ...(doc.nip05 ? { nip05: doc.nip05 } : {}),
    bot: true,
  };
}

/** Whether a community's copy already says everything the name says. */
export function matchesName(current: Profile | null, wanted: Profile): boolean {
  if (!current) return false;
  return (Object.keys(wanted) as Array<keyof Profile>).every((field) => current[field] === wanted[field]);
}

export type SyncOutcome = { relay: string; outcome: "unchanged" | "updated" | "not-member" | "failed"; detail?: string };

/**
 * Bring this agent's profile in every community in line with its name.
 *
 * @remarks
 * Only communities whose copy differs are written, so running this on every start and on a
 * timer costs one read per community when nothing has changed. Fields the name does not
 * decide are left as they are. Throws only when the name's document cannot be read; a
 * community that refuses or is unreachable is reported, not fatal, because membership is per
 * community and being in one and not another is the ordinary case.
 */
export async function syncProfileFromName(options: {
  name: string;
  relays: readonly string[];
  key: AgentKey;
  fetch?: typeof fetch;
  read?: typeof profile.read;
  write?: typeof profile.write;
}): Promise<SyncOutcome[]> {
  const doc = await fetchNameProfile(options.name, options.fetch);
  const wanted = profileFromName(options.name, doc);
  const read = options.read ?? profile.read;
  const write = options.write ?? profile.write;
  const outcomes: SyncOutcome[] = [];
  for (const relay of options.relays) {
    try {
      const current = await read(relay, options.key);
      if (matchesName(current, wanted)) {
        outcomes.push({ relay, outcome: "unchanged" });
        continue;
      }
      await write(relay, options.key, { ...(current ?? {}), ...wanted });
      outcomes.push({ relay, outcome: "updated" });
    } catch (error) {
      const why = (error as Error).message;
      outcomes.push({ relay, outcome: why.includes("not a relay member") ? "not-member" : "failed", detail: why });
    }
  }
  return outcomes;
}
