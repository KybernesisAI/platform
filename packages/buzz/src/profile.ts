import { finalizeEvent } from "nostr-tools/pure";
import type { AgentKey } from "./keys.js";

/**
 * How an agent appears to the people in a community.
 *
 * @remarks
 * A member with no profile shows as a truncated public key, which reads as a
 * stranger rather than as the agent someone was told to talk to. So this is
 * part of joining a community, not a nicety afterwards.
 *
 * Profiles are per relay: each community stores its own copy, and being a
 * member of two means publishing to both. That is the protocol's doing, not a
 * choice here — which is why `copy` exists.
 */

/** NIP-01 metadata. */
export const KIND_PROFILE = 0;

export type Profile = {
  /** The handle, lowercase and without spaces. */
  name?: string;
  /** The name as people should read it. */
  display_name?: string;
  about?: string;
  /** A URL. Relays store the address, never the image. */
  picture?: string;
  /** Says plainly that this is an agent. Clients use it; so should we. */
  bot?: boolean;
};

const now = () => Math.floor(Date.now() / 1000);

/**
 * Connect and wait until the relay has ACCEPTED this identity.
 *
 * @remarks
 * Answering the challenge is not the same as being authenticated, and the
 * difference is one round trip. Resolving on the send races the acceptance, and
 * anything published in that window is refused with `auth-required: not
 * authenticated` — which reads as a permissions problem rather than as a
 * client that spoke too early.
 */
function connect(url: string, key: AgentKey): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const failed = setTimeout(() => reject(new Error(`${url} did not answer`)), 15_000);
    let challenged: string | null = null;

    socket.addEventListener("message", (raw: MessageEvent) => {
      const frame = JSON.parse(String(raw.data)) as unknown[];
      if (frame[0] === "AUTH") {
        const auth = finalizeEvent(
          {
            kind: 22242,
            created_at: now(),
            tags: [
              ["relay", url],
              ["challenge", String(frame[1])],
            ],
            content: "",
          },
          key.secretKey,
        );
        challenged = auth.id;
        socket.send(JSON.stringify(["AUTH", auth]));
        return;
      }
      if (frame[0] === "OK" && frame[1] === challenged) {
        clearTimeout(failed);
        if (frame[2] === true) {
          resolve(socket);
        } else {
          reject(new Error(String(frame[3] ?? "this identity was refused")));
        }
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(failed);
      reject(new Error(`could not reach ${url}`));
    });
  });
}

/** This agent's profile on one relay, if it has one there. */
export async function read(url: string, key: AgentKey): Promise<Profile | null> {
  const socket = await connect(url, key);
  return new Promise((resolve) => {
    const done = (value: Profile | null) => {
      try {
        socket.close();
      } catch {
        /* closing a closed socket is not an error worth raising */
      }
      resolve(value);
    };
    socket.addEventListener("message", (raw: MessageEvent) => {
      const frame = JSON.parse(String(raw.data)) as unknown[];
      if (frame[0] === "EVENT") {
        const event = frame[2] as { content?: string };
        try {
          done(JSON.parse(String(event.content ?? "{}")) as Profile);
        } catch {
          done(null);
        }
      }
      if (frame[0] === "EOSE" || frame[0] === "CLOSED") done(null);
    });
    socket.send(JSON.stringify(["REQ", "profile", { kinds: [KIND_PROFILE], authors: [key.publicKey] }]));
    setTimeout(() => done(null), 12_000);
  });
}

/** Publish this agent's profile to one relay. */
export async function write(url: string, key: AgentKey, profile: Profile): Promise<void> {
  const socket = await connect(url, key);
  return new Promise((resolve, reject) => {
    const event = finalizeEvent(
      { kind: KIND_PROFILE, created_at: now(), tags: [], content: JSON.stringify(profile) },
      key.secretKey,
    );
    socket.addEventListener("message", (raw: MessageEvent) => {
      const frame = JSON.parse(String(raw.data)) as unknown[];
      if (frame[0] === "OK" && frame[1] === event.id) {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        frame[2] === true ? resolve() : reject(new Error(String(frame[3] ?? "refused")));
      }
    });
    socket.send(JSON.stringify(["EVENT", event]));
    setTimeout(() => reject(new Error(`${url} did not acknowledge the profile`)), 15_000);
  });
}

/** Take the profile an agent already has somewhere, and give it the same one here. */
export async function copy(from: string, to: readonly string[], key: AgentKey): Promise<Profile> {
  const profile = await read(from, key);
  if (!profile) throw new Error(`no profile to copy from ${from}`);
  for (const url of to) {
    if (url === from) continue;
    // A community this agent has not been invited to yet is not a failure of
    // the copy; it simply has nowhere to put it.
    try {
      await write(url, key, profile);
    } catch (error) {
      if (!(error as Error).message.includes("not a relay member")) throw error;
    }
  }
  return profile;
}

/**
 * Put an image where the community can serve it, and answer with its URL.
 *
 * @remarks
 * Blossom (BUD-01): the file is addressed by the hash of its own bytes, and the
 * upload is authorised by an event carrying that hash. So the server can check
 * that what arrived is what was signed for, and the same image uploaded twice
 * is the same URL rather than two.
 *
 * It goes to the community rather than to storage of ours, which is the point:
 * an agent's picture should not depend on a bucket belonging to whoever set it
 * up, and nobody should need a blob token to give their agent a face.
 */
export async function uploadImage(
  relay: string,
  key: AgentKey,
  bytes: Uint8Array,
  mediaType: string,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const base = relay.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
  // Stripped BEFORE hashing: the hash has to be of what is actually sent, and a
  // Blossom server checks that for itself.
  const body = stripMetadata(bytes, mediaType);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const expires = now() + 300;

  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: now(),
      tags: [
        ["t", "upload"],
        ["x", sha256],
        ["expiration", String(expires)],
        ["server", new URL(base).host],
      ],
      content: "Upload buzz-media",
    },
    key.secretKey,
  );
  const header = `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64url")}`;

  // PUT, not POST: Blossom addresses a blob by the hash of its bytes, so the
  // upload is idempotent — the same image twice is the same URL, and the verb
  // says so. POST answers 405 here, which reads as a missing endpoint rather
  // than as the wrong method.
  //
  // Newer servers take /upload; older ones only /media/upload. Trying both is
  // cheaper than asking an operator which one they are running.
  let last = "";
  for (const path of ["/upload", "/media/upload"]) {
    const response = await fetch(`${base}${path}`, {
      method: "PUT",
      headers: { authorization: header, "content-type": mediaType, "x-sha-256": sha256 },
      body: body as unknown as BodyInit,
    });
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { url?: unknown; nip94?: unknown };
      if (typeof body.url === "string") return body.url;
      return `${base}/${sha256}`;
    }
    last = `${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`;
  }
  throw new Error(`the community refused the image: ${last}`);
}

/**
 * Remove everything from an image that is not the image.
 *
 * @remarks
 * The community refuses uploads carrying metadata, and it is right to: a photo
 * taken on a phone carries the phone, the time and often the place, and an
 * avatar is exactly the kind of file nobody thinks about before sharing. So
 * this strips rather than asks — the alternative is telling people to run
 * `exiftool` before they can give their agent a face.
 *
 * Both formats are containers of tagged sections, and dropping a section needs
 * no re-encoding: PNG chunks carry their own CRC, and JPEG segments their own
 * length. The pixels are untouched.
 */
export function stripMetadata(bytes: Uint8Array, mediaType: string): Uint8Array {
  if (mediaType === "image/png") return stripPng(bytes);
  if (mediaType === "image/jpeg") return stripJpeg(bytes);
  return bytes;
}

/** The chunks that ARE the image. Everything else is commentary. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const signature = bytes.subarray(0, 8);
  if (signature[0] !== 0x89 || signature[1] !== 0x50) return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [signature];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const total = 12 + length; // length + type + data + crc
    if (PNG_KEEP.has(name)) kept.push(bytes.subarray(at, at + total));
    at += total;
    if (name === "IEND") break;
  }

  const size = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    // Start of scan: everything after it is pixel data.
    if (marker === 0xda) {
      kept.push(bytes.subarray(at));
      break;
    }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn, COM
    if (!isMetadata) kept.push(bytes.subarray(at, at + 2 + length));
    at += 2 + length;
  }

  const size = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What kind of image this is, from its name. */
export function mediaTypeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] ??
    "application/octet-stream"
  );
}
