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
  stderr?: string;
}

export type DockerCommand = (
  command: string,
  args: readonly string[],
) => DockerCommandResult | Promise<DockerCommandResult>;

export interface DockerTemplateIssue {
  kind: "missing-marker" | "missing-image" | "docker-error";
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

function defaultDockerCommand(command: string, args: readonly string[]): DockerCommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stderr: [result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
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

function isMissingImage(stderr: string): boolean {
  return /no such (?:image|object)/i.test(stderr);
}

export async function inspectDockerTemplates(
  options: InspectDockerTemplatesOptions,
): Promise<DockerTemplateInspection> {
  const fs = options.fs ?? nodeFileSystem;
  const sandboxes = discoverDockerTemplateSandboxes(options.appDir, fs);
  if (sandboxes.length === 0) return { status: "skipped", sandboxes, images: [], issues: [] };

  const markerDir = join(options.appDir, DOCKER_TEMPLATE_MARKER_DIRECTORY);
  let markers: { path: string; mtimeMs: number }[] = [];
  try {
    markers = fs.readDir(markerDir)
      .filter((entry) => entry.isFile)
      .map((entry) => ({ path: join(markerDir, entry.name), mtimeMs: fs.mtimeMs(join(markerDir, entry.name)) }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .slice(0, sandboxes.length);
  } catch {
    markers = [];
  }

  const images = markers.map((marker) => markerReference(fs, marker.path));
  const issues: DockerTemplateIssue[] = [];
  for (const sandbox of sandboxes.slice(markers.length)) {
    issues.push({
      kind: "missing-marker",
      subject: sandbox,
      detail: `No current Docker template marker exists for ${sandbox}. ${REPAIR_GUIDANCE}`,
    });
  }

  const runDocker = options.runDocker ?? defaultDockerCommand;
  const dockerPath = options.dockerPath ?? process.env.EVE_DOCKER_PATH ?? "docker";
  for (const image of images) {
    let result: DockerCommandResult;
    try {
      result = await runDocker(dockerPath, ["image", "inspect", image]);
    } catch (error) {
      result = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) continue;
    const stderr = result.stderr?.trim() || "Docker returned an unknown error";
    issues.push({
      kind: isMissingImage(stderr) ? "missing-image" : "docker-error",
      subject: image,
      detail: isMissingImage(stderr)
        ? `Docker template image ${image} is missing. ${REPAIR_GUIDANCE}`
        : `Could not inspect Docker template image ${image}: ${stderr}. ${REPAIR_GUIDANCE}`,
    });
  }

  return issues.length === 0
    ? { status: "present", sandboxes, images, issues: [] }
    : { status: "failed", sandboxes, images, issues };
}
