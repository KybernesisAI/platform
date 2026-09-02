import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * eve 0.39 removed `glob` and `grep` from the default tool set (changelog
 * 4c1bd80). Two things follow for an agent written against 0.38:
 *
 * - A `tools/glob.ts` or `tools/grep.ts` that exports `disableTool()` now
 *   disables a slot nothing provides. On 0.38 that compiled with a warning;
 *   from 0.39 it is a compile error — the whole agent fails to build, and
 *   `eve eval` exits 1 with that one line as the only output. Kyber's ten
 *   knowledge specialists each carried both files.
 * - A scope that HAD the two tools by default (the root, the builder) loses
 *   them silently. The certified agent's behaviour is preserved by opting
 *   those scopes back in explicitly, which eve supports with a one-line file.
 *
 * Both happen in one pass over every agent scope, and only in the direction
 * that preserves what the agent already did.
 */

export const REMOVED_DEFAULT_TOOLS = ["glob", "grep"] as const;

function optInSource(tool: (typeof REMOVED_DEFAULT_TOOLS)[number]): string {
  return (
    `// eve 0.39 removed ${tool} from the default tool set. This scope had it on the\n` +
    `// certified 0.38 stack, so it is opted back in explicitly (kyb upgrade wrote this).\n` +
    `export { default } from "eve/tools/${tool}";\n`
  );
}

function isDisableToolFile(path: string): boolean {
  try {
    return /disableTool\s*\(/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function agentScopes(cwd: string): string[] {
  const root = join(cwd, "agent");
  if (!existsSync(root)) return [];
  const scopes: string[] = [];
  const visit = (dir: string): void => {
    if (existsSync(join(dir, "agent.ts"))) scopes.push(dir);
    const subagents = join(dir, "subagents");
    if (!existsSync(subagents)) return;
    for (const entry of readdirSync(subagents, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(subagents, entry.name));
    }
  };
  visit(root);
  return scopes;
}

/**
 * A scope that disables `bash` has opted out of the sandbox altogether (the
 * five sandbox tools proxy into one container; disabling bash is how a
 * knowledge specialist stays container-free). Such a scope never had a
 * reason to keep glob or grep either.
 */
export function scopeHasSandboxTools(scope: string): boolean {
  const bash = join(scope, "tools", "bash.ts");
  return !(existsSync(bash) && isDisableToolFile(bash));
}

export interface RemovedDefaultToolsRepair {
  removed: string[];
  optedIn: string[];
}

export function repairRemovedDefaultTools(cwd: string): RemovedDefaultToolsRepair {
  const removed: string[] = [];
  const optedIn: string[] = [];
  for (const scope of agentScopes(cwd)) {
    const tools = join(scope, "tools");
    for (const tool of REMOVED_DEFAULT_TOOLS) {
      const file = join(tools, `${tool}.ts`);
      if (existsSync(file)) {
        if (isDisableToolFile(file)) {
          unlinkSync(file);
          removed.push(relative(cwd, file));
        }
        // Anything else authored there (an opt-in, a custom tool) is the
        // agent's own and stays.
        continue;
      }
      if (!scopeHasSandboxTools(scope)) continue;
      mkdirSync(tools, { recursive: true });
      writeFileSync(file, optInSource(tool));
      optedIn.push(relative(cwd, file));
    }
  }
  return { removed, optedIn };
}
