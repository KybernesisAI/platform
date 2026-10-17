import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GET } from "eve/channels";

/**
 * Files the agent made for someone, served from the agent's own address.
 *
 * The engineer's `deliver` tool writes a finished file under the delivery
 * directory and hands back a link here. The customer's files then stay on the
 * customer's agent: no shared bucket, nothing in anyone else's account.
 *
 * These routes are deliberately unauthenticated. A link is opened from a chat,
 * an email or a phone, by people who hold no token for this agent, so the
 * link itself is the credential: 128 random bits in the path, the same model
 * as a public object-store URL. Everything else is about keeping that the ONLY
 * way in.
 */

export interface FilesOptions {
  /** Where delivered files live. Defaults to DELIVER_DIR, then ~/.kybernesis/deliveries. */
  dir?: string;
}

/** The id `deliver` mints: 16 random bytes as lowercase hex. */
const ID = /^[0-9a-f]{32}$/;
/** The names `deliver` writes: its own sanitised character set, no leading dot. */
const NAME = /^[\w\-()+ ][\w.\-()+ ]{0,199}$/;

const TYPES: Record<string, string> = {
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  zip: "application/zip",
};

export function deliveryDir(options: FilesOptions = {}): string {
  return options.dir ?? process.env.DELIVER_DIR ?? join(homedir(), ".kybernesis", "deliveries");
}

/**
 * The file a link names, or null when the link does not name one.
 *
 * Both parts are matched against what `deliver` writes rather than cleaned up,
 * so no input can climb out of the directory: a slash, a leading dot or a
 * percent sequence that decodes to one simply fails the pattern.
 */
export function resolveDelivery(dir: string, id: string, name: string): { path: string; contentType: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!ID.test(id) || !NAME.test(decoded)) return null;
  const path = join(dir, id, decoded);
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const ext = decoded.includes(".") ? decoded.split(".").pop()!.toLowerCase() : "";
  return { path, contentType: TYPES[ext] ?? "application/octet-stream" };
}

/**
 * Headers for a delivered file.
 *
 * The page renders in a sandbox, so a delivered web page can run its own
 * scripts without ever running as the agent's origin, and the link is not
 * leaked to whatever the page links to.
 */
export function deliveryHeaders(contentType: string, name: string): Record<string, string> {
  const inline = /^(text\/|image\/|application\/pdf)/.test(contentType);
  return {
    "content-type": contentType,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "private, max-age=300",
  };
}

export function fileRoutes({ prefix, options }: { prefix: string; options: FilesOptions }) {
  const base = `${prefix}/files`;
  return [
    // Answers so a host check can tell "served" from "configured" without a
    // real link. It says nothing about what is stored.
    GET(base, async () => Response.json({ ok: true, files: "served" })),
    GET(`${base}/:id/:name`, async (_req, { params }) => {
      const found = resolveDelivery(deliveryDir(options), String(params.id), String(params.name));
      if (!found) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      const name = decodeURIComponent(String(params.name));
      return new Response(readFileSync(found.path), { status: 200, headers: deliveryHeaders(found.contentType, name) });
    }),
  ];
}
