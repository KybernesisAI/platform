import type { AgentKey } from "./keys.js";
import * as profile from "./profile.js";
import type { Profile } from "./profile.js";
import { fetchNameProfile, type NameProfile, type SyncOutcome } from "./agentid.js";

/**
 * The agent's face in every community: the name and picture its owner chose.
 *
 * @remarks
 * The owner sets them in the app or KYBER Studio, and the control plane holds them. Before
 * this, a community only ever saw what was published when the agent joined (its bare
 * registered name) or what its `.agent` name said, so a new picture or name chosen by the
 * owner never reached Buzz, and a name sync put the old one back. Now the owner's choice wins
 * field by field and the `.agent` name fills the gaps, the same order every client draws.
 *
 * The control plane keeps the picture as a small data URL; a profile can only carry an
 * address. So the picture is uploaded to a community's own media store, addressed by the hash
 * of its bytes, and a community whose copy already points at that hash is left alone.
 */

export type Face = {
  /** The handle: lowercase, no spaces. */
  handle: string;
  /** Null when nobody has chosen one: the community keeps what it has. */
  displayName: string | null;
  /** A data URL, an https address, or null to leave the picture as it is. */
  picture: string | null;
  about: string | null;
  nip05: string | null;
};

type ControlPlaneFace = {
  agent: string;
  displayName: string | null;
  picture: string | null;
  about: string | null;
  nip05: string | null;
};

/** GET /api/agent/profile: the calling agent's own face, as its owner set it. */
export async function fetchControlPlaneFace(options: {
  issuer: string;
  credential: string;
  fetch?: typeof fetch;
}): Promise<ControlPlaneFace> {
  const url = `${options.issuer.replace(/\/+$/, "")}/api/agent/profile`;
  const res = await (options.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${options.credential}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the control plane did not give this agent's profile (${res.status} from ${url})`);
  return (await res.json()) as ControlPlaneFace;
}

function handleOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * What the agent should look like: the owner's choices over its `.agent` name.
 *
 * @remarks
 * Either source may be missing (an older control plane, an agent with no name); only both
 * missing is an error. The `.agent` name is read even when the control plane answers, because
 * the control plane only folds it in once the name lists the agent back as verified, and an
 * agent that has always taken its picture from its name should keep doing so.
 */
export async function resolveFace(options: {
  /** The `.agent` name, when this agent has one. */
  name: string | null;
  issuer?: string;
  credential?: string;
  fetch?: typeof fetch;
}): Promise<Face> {
  let owner: ControlPlaneFace | null = null;
  let ownerError: Error | null = null;
  if (options.issuer && options.credential) {
    try {
      owner = await fetchControlPlaneFace({ issuer: options.issuer, credential: options.credential, fetch: options.fetch });
    } catch (error) {
      ownerError = error as Error;
    }
  }
  let named: NameProfile | null = null;
  let nameError: Error | null = null;
  if (options.name) {
    try {
      named = await fetchNameProfile(options.name, options.fetch);
    } catch (error) {
      nameError = error as Error;
    }
  }
  if (!owner && !named) {
    throw ownerError ?? nameError ?? new Error("Nothing says who this agent is: no control plane credential and no .agent name.");
  }
  return {
    handle: options.name ?? handleOf(owner!.agent),
    displayName: owner?.displayName ?? named?.name ?? null,
    picture: owner?.picture ?? named?.picture ?? null,
    about: owner?.about ?? (named?.description || null),
    nip05: owner?.nip05 ?? named?.nip05 ?? null,
  };
}

/** A picture held as a data URL, decoded and stripped the way an upload will be. */
async function pictureBytes(dataUrl: string): Promise<{ bytes: Uint8Array; mediaType: string; sha256: string } | null> {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const mediaType = match[1]!.toLowerCase();
  const bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(profile.stripMetadata(bytes, mediaType)).digest("hex");
  return { bytes, mediaType, sha256 };
}

/** The profile fields the face decides, given where its picture now lives. */
export function profileFromFace(face: Face, pictureUrl: string | null): Profile {
  return {
    name: face.handle,
    ...(face.displayName ? { display_name: face.displayName } : {}),
    ...(face.about ? { about: face.about } : {}),
    ...(pictureUrl ? { picture: pictureUrl } : {}),
    ...(face.nip05 ? { nip05: face.nip05 } : {}),
    bot: true,
  };
}

/**
 * Bring this agent's profile in every community in line with its face.
 *
 * @remarks
 * Each community is read first; only one whose copy differs is written, so running this on a
 * timer costs one read per community when nothing has changed. A picture is uploaded at most
 * once per change, to the first community that takes it, and that address is used everywhere,
 * the way `kybernesis-buzz profile --picture` always has. Fields the face does not decide are
 * kept. A community that refuses or cannot be reached is reported, not fatal.
 */
export async function syncProfile(options: {
  face: Face;
  relays: readonly string[];
  key: AgentKey;
  read?: typeof profile.read;
  write?: typeof profile.write;
  upload?: typeof profile.uploadImage;
}): Promise<SyncOutcome[]> {
  const read = options.read ?? profile.read;
  const write = options.write ?? profile.write;
  const upload = options.upload ?? profile.uploadImage;
  const { face, key } = options;

  const current = new Map<string, Profile | null>();
  const outcomes = new Map<string, SyncOutcome>();
  for (const relay of options.relays) {
    try {
      current.set(relay, await read(relay, key));
    } catch (error) {
      const why = (error as Error).message;
      outcomes.set(relay, { relay, outcome: why.includes("not a relay member") ? "not-member" : "failed", detail: why });
    }
  }

  // Where the picture lives. Null leaves each community's picture as it is.
  let pictureUrl: string | null = null;
  let pictureProblem: string | null = null;
  if (face.picture && /^https:\/\//.test(face.picture)) {
    pictureUrl = face.picture;
  } else if (face.picture) {
    const picture = await pictureBytes(face.picture);
    if (!picture) {
      pictureProblem = "the picture is not an image this can send";
    } else {
      pictureUrl = [...current.values()].map((p) => p?.picture).find((url) => url?.includes(picture.sha256)) ?? null;
      for (const relay of current.keys()) {
        if (pictureUrl) break;
        try {
          pictureUrl = await upload(relay, key, picture.bytes, picture.mediaType);
        } catch (error) {
          pictureProblem = (error as Error).message;
        }
      }
    }
  }

  const wanted = profileFromFace(face, pictureUrl);
  for (const [relay, existing] of current) {
    const matches = existing && (Object.keys(wanted) as Array<keyof Profile>).every((field) => existing[field] === wanted[field]);
    if (matches) {
      outcomes.set(relay, { relay, outcome: "unchanged" });
      continue;
    }
    try {
      await write(relay, key, { ...(existing ?? {}), ...wanted });
      outcomes.set(relay, { relay, outcome: "updated", ...(pictureProblem ? { detail: `picture not sent: ${pictureProblem}` } : {}) });
    } catch (error) {
      const why = (error as Error).message;
      outcomes.set(relay, { relay, outcome: why.includes("not a relay member") ? "not-member" : "failed", detail: why });
    }
  }
  return options.relays.map((relay) => outcomes.get(relay)!);
}
