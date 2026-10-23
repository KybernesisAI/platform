import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Artifacts: pages the agent makes for a person (a report, a dashboard, a
 * tracker) that KYBER Studio and the phone draw inline, and that live on the
 * agent's own machine.
 *
 * The store is a directory, one folder per artifact:
 *
 *   <dir>/<id>/meta.json   what it is, who it belongs to, its versions
 *   <dir>/<id>/v<n>.html   (or .md) the content of version n
 *
 * An update writes a new version under the same id, so a card posted three
 * turns ago still opens the latest. `@kybernesis/manage` serves this directory
 * read-only under /eve/v1/kyb/artifacts, scoped to the person who asked; the
 * format is a contract between the two packages, so change both or neither.
 */

export type ArtifactFormat = "html" | "markdown";
export type ArtifactDisplay = "inline" | "document";

export interface ArtifactVersion {
  version: number;
  createdAt: string;
  bytes: number;
  /** What changed, in the agent's words. Optional. */
  note?: string;
}

export interface ArtifactMeta {
  id: string;
  title: string;
  format: ArtifactFormat;
  display: ArtifactDisplay;
  /** The person it belongs to (control-plane user id), or null when no signed-in person asked for it. */
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  /** The latest version number. */
  version: number;
  versions: ArtifactVersion[];
}

export interface StoreOptions {
  /** Where artifacts live. Defaults to ARTIFACTS_DIR, then ~/.kybernesis/artifacts. */
  dir?: string;
  /** Clock, for tests. */
  now?: () => Date;
}

/** 16 random bytes as lowercase hex, the same shape as a delivered file's id. */
export const ARTIFACT_ID = /^[0-9a-f]{32}$/;
/** Largest content one version may hold. */
export const MAX_BYTES = 2 * 1024 * 1024;
/** Versions kept per artifact; older content files are removed, their history lines stay. */
export const KEEP_VERSIONS = 50;
export const MAX_TITLE = 120;

export function artifactsDir(options: StoreOptions = {}): string {
  return options.dir ?? process.env.ARTIFACTS_DIR ?? join(homedir(), ".kybernesis", "artifacts");
}

export function contentFile(format: ArtifactFormat, version: number): string {
  return `v${version}.${format === "markdown" ? "md" : "html"}`;
}

/** The shape of eve's tool context this package reads. Structural, so the package has no opinion about the rest. */
export interface PrincipalContext {
  readonly session?: {
    readonly auth?: {
      readonly current?: {
        readonly principalId?: string;
        readonly authenticator?: string;
        readonly principalType?: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      } | null;
    };
  };
}

export interface Viewer {
  /** The person, or null when the turn has no signed-in person (a routine, local dev). */
  person: string | null;
  /** Whether they may change this agent; such a person also sees artifacts nobody owns. */
  manages: boolean;
}

/**
 * Who this turn is for. Default-deny: only a principal the control plane
 * itself authenticated as a user counts as a person. eve's local-dev, app and
 * channel-default principals are nobody, so what they make belongs to nobody.
 */
export function viewerFromContext(ctx: PrincipalContext): Viewer {
  const current = ctx.session?.auth?.current;
  if (!current?.principalId || current.authenticator !== "kybernesis" || current.principalType !== "user") {
    return { person: null, manages: false };
  }
  return { person: current.principalId, manages: current.attributes?.agentGrantLevel === "manage" };
}

/**
 * Whether a viewer may see an artifact. An owned artifact is its owner's
 * alone. One nobody owns (made by a routine, say) is visible to the people who
 * manage the agent, and to a turn with no person, which is the agent itself.
 */
export function canSee(meta: Pick<ArtifactMeta, "owner">, viewer: Viewer): boolean {
  if (meta.owner) return meta.owner === viewer.person;
  return viewer.person === null || viewer.manages;
}

export class ArtifactError extends Error {}

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) throw new ArtifactError("An artifact needs a title.");
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

function checkContent(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) throw new ArtifactError("The artifact is empty.");
  if (bytes > MAX_BYTES) {
    throw new ArtifactError(`The artifact is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_BYTES / 1024 / 1024} MB. Trim the data or split it.`);
  }
  return bytes;
}

/** Write via a temporary file and a rename, so a reader never sees half a file. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readMeta(id: string, options: StoreOptions = {}): ArtifactMeta | null {
  if (!ARTIFACT_ID.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(artifactsDir(options), id, "meta.json"), "utf8")) as ArtifactMeta;
  } catch {
    return null;
  }
}

export interface CreateInput {
  title: string;
  content: string;
  format?: ArtifactFormat;
  display?: ArtifactDisplay;
  owner: string | null;
}

export function createArtifact(input: CreateInput, options: StoreOptions = {}): ArtifactMeta {
  const title = cleanTitle(input.title);
  const bytes = checkContent(input.content);
  const format = input.format ?? "html";
  const now = (options.now?.() ?? new Date()).toISOString();
  const id = randomBytes(16).toString("hex");
  const folder = join(artifactsDir(options), id);
  mkdirSync(folder, { recursive: true });
  writeAtomic(join(folder, contentFile(format, 1)), input.content);
  const meta: ArtifactMeta = {
    id,
    title,
    format,
    display: input.display ?? "document",
    owner: input.owner,
    createdAt: now,
    updatedAt: now,
    version: 1,
    versions: [{ version: 1, createdAt: now, bytes }],
  };
  writeAtomic(join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export interface UpdateInput {
  id: string;
  content: string;
  title?: string;
  display?: ArtifactDisplay;
  note?: string;
}

/**
 * A new version of an artifact the viewer can see. The format stays what it
 * was: a card already drawn as HTML should not turn into markdown under it.
 */
export function updateArtifact(input: UpdateInput, viewer: Viewer, options: StoreOptions = {}): ArtifactMeta {
  const meta = readMeta(input.id, options);
  if (!meta || !canSee(meta, viewer)) throw new ArtifactError(`There is no artifact ${input.id} here for this person.`);
  const bytes = checkContent(input.content);
  const now = (options.now?.() ?? new Date()).toISOString();
  const version = meta.version + 1;
  const folder = join(artifactsDir(options), meta.id);
  writeAtomic(join(folder, contentFile(meta.format, version)), input.content);
  const note = input.note?.replace(/\s+/g, " ").trim().slice(0, 200);
  const next: ArtifactMeta = {
    ...meta,
    title: input.title ? cleanTitle(input.title) : meta.title,
    display: input.display ?? meta.display,
    updatedAt: now,
    version,
    versions: [...meta.versions, { version, createdAt: now, bytes, ...(note ? { note } : {}) }],
  };
  writeAtomic(join(folder, "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  for (const old of next.versions.slice(0, -KEEP_VERSIONS)) {
    rmSync(join(folder, contentFile(meta.format, old.version)), { force: true });
  }
  return next;
}

/** The artifacts a viewer can see, newest first. */
export function listArtifacts(viewer: Viewer, options: StoreOptions = {}): ArtifactMeta[] {
  const dir = artifactsDir(options);
  if (!existsSync(dir)) return [];
  const out: ArtifactMeta[] = [];
  for (const id of readdirSync(dir)) {
    const meta = readMeta(id, options);
    if (meta && canSee(meta, viewer)) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The content of one version (the latest by default), or null when it is not there or not the viewer's. */
export function readArtifact(
  id: string,
  viewer: Viewer,
  version?: number,
  options: StoreOptions = {},
): { meta: ArtifactMeta; version: number; content: string } | null {
  const meta = readMeta(id, options);
  if (!meta || !canSee(meta, viewer)) return null;
  const v = version ?? meta.version;
  try {
    const content = readFileSync(join(artifactsDir(options), meta.id, contentFile(meta.format, v)), "utf8");
    return { meta, version: v, content };
  } catch {
    return null;
  }
}

/**
 * The card KYBER Studio and the phone draw for an artifact, in the shared card
 * envelope (the same shape `@kybernesis/cards` defines). The id is the
 * artifact's, so a card for version 3 replaces the card for version 2 in place.
 * `text` is what a surface that draws no cards shows instead.
 */
export interface ArtifactCard {
  kyb: 1;
  card: "artifact";
  id: string;
  title: string;
  source: "Artifact";
  data: {
    artifactId: string;
    version: number;
    display: ArtifactDisplay;
    format: ArtifactFormat;
    updatedAt: string;
  };
  actions: Array<{ label: string; artifact: string }>;
  text: string;
}

export function artifactCard(meta: ArtifactMeta): ArtifactCard {
  return {
    kyb: 1,
    card: "artifact",
    id: meta.id,
    title: meta.title,
    source: "Artifact",
    data: {
      artifactId: meta.id,
      version: meta.version,
      display: meta.display,
      format: meta.format,
      updatedAt: meta.updatedAt,
    },
    actions: [{ label: "Open", artifact: meta.id }],
    text: `${meta.title} (artifact, version ${meta.version}). Open it in KYBER Studio or the phone app, under this agent's Artifacts.`,
  };
}

/** One line per artifact, for the model. */
export function summary(meta: ArtifactMeta): string {
  return `${meta.id}  v${meta.version}  ${meta.format}  ${meta.updatedAt.slice(0, 16).replace("T", " ")}  ${meta.title}`;
}
