import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DELETE, GET, POST, type RouteDefinition } from "eve/channels";

/**
 * Artifacts the agent made for someone (`@kybernesis/artifacts`), for that
 * person's own apps. KYBER Studio and the phone draw an artifact card from a
 * tool result, then come here for the page itself.
 *
 * Unlike delivered files these are not public by link. A page holds whatever
 * the person asked about (their pipeline, their numbers), so every route checks
 * the caller's control-plane identity and answers only with artifacts that
 * caller owns. One nobody owns (a routine made it) is shown to people who
 * manage the agent. Anything else is a 404, so an id says nothing about whether
 * it exists.
 *
 * This reads the directory `@kybernesis/artifacts` writes and never writes to
 * it. The layout is a contract between the two packages:
 *
 *   <dir>/<id>/meta.json   { id, title, format, display, owner, createdAt, updatedAt, version, versions[] }
 *   <dir>/<id>/v<n>.html   (or .md) the content of version n
 *
 * Share links are the one exception to "not public by link", and only by the
 * owner's act: posting an artifact into a shared conversation (a Buzz channel)
 * shares that version with everyone there. The owner asks for a link, the link
 * is 128 random bits, and the owner can withdraw it. Links live in their own
 * directory, which only this file writes.
 */

export interface ArtifactsOptions {
  /** Where artifacts live. Defaults to ARTIFACTS_DIR, then ~/.kybernesis/artifacts. */
  dir?: string;
  /** Where share links live. Defaults to ARTIFACT_SHARES_DIR, then ~/.kybernesis/artifact-shares. */
  sharesDir?: string;
  /**
   * This agent's public https origin, which share links are built on. Defaults
   * to EVE_PUBLIC_URL, then `https://<EXE_VM_NAME>.exe.xyz`, the same address
   * delivered files use. Without one, sharing answers 409.
   */
  publicUrl?: string;
}

/** Who is asking, as the route's authorization established it. */
export interface ArtifactViewer {
  userId: string;
  /** The caller's grant on this agent. */
  level: string;
}

interface Meta {
  id: string;
  title: string;
  format: "html" | "markdown";
  display: "inline" | "document";
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  versions: Array<{ version: number; createdAt: string; bytes: number; note?: string }>;
}

const ID = /^[0-9a-f]{32}$/;

export function artifactsDir(options: ArtifactsOptions = {}): string {
  return options.dir ?? process.env.ARTIFACTS_DIR ?? join(homedir(), ".kybernesis", "artifacts");
}

export function sharesDir(options: ArtifactsOptions = {}): string {
  return options.sharesDir ?? process.env.ARTIFACT_SHARES_DIR ?? join(homedir(), ".kybernesis", "artifact-shares");
}

function publicOrigin(options: ArtifactsOptions): string | undefined {
  const vm = process.env.EXE_VM_NAME?.trim();
  const origin = options.publicUrl ?? (process.env.EVE_PUBLIC_URL?.trim() || (vm ? `https://${vm}.exe.xyz` : ""));
  return origin ? origin.replace(/\/$/, "") : undefined;
}

/** One share link: who made it, for which version. The token is its file name. */
export interface ArtifactShare {
  token: string;
  artifactId: string;
  version: number;
  userId: string;
  createdAt: string;
}

const TOKEN = /^[0-9a-f]{32}$/;

function readShare(dir: string, token: string): ArtifactShare | null {
  if (!TOKEN.test(token)) return null;
  try {
    const share = JSON.parse(readFileSync(join(dir, `${token}.json`), "utf8")) as ArtifactShare;
    return share.token === token ? share : null;
  } catch {
    return null;
  }
}

function listShares(dir: string): ArtifactShare[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => (name.endsWith(".json") ? (readShare(dir, name.slice(0, -5)) ?? []) : []));
}

/** The link for this person and version, made once: posting the same version twice gives the same link. */
export function shareArtifact(dir: string, artifactId: string, version: number, userId: string, now = new Date()): ArtifactShare {
  const existing = listShares(dir).find((s) => s.artifactId === artifactId && s.version === version && s.userId === userId);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const share: ArtifactShare = { token: randomBytes(16).toString("hex"), artifactId, version, userId, createdAt: now.toISOString() };
  const file = join(dir, `${share.token}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(share), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return share;
}

/**
 * The policy a shared page runs under when opened directly. `sandbox` without
 * `allow-same-origin` gives it no origin, so it cannot read anything of this
 * agent's; it may run its own inline code and draw, and fetch nothing.
 */
export const SHARED_PAGE_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A markdown artifact as a readable page: its text, as written, in a plain column. */
function markdownPage(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:24px;font:15px/1.6 Inter,system-ui,-apple-system,sans-serif;color:#16181d;background:#fff}main{max-width:720px;margin:0 auto;white-space:pre-wrap;overflow-wrap:anywhere}@media (prefers-color-scheme:dark){body{color:#f2f3f5;background:#1b1d22}}</style></head><body><main>${escapeHtml(text)}</main></body></html>`;
}

export function visibleTo(meta: Pick<Meta, "owner">, viewer: ArtifactViewer): boolean {
  return meta.owner ? meta.owner === viewer.userId : viewer.level === "manage";
}

function readMeta(dir: string, id: string): Meta | null {
  if (!ID.test(id)) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8")) as Meta;
    return meta.id === id ? meta : null;
  } catch {
    return null;
  }
}

/** What a client is shown about an artifact. The owner id stays on the host. */
function publicMeta(meta: Meta) {
  const { owner: _owner, ...rest } = meta;
  return rest;
}

export function listVisible(dir: string, viewer: ArtifactViewer): Meta[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Meta[] = [];
  for (const id of ids) {
    const meta = readMeta(dir, id);
    if (meta && visibleTo(meta, viewer)) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const NOT_FOUND = () => Response.json({ ok: false, error: "No such artifact." }, { status: 404, headers: { "cache-control": "no-store" } });

export function artifactRoutes(input: {
  prefix: string;
  options: ArtifactsOptions;
  identify: (req: Request) => Promise<ArtifactViewer | Response>;
}): RouteDefinition[] {
  const base = `${input.prefix}/artifacts`;
  // Share links sit apart from the artifact routes: eve treats routes that
  // differ only where one side has a parameter as the same route, so
  // `artifacts/shared/:token` would clash with `artifacts/:id/shares`.
  const sharedBase = `${input.prefix}/artifact-shares`;
  const dir = () => artifactsDir(input.options);

  const shares = () => sharesDir(input.options);

  return [
    /**
     * A shared version, by its link. No sign-in: the link is the credential.
     * Withdrawn links, and links to an artifact that is gone, are a 404.
     */
    GET(`${sharedBase}/:token`, async (_req, { params }) => {
      const share = readShare(shares(), String(params.token));
      const meta = share ? readMeta(dir(), share.artifactId) : null;
      if (!share || !meta || share.version > meta.version) return NOT_FOUND();
      let body: string;
      try {
        body = readFileSync(join(dir(), meta.id, `v${share.version}.${meta.format === "markdown" ? "md" : "html"}`), "utf8");
      } catch {
        return NOT_FOUND();
      }
      return new Response(meta.format === "markdown" ? markdownPage(meta.title, body) : body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": SHARED_PAGE_POLICY,
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex",
          "cache-control": "private, max-age=60",
          "x-artifact-version": String(share.version),
          "x-artifact-format": meta.format,
        },
      });
    }),

    // Withdraw a link. Only the person who made it can.
    DELETE(`${sharedBase}/:token`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      const share = readShare(shares(), String(params.token));
      if (!share || share.userId !== viewer.userId) return NOT_FOUND();
      try {
        renameSync(join(shares(), `${share.token}.json`), join(shares(), `${share.token}.withdrawn`));
      } catch {
        return NOT_FOUND();
      }
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }),

    // The caller's share links for one artifact, so an app can list and withdraw them.
    GET(`${base}/:id/shares`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      const meta = readMeta(dir(), String(params.id));
      if (!meta || !visibleTo(meta, viewer)) return NOT_FOUND();
      const origin = publicOrigin(input.options);
      const mine = listShares(shares()).filter((s) => s.artifactId === meta.id && s.userId === viewer.userId);
      return Response.json(
        {
          ok: true,
          shares: mine.map((s) => ({ token: s.token, version: s.version, createdAt: s.createdAt, url: origin ? `${origin}${sharedBase}/${s.token}` : undefined })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }),

    /**
     * Share one version. Body `{ version? }`, latest by default. The owner
     * asks, typically through the channel they posted it in; the answer is a
     * link anyone holding it can open.
     */
    POST(`${base}/:id/share`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      const meta = readMeta(dir(), String(params.id));
      if (!meta || !visibleTo(meta, viewer)) return NOT_FOUND();
      const origin = publicOrigin(input.options);
      if (!origin) {
        return Response.json(
          { ok: false, error: "This agent doesn't know its public address (EVE_PUBLIC_URL or EXE_VM_NAME), so it can't make a link." },
          { status: 409 },
        );
      }
      let asked: unknown;
      try {
        asked = ((await req.json()) as { version?: unknown } | null)?.version;
      } catch {
        asked = undefined;
      }
      const version = asked === undefined || asked === null ? meta.version : Number(asked);
      if (!Number.isInteger(version) || version < 1 || version > meta.version) return NOT_FOUND();
      const share = shareArtifact(shares(), meta.id, version, viewer.userId);
      return Response.json(
        { ok: true, token: share.token, version, url: `${origin}${sharedBase}/${share.token}` },
        { headers: { "cache-control": "no-store" } },
      );
    }),

    // The caller's artifacts, newest first: the Artifacts tab in each app.
    GET(base, async (req) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      return Response.json(
        { ok: true, artifacts: listVisible(dir(), viewer).map(({ owner: _o, versions: _v, ...summary }) => summary) },
        { headers: { "cache-control": "no-store" } },
      );
    }),

    // One artifact and its version history.
    GET(`${base}/:id`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      const meta = readMeta(dir(), String(params.id));
      if (!meta || !visibleTo(meta, viewer)) return NOT_FOUND();
      return Response.json({ ok: true, artifact: publicMeta(meta) }, { headers: { "cache-control": "no-store" } });
    }),

    /**
     * The page, as text, for the app to put into its own sandbox (with the
     * house style kit) rather than for a browser to run. text/plain, nosniff
     * and a sandbox CSP make sure that opening the URL directly shows source
     * and never executes it as this agent's origin.
     */
    GET(`${base}/:id/content`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      const meta = readMeta(dir(), String(params.id));
      if (!meta || !visibleTo(meta, viewer)) return NOT_FOUND();
      const asked = new URL(req.url).searchParams.get("v");
      const version = asked === null ? meta.version : Number(asked);
      if (!Number.isInteger(version) || version < 1 || version > meta.version) return NOT_FOUND();
      let body: string;
      try {
        body = readFileSync(join(dir(), meta.id, `v${version}.${meta.format === "markdown" ? "md" : "html"}`), "utf8");
      } catch {
        return NOT_FOUND();
      }
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "referrer-policy": "no-referrer",
          "cache-control": "private, no-store",
          "x-artifact-id": meta.id,
          "x-artifact-version": String(version),
          "x-artifact-latest": String(meta.version),
          "x-artifact-format": meta.format,
        },
      });
    }),
  ];
}
