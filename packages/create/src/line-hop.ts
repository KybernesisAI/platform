import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * What an agent built on eve 0.68 needs to run on eve 0.81, beyond new package
 * versions. Each step touches only what a Kybernesis scaffold or registry item
 * wrote, in the exact form it wrote it; anything authored by hand is reported
 * and left alone.
 */

/** Where `kyb init` pointed the @kybernesis registry before the registry served one copy per eve line. */
export const UNVERSIONED_REGISTRY_URL = "https://registry.kybernesis.ai/r/{name}.json";

/**
 * Third-party extensions, at the releases proven on the certified eve. The
 * registry items install their newest release, which is built on a later eve
 * and refused at discovery. Move them with the eve certification, never on
 * their own.
 */
export const THIRD_PARTY_PINS: Readonly<Record<string, string>> = { "@github-tools/eve-extension": "0.8.1" };

/** Third-party extensions with no release that mounts on the certified eve, and why. */
export const DROPPED_EXTENSIONS: Readonly<Record<string, string>> = {
  "@agent-browser/eve": "no release mounts on eve 0.81; the agent reads pages on its own computer (open_browser)",
};

/** eve 0.81.1 peers on ai ^7.0.137; an agent's own range for ai must allow it. */
export const AI_FLOOR = "7.0.137";

/** Exactly what `eve add extension/agent-browser` wrote. */
export const AGENT_BROWSER_MOUNT = `import browser from "@agent-browser/eve";\n\nexport default browser({});\n`;

export interface DependencyMove {
  name: string;
  from: string;
  /** null when the dependency is removed. */
  to: string | null;
  why: string;
}

export interface ManifestMigration {
  moves: DependencyMove[];
  registry: { from: string; to: string } | null;
}

function floorBelow(range: string, floor: string): boolean {
  const match = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return false;
  const want = floor.split(".").map(Number);
  const have = match.slice(1, 4).map(Number);
  if (have[0] !== want[0]) return false;
  for (let i = 0; i < 3; i += 1) if (have[i] !== want[i]) return have[i]! < want[i]!;
  return false;
}

/**
 * The manifest half: third-party pins, dropped extensions, the ai floor and
 * the registry namespace. Mutates `pkg` and says what moved; writing it is the
 * caller's, so a dry run can read the answer without touching disk.
 */
export function migrateManifest(pkg: Record<string, unknown>, registryUrl: string): ManifestMigration {
  const moves: DependencyMove[] = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (name in DROPPED_EXTENSIONS) {
        delete deps[name];
        moves.push({ name, from: range, to: null, why: DROPPED_EXTENSIONS[name]! });
      } else if (THIRD_PARTY_PINS[name] && range !== THIRD_PARTY_PINS[name]) {
        deps[name] = THIRD_PARTY_PINS[name]!;
        moves.push({ name, from: range, to: THIRD_PARTY_PINS[name]!, why: "the release proven on the certified eve" });
      } else if (name === "ai" && floorBelow(range, AI_FLOOR)) {
        deps[name] = `^${AI_FLOOR}`;
        moves.push({ name, from: range, to: `^${AI_FLOOR}`, why: "the certified eve needs it" });
      }
    }
  }
  const overrides = pkg.overrides as Record<string, unknown> | undefined;
  if (overrides && typeof overrides.ai === "string" && floorBelow(overrides.ai, AI_FLOOR)) overrides.ai = `^${AI_FLOOR}`;

  let registry: ManifestMigration["registry"] = null;
  const registries = pkg.registries as Record<string, unknown> | undefined;
  if (registries?.["@kybernesis"] === UNVERSIONED_REGISTRY_URL && registryUrl !== UNVERSIONED_REGISTRY_URL) {
    registries["@kybernesis"] = registryUrl;
    registry = { from: UNVERSIONED_REGISTRY_URL, to: registryUrl };
  }
  return { moves, registry };
}

/**
 * Registry-written workflow tools whose question must survive the person
 * sending another message. On 0.69+ an `execute` tool's open question is
 * withdrawn by one; a `task` keeps it open and hands the answer back later.
 */
const ASK_TOOLS: ReadonlyArray<{ path: string; helper: string; explain: (source: string) => string }> = [
  {
    path: "agent/tools/request_vault_item.ts",
    helper: "@kybernesis/vault/ask",
    explain: (source) =>
      source.replace(
        "// Parks durably; ",
        "// Runs as a task: the question stays open through any other message the person\n" +
          "// sends (an `execute` call's question is withdrawn by one), and the answer\n" +
          "// reaches the model later in the conversation. Parks durably; ",
      ),
  },
  {
    path: "agent/tools/approve_spend_request.ts",
    helper: "@kybernesis/payments",
    explain: (source) =>
      source.replace(
        "\nexport default defineWorkflowTool(",
        "\n// Runs as a task: the question stays open through any other message the person\n" +
          "// sends (an `execute` call's question is withdrawn by one, which would cancel\n" +
          "// the purchase), and the result reaches the model later in the conversation." +
          "\nexport default defineWorkflowTool(",
      ),
  },
];

const EXECUTE_WORKFLOW = /( {2})async execute\(input, ctx\) \{(\n\s*"use workflow";)/;

export interface SourceMigration {
  /** Files changed, relative to the agent. */
  updated: string[];
  /** Files removed, relative to the agent. */
  removed: string[];
  /** Files that need a hand, with what to do. */
  manual: Array<{ file: string; action: string }>;
}

function walk(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path, keep);
    return entry.isFile() && keep(entry.name) ? [path] : [];
  });
}

/**
 * The source half: the judge, the browser mount, the ask tools, and old tool
 * names in prose. With `write: false` it only says what it would do.
 */
export function migrateSources(cwd: string, { write = true }: { write?: boolean } = {}): SourceMigration {
  const result: SourceMigration = { updated: [], removed: [], manual: [] };
  const rel = (path: string) => relative(cwd, path);

  // eve 0.72 grades with a decision model; `.evaluationModel(` no longer compiles.
  for (const path of [join(cwd, "evals/evals.config.ts"), join(cwd, "evals.config.ts")]) {
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes(".evaluationModel(")) continue;
    if (write) writeFileSync(path, source.replaceAll(".evaluationModel(", ".decisionModel("));
    result.updated.push(rel(path));
  }

  // The browser extension: remove the scaffold's mount, flag any other.
  for (const path of walk(join(cwd, "agent"), (name) => /\.[cm]?[jt]s$/.test(name))) {
    const source = readFileSync(path, "utf8");
    if (!source.includes("@agent-browser/eve")) continue;
    if (source === AGENT_BROWSER_MOUNT) {
      if (write) rmSync(path);
      result.removed.push(rel(path));
    } else {
      result.manual.push({ file: rel(path), action: `remove it: @agent-browser/eve ${DROPPED_EXTENSIONS["@agent-browser/eve"]}` });
    }
  }

  for (const tool of ASK_TOOLS) {
    const path = join(cwd, tool.path);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes(tool.helper) || !EXECUTE_WORKFLOW.test(source)) continue;
    const swapped = source.replace(EXECUTE_WORKFLOW, "$1async task(input, ctx) {$2");
    if (write) writeFileSync(path, swapped.includes("Runs as a task:") ? swapped : tool.explain(swapped));
    result.updated.push(tool.path);
  }

  // Prose that names tools eve 0.81 no longer has: the model would look for them.
  for (const path of walk(join(cwd, "agent"), (name) => /\.(md|ts)$/.test(name))) {
    const source = readFileSync(path, "utf8");
    const names = ["connection_search", "load_skill"].filter((name) => new RegExp(`\\b${name}\\b`).test(source));
    if (names.length === 0) continue;
    result.manual.push({
      file: rel(path),
      action: `rewrite ${names.map((n) => `\`${n}\``).join(" and ")}: eve 0.81 finds tools with \`eve__search\`, calls them with \`eve__tool\`, and loads skills with \`eve__skill\``,
    });
  }
  return result;
}

/** The conversation store. The first boot on eve 0.81 deletes one written by an older line. */
export const WORKFLOW_STORE = ".eve/.workflow-data";

/** Where the store from line `fromLine` (e.g. "0.68") is kept across a hop. */
export function workflowStoreBackup(fromLine: string): string {
  return `${WORKFLOW_STORE}.eve-${fromLine}`;
}

/** Build caches from the old line that the new one must not reuse. */
export const STALE_EVE_CACHES = [".eve/sandbox-cache", ".eve/dev-runtime"];

/**
 * Copy the conversation store aside before anything on the new line boots
 * (the eval gate's dev server shares it with production). An existing backup
 * is never overwritten: it is the copy taken before the first attempt.
 */
export function backUpWorkflowStore(cwd: string, fromLine: string): "copied" | "kept" | "none" {
  const store = join(cwd, WORKFLOW_STORE);
  const backup = join(cwd, workflowStoreBackup(fromLine));
  if (existsSync(backup)) return "kept";
  if (!existsSync(store)) return "none";
  cpSync(store, backup, { recursive: true, preserveTimestamps: true });
  return "copied";
}

/** Put the backed-up store back, for an agent that is going back to its old line. */
export function restoreWorkflowStore(cwd: string, fromLine: string): boolean {
  const backup = join(cwd, workflowStoreBackup(fromLine));
  if (!existsSync(backup)) return false;
  const store = join(cwd, WORKFLOW_STORE);
  rmSync(store, { recursive: true, force: true });
  cpSync(backup, store, { recursive: true, preserveTimestamps: true });
  return true;
}

export function clearStaleEveCaches(cwd: string): string[] {
  return STALE_EVE_CACHES.filter((dir) => {
    const path = join(cwd, dir);
    if (!existsSync(path)) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  });
}

/** A new, non-rollback snapshot for an in-place upgrade. Never replace the live store with it. */
export function snapshotWorkflowStore(cwd: string): string | null {
  const store = join(cwd, WORKFLOW_STORE);
  if (!existsSync(store)) return null;
  // Stage beside the store, so the final rename publishes only a complete copy.
  const staging = mkdtempSync(join(cwd, ".eve", ".workflow-data.upgrade-staging-"));
  const backup = staging.replace(".upgrade-staging-", ".upgrade-");
  try {
    cpSync(store, staging, { recursive: true, preserveTimestamps: true });
    renameSync(staging, backup);
    return backup;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
