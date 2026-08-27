import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import type { AgentKey } from "./keys.js";
import type { NostrEvent } from "./relay.js";

/** One attachment on an inbound message. */
export interface MediaRef {
  url: string;
  /** From the `m` field when the client sends one; the response may correct it. */
  mediaType?: string;
  /** From the `x` field: the hash the blob is addressed by. */
  sha256?: string;
}

/** Fetched bytes, ready to become a message part. */
export interface FetchedMedia {
  url: string;
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * The attachments on a message, from its `imeta` tags (NIP-92).
 *
 * @remarks
 * A Buzz client does NOT inline an attachment into the message text. The
 * content stays prose — often prose *about* the picture — and the media lives
 * in a tag. A bridge that reads only `event.content` therefore sees a caption
 * with nothing attached, and, when there is no caption, sees nothing at all.
 *
 * Both were reported from a live deployment: an image with a caption was
 * answered as though the caption were the whole message, and an image without
 * one produced no response and no log line. The agent could not tell either had
 * happened, so it speculated about its own vision support — which was fine.
 */
export function parseMedia(event: NostrEvent): MediaRef[] {
  const media: MediaRef[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    // An imeta tag is space-separated "key value" pairs, one per element.
    const fields = new Map<string, string>();
    for (const entry of tag.slice(1)) {
      const space = entry.indexOf(" ");
      if (space > 0) fields.set(entry.slice(0, space), entry.slice(space + 1));
    }
    const url = fields.get("url");
    if (url) media.push({ url, mediaType: fields.get("m"), sha256: fields.get("x") });
  }
  return media;
}

/**
 * Fetch one attachment as the agent.
 *
 * @remarks
 * Buzz media is authenticated: an anonymous GET answers 401, not 404. So the
 * URL cannot simply be handed to the model — a provider fetching it would be
 * refused, and the failure would surface as a broken image rather than as an
 * auth problem. The bytes are fetched here, with the same Blossom
 * authorisation this package already signs to upload an agent's avatar, and
 * passed inline.
 *
 * `t get` rather than `t upload`, and the blob's own hash when the sender told
 * us one, so the authorisation is scoped to reading that specific blob.
 */
export async function fetchMedia(
  key: AgentKey,
  ref: MediaRef,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedMedia> {
  const expires = Math.floor(Date.now() / 1000) + 300;
  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "get"],
        ...(ref.sha256 ? [["x", ref.sha256]] : []),
        ["expiration", String(expires)],
      ],
      content: "Fetch buzz-media",
    },
    key.secretKey,
  );

  const response = await fetchImpl(ref.url, {
    headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64url")}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${ref.url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  // The server's answer wins over the sender's claim: the sender's `m` field is
  // whatever their client asserted, and a wrong media type reaches the model as
  // an image it cannot decode.
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() || ref.mediaType || "application/octet-stream";

  if (ref.sha256) {
    // Blossom addresses a blob BY its hash, so a mismatch means the bytes are
    // not the ones that were sent. Cheap to check and not worth trusting past.
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== ref.sha256) {
      throw new Error(`content hash mismatch for ${ref.url}`);
    }
  }
  return { url: ref.url, mediaType, bytes };
}

/** Whether the model can be shown this directly, or only told about it. */
export function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}
