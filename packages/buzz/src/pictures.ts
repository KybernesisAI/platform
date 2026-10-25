import type { Card } from "@kybernesis/cards";
import type { AgentKey } from "./keys.js";
import { uploadMedia, type UploadedMedia } from "./profile.js";

/**
 * A screenshot the agent showed someone, as a picture in the conversation.
 *
 * @remarks
 * `show_screen` keeps the image on the agent's machine and names it by a path
 * on the agent (`/eve/v1/kyb/screens/<id>.png`) that only the person it was
 * taken for can read. KYBER Studio fetches it with that person's token. Buzz
 * cannot: the cards plugin has no token, so it drew "This picture is on the
 * agent and can't be shown here", and Buzz without the plugin showed only the
 * caption.
 *
 * So the bridge fetches it, as the person who asked, and puts it in the
 * community's own media store, which serves only members of that community.
 * The message is an ordinary Buzz picture message (the words, a Markdown image
 * and its `imeta` tag, as Buzz's own composer writes them), so every Buzz app
 * draws it, with or without the plugin. Asking for a screenshot in a channel
 * shares it with that channel, the same as an artifact posted there.
 */

/** The only address a screenshot card may name for the bridge to fetch: one on the agent, by id. */
const SCREEN_PATH = /^\/eve\/v1\/kyb\/screens\/[0-9a-f]{32}(?:\.png)?$/;

/** Larger than any screen; the community's own limit for images is higher still. */
const MAX_BYTES = 20 * 1024 * 1024;

export interface PictureMessage {
  content: string;
  tags: string[][];
}

export interface PictureOptions {
  /** The agent's base URL, where the screenshot is served. */
  agentUrl: string;
  /** The asker's headers for the agent: the screenshot is theirs to read. */
  headers: () => Promise<Record<string, string>>;
  /** The community the message goes to: its media store holds the picture. */
  relay: string;
  key: AgentKey;
  fetchImpl?: typeof fetch;
  upload?: (relay: string, key: AgentKey, bytes: Uint8Array, mediaType: string) => Promise<UploadedMedia>;
}

/** Whether this card is a screenshot the bridge can carry as a picture. */
export function isAgentScreenshot(card: Card): boolean {
  if (card.card !== "screenshot" || !card.data || typeof card.data !== "object") return false;
  const image = (card.data as { image?: unknown }).image;
  return typeof image === "string" && SCREEN_PATH.test(image);
}

/**
 * The screenshot card as a Buzz picture message, or null when it is not one
 * the bridge carries. Throws when the picture cannot be fetched or stored; the
 * caller then posts the card as it was.
 */
export async function pictureMessage(card: Card, options: PictureOptions): Promise<PictureMessage | null> {
  if (!isAgentScreenshot(card)) return null;
  const data = card.data as { image: string; caption?: unknown; site?: unknown; width?: unknown; height?: unknown };
  const fetchImpl = options.fetchImpl ?? fetch;
  const upload = options.upload ?? uploadMedia;

  const response = await fetchImpl(`${options.agentUrl.replace(/\/$/, "")}${data.image}`, {
    headers: await options.headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} fetching the screenshot from the agent`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("the screenshot is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const size = pngSize(bytes);
  if (!size || bytes.byteLength > MAX_BYTES) throw new Error("the agent did not answer with a PNG");

  const stored = await upload(options.relay, options.key, bytes, "image/png");

  const caption = typeof data.caption === "string" ? oneLine(data.caption) : "";
  const site = typeof data.site === "string" ? oneLine(data.site) : "";
  const words = caption && site ? `${caption} (${site})` : caption || site || "A screenshot from the agent's computer.";
  return {
    content: `${words}\n\n![${markdownLabel(caption || "Screenshot")}](<${stored.url}>)`,
    tags: [
      [
        "imeta",
        `url ${stored.url}`,
        "m image/png",
        `x ${stored.sha256}`,
        `size ${stored.size}`,
        `dim ${size.width}x${size.height}`,
        "filename screenshot.png",
      ],
    ],
  };
}

/** Width and height from a PNG's header, when the bytes are one. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A Markdown image label, escaped the way Buzz escapes an attachment's name. */
function markdownLabel(text: string): string {
  return Array.from(text, (char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/[\\`*_{}[\]()!<>&]/g, "\\$&");
}
