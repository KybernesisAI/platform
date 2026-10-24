import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GET, type RouteDefinition } from "eve/channels";
import { type ArtifactViewer, visibleTo } from "./artifacts.js";

/**
 * Screenshots the agent showed someone (`show_screen` in `@kybernesis/computer`),
 * for that person's own apps. A screenshot card names `/eve/v1/kyb/screens/<id>`;
 * KYBER Studio and the phone fetch it with the person's token.
 *
 * A screen can show anything the agent had open (a checkout, an inbox), so it
 * is never public by link: the person it was taken for sees it, and one taken
 * for nobody (a routine) is shown to people who manage the agent. Anything else
 * is a 404.
 *
 * This reads the directory `@kybernesis/computer` writes and never writes to
 * it. The layout is a contract between the two packages:
 *
 *   <dir>/<id>.png    the image
 *   <dir>/<id>.json   { id, owner, takenAt, site?, caption?, width?, height? }
 */

export interface ScreensOptions {
  /** Where screenshots live. Defaults to SCREENS_DIR, then ~/.kybernesis/screens. */
  dir?: string;
}

const ID = /^[0-9a-f]{32}$/;

export function screensDir(options: ScreensOptions = {}): string {
  return options.dir ?? process.env.SCREENS_DIR ?? join(homedir(), ".kybernesis", "screens");
}

const NOT_FOUND = () => Response.json({ ok: false, error: "No such screenshot." }, { status: 404, headers: { "cache-control": "no-store" } });

export function screenRoutes(input: {
  prefix: string;
  options: ScreensOptions;
  identify: (req: Request) => Promise<ArtifactViewer | Response>;
}): RouteDefinition[] {
  const base = `${input.prefix}/screens`;
  const dir = () => screensDir(input.options);

  return [
    GET(`${base}/:id`, async (req, { params }) => {
      const viewer = await input.identify(req);
      if (viewer instanceof Response) return viewer;
      // The card names the file with its extension; either form is the same screenshot.
      const id = String(params.id).replace(/\.png$/, "");
      if (!ID.test(id)) return NOT_FOUND();
      let meta: { id?: string; owner?: string | null };
      let image: Buffer;
      try {
        meta = JSON.parse(readFileSync(join(dir(), `${id}.json`), "utf8")) as typeof meta;
        image = readFileSync(join(dir(), `${id}.png`));
      } catch {
        return NOT_FOUND();
      }
      if (meta.id !== id || !visibleTo({ owner: meta.owner ?? null }, viewer)) return NOT_FOUND();
      return new Response(new Uint8Array(image), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(image.byteLength),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "referrer-policy": "no-referrer",
          "cache-control": "private, no-store",
        },
      });
    }),
  ];
}
