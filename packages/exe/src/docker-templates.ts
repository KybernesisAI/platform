import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export const DOCKER_TEMPLATE_MARKER_DIRECTORY = ".eve/sandbox-cache/docker/templates";
export const DOCKER_TEMPLATE_IMAGE_REPOSITORY = "eve-sandbox-template";

const SANDBOX_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;
const REPAIR_GUIDANCE = "Run `eve build`, then restart so sandbox prewarm runs before serving traffic.";

export interface DockerTemplateFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  readDir(path: string): readonly { name: string; isDirectory: boolean; isFile: boolean }[];
  mtimeMs(path: string): number;
}

export interface DockerCommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

export type DockerCommand = (
  command: string,
  args: readonly string[],
) => DockerCommandResult | Promise<DockerCommandResult>;

export interface DockerTemplateIssue {
  kind: "missing-marker" | "missing-image" | "incomplete-set" | "docker-error";
  subject: string;
  detail: string;
}

export type DockerTemplateInspection =
  | { status: "skipped"; sandboxes: readonly string[]; images: readonly string[]; issues: readonly [] }
  | { status: "present"; sandboxes: readonly string[]; images: readonly string[]; issues: readonly [] }
  | { status: "failed"; sandboxes: readonly string[]; images: readonly string[]; issues: readonly DockerTemplateIssue[] };

export interface InspectDockerTemplatesOptions {
  appDir: string;
  fs?: DockerTemplateFileSystem;
  runDocker?: DockerCommand;
  dockerPath?: string;
}

const nodeFileSystem: DockerTemplateFileSystem = {
  exists(path) {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path) => readFileSync(path, "utf8"),
  readDir: (path) => readdirSync(path, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  })),
  mtimeMs: (path) => statSync(path).mtimeMs,
};

/** Bounded: a wedged daemon must not hang `kyb doctor`, which runs unattended inside `kyb upgrade`. */
const DOCKER_TIMEOUT_MS = 15_000;

function defaultDockerCommand(command: string, args: readonly string[]): DockerCommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  const timedOut = result.error?.name === "Error" && /ETIMEDOUT/.test(String(result.error.message ?? result.error));
  return {
    ok: result.status === 0 && !timedOut,
    stdout: result.stdout ?? "",
    stderr: [result.stderr, timedOut ? `timed out after ${DOCKER_TIMEOUT_MS}ms` : result.error?.message]
      .filter(Boolean)
      .join("\n")
      .trim(),
  };
}

function stripComments(source: string): string {
  let output = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === "line") {
      if (char === "\n") {
        output += char;
        state = "code";
      } else output += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "code") {
      if (char === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line";
        continue;
      }
      if (char === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block";
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      output += char;
      continue;
    }
    output += char;
    if (char === "\\") {
      if (next !== undefined) {
        output += next;
        index += 1;
      }
    } else if (
      (state === "single" && char === "'") ||
      (state === "double" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usesDockerBackend(source: string): boolean {
  const code = stripComments(source);
  const calls: string[] = [];
  for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']eve\/sandbox\/docker["']/g)) {
    for (const specifier of match[1]!.split(",")) {
      const imported = /^\s*docker(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (imported) calls.push(imported[1] ?? "docker");
    }
  }
  for (const match of code.matchAll(/import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["']eve\/sandbox\/docker["']/g)) {
    calls.push(`${match[1]}.docker`);
  }
  if (calls.length === 0) return false;

  const callPattern = calls.map(escapeRegExp).join("|");
  if (new RegExp(`\\bbackend\\s*:\\s*(?:${callPattern})\\s*\\(`).test(code)) return true;

  const dockerVariables = new Set<string>();
  for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${callPattern})\\s*\\(`, "g"))) {
    dockerVariables.add(match[1]!);
  }
  for (const variable of dockerVariables) {
    const escaped = escapeRegExp(variable);
    if (new RegExp(`\\bbackend\\s*:\\s*${escaped}\\b`).test(code)) return true;
    if (new RegExp(`[{,]\\s*backend\\s*[,}]`).test(code) && variable === "backend") return true;
  }
  return false;
}

function hasWorkspaceResources(fs: DockerTemplateFileSystem, sandboxFile: string): boolean {
  const sandboxDir = dirname(sandboxFile);
  if (basename(sandboxDir) !== "sandbox") return false;
  const workspace = join(sandboxDir, "workspace");
  try {
    return fs.readDir(workspace).length > 0;
  } catch {
    return false;
  }
}

function requiresTemplate(fs: DockerTemplateFileSystem, sandboxFile: string, source: string): boolean {
  return /\b(?:async\s+)?bootstrap\s*(?:\(|:)/.test(stripComments(source)) || hasWorkspaceResources(fs, sandboxFile);
}

function sandboxFiles(fs: DockerTemplateFileSystem, agentDir: string): string[] {
  const files: string[] = [];
  for (const extension of SANDBOX_EXTENSIONS) {
    for (const path of [
      join(agentDir, `sandbox.${extension}`),
      join(agentDir, "sandbox", `sandbox.${extension}`),
    ]) {
      if (fs.exists(path)) files.push(path);
    }
  }
  return files;
}

export function discoverDockerTemplateSandboxes(
  appDir: string,
  fs: DockerTemplateFileSystem = nodeFileSystem,
): string[] {
  const appAgentDir = join(appDir, "agent");
  const discovered: string[] = [];

  const visitAgent = (agentDir: string): void => {
    for (const sandboxFile of sandboxFiles(fs, agentDir)) {
      let source: string;
      try {
        source = fs.readFile(sandboxFile);
      } catch {
        continue;
      }
      if (usesDockerBackend(source) && requiresTemplate(fs, sandboxFile, source)) {
        discovered.push(relative(appDir, sandboxFile));
      }
    }

    const subagentsDir = join(agentDir, "subagents");
    let entries: readonly { name: string; isDirectory: boolean }[];
    try {
      entries = fs.readDir(subagentsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) visitAgent(join(subagentsDir, entry.name));
    }
  };

  if (fs.exists(appAgentDir)) visitAgent(appAgentDir);
  return discovered.sort();
}

function markerReference(fs: DockerTemplateFileSystem, markerPath: string): string {
  try {
    const content = fs.readFile(markerPath).trim();
    if (content) return content;
  } catch {
    // Eve's marker basename is also the image tag, so unreadable content has a safe fallback.
  }
  return `${DOCKER_TEMPLATE_IMAGE_REPOSITORY}:${basename(markerPath)}`;
}

/** The three hashes eve encodes in a template tag: checkout, sandbox config, runtime. */
export interface TemplateTagIdentity {
  app: string;
  config: string;
  runtime: string;
}

/**
 * `eve-sbx-tpl-docker-<app dir hash>-<sandbox config hash>-<runtime hash>`.
 *
 * The middle hash is the identity that matters here: one per sandbox
 * configuration, stable across rebuilds of the same config, different for
 * every scope. It is what lets a marker be matched to an image by WHAT it is
 * rather than by where it sorts.
 */
export function parseTemplateTag(tag: string): TemplateTagIdentity | null {
  const match = /^eve-sbx-tpl-docker-([0-9a-f]+)-([0-9a-f]+)-([0-9a-f]+)$/.exec(tag);
  return match ? { app: match[1]!, config: match[2]!, runtime: match[3]! } : null;
}

/** One marker file, as eve left it, plus what its name says about it. */
export interface TemplateMarker {
  tag: string;
  image: string;
  mtimeMs: number;
  identity: TemplateTagIdentity | null;
}

/**
 * eve prewarms every template of a checkout together, so the current set
 * shares a build time — twelve of Kyber's thirteen were committed in the same
 * second, and the browser template lagged by minutes. An hour is wide enough
 * for the largest template and narrow enough that yesterday's set is not in
 * it. The same window the reclaim job uses.
 */
export const TEMPLATE_BATCH_WINDOW_MS = 60 * 60 * 1000;

/**
 * The markers that describe the templates this checkout will use next.
 *
 * Markers accumulate — eve never removes one (forty on Kyber for thirteen
 * sandboxes) — so "the newest N" says nothing about which sandbox any of
 * them belongs to, and a partial rebuild puts two markers for the same scope
 * at the top. Instead: take the newest prewarm batch, and within it keep one
 * marker per sandbox-config hash (the newest). That is exactly the set eve
 * will look for on its next turn, and a marker outside it is history.
 */
export function currentTemplateMarkers(markers: readonly TemplateMarker[]): TemplateMarker[] {
  if (markers.length === 0) return [];
  const newest = Math.max(...markers.map((marker) => marker.mtimeMs));
  const batch = markers.filter((marker) => newest - marker.mtimeMs <= TEMPLATE_BATCH_WINDOW_MS);
  const byIdentity = new Map<string, TemplateMarker>();
  for (const marker of batch) {
    const key = marker.identity ? `${marker.identity.app}:${marker.identity.config}` : `tag:${marker.tag}`;
    const held = byIdentity.get(key);
    if (!held || marker.mtimeMs > held.mtimeMs) byIdentity.set(key, marker);
  }
  return [...byIdentity.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

export function readTemplateMarkers(appDir: string, fs: DockerTemplateFileSystem = nodeFileSystem): TemplateMarker[] {
  const markerDir = join(appDir, DOCKER_TEMPLATE_MARKER_DIRECTORY);
  let entries: readonly { name: string; isFile: boolean }[];
  try {
    entries = fs.readDir(markerDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile)
    .map((entry) => {
      const path = join(markerDir, entry.name);
      return {
        tag: entry.name,
        image: markerReference(fs, path),
        mtimeMs: fs.mtimeMs(path),
        identity: parseTemplateTag(entry.name),
      };
    });
}

/** Every `eve-sandbox-template` image the daemon holds, as `repository:tag`. One call, bounded. */
async function listTemplateImages(
  runDocker: DockerCommand,
  dockerPath: string,
): Promise<{ images: Set<string> } | { error: string }> {
  let result: DockerCommandResult;
  try {
    result = await runDocker(dockerPath, [
      "images",
      "--filter",
      `reference=${DOCKER_TEMPLATE_IMAGE_REPOSITORY}`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
  } catch (error) {
    result = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return { error: result.stderr?.trim() || "Docker returned an unknown error" };
  const images = new Set(
    (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return { images };
}

export async function inspectDockerTemplates(
  options: InspectDockerTemplatesOptions,
): Promise<DockerTemplateInspection> {
  const fs = options.fs ?? nodeFileSystem;
  const sandboxes = discoverDockerTemplateSandboxes(options.appDir, fs);
  if (sandboxes.length === 0) return { status: "skipped", sandboxes, images: [], issues: [] };

  const current = currentTemplateMarkers(readTemplateMarkers(options.appDir, fs));
  const images = current.map((marker) => marker.image);
  const issues: DockerTemplateIssue[] = [];

  if (current.length === 0) {
    issues.push({
      kind: "missing-marker",
      subject: DOCKER_TEMPLATE_MARKER_DIRECTORY,
      detail:
        `No Docker template has been built for this checkout (${sandboxes.length} sandbox(es) configured). ` +
        REPAIR_GUIDANCE,
    });
    return { status: "failed", sandboxes, images, issues };
  }

  if (current.length < sandboxes.length) {
    // The newest prewarm did not cover every sandbox. Either it was a partial
    // rebuild (a single scope on first use) or a scope has never been built;
    // both mean the next turn on the uncovered scope builds a template first.
    //
    // `sandboxes` is a floor, not the exact count: a subagent that inherits
    // the root sandbox has no sandbox file of its own yet still gets its own
    // template (Kyber: one sandbox file, thirteen templates). More current
    // markers than discovered sandboxes is therefore normal; fewer is not.
    issues.push({
      kind: "incomplete-set",
      subject: `${current.length} of ${sandboxes.length} sandboxes`,
      detail:
        `The newest template build covered ${current.length} of ${sandboxes.length} configured sandbox(es); ` +
        `the rest build on first use. ${REPAIR_GUIDANCE}`,
    });
  }

  const runDocker = options.runDocker ?? defaultDockerCommand;
  const dockerPath = options.dockerPath ?? process.env.EVE_DOCKER_PATH ?? "docker";
  const listed = await listTemplateImages(runDocker, dockerPath);
  if ("error" in listed) {
    issues.push({
      kind: "docker-error",
      subject: dockerPath,
      detail: `Could not list Docker template images: ${listed.error}. ${REPAIR_GUIDANCE}`,
    });
    return { status: "failed", sandboxes, images, issues };
  }

  for (const marker of current) {
    if (listed.images.has(marker.image)) continue;
    issues.push({
      kind: "missing-image",
      subject: marker.image,
      detail: `Docker template image ${marker.image} is missing (its marker is current). ${REPAIR_GUIDANCE}`,
    });
  }

  return issues.length === 0
    ? { status: "present", sandboxes, images, issues: [] }
    : { status: "failed", sandboxes, images, issues };
}
