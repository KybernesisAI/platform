import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GET, type RouteDefinition } from "eve/channels";

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
 */

export interface ArtifactsOptions {
  /** Where artifacts live. Defaults to ARTIFACTS_DIR, then ~/.kybernesis/artifacts. */
  dir?: string;
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
  const dir = () => artifactsDir(input.options);

  return [
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
