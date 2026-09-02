import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeHasSandboxTools } from "./removed-default-tools.js";

export const SANDBOX_CLEANUP_HOOK_FILE = "sandbox-cleanup.ts";

export function terminalSandboxCleanupHookTs(): string {
  return `export { terminalSandboxCleanupHook as default } from "@kybernesis/exe/sandbox-cleanup";\n`;
}

export function sandboxCleanupScaffoldFiles(
  host: "vercel" | "exe",
  subagents: string[],
): Array<{ path: string; content: string }> {
  if (host !== "exe") return [];
  return ["agent", ...subagents.map((name) => join("agent/subagents", name))].map((scope) => ({
    path: join(scope, "hooks", SANDBOX_CLEANUP_HOOK_FILE),
    content: terminalSandboxCleanupHookTs(),
  }));
}

function findLocalSubagents(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (existsSync(join(child, "agent.ts"))) found.push(child);
    found.push(...findLocalSubagents(child));
  }
  return found;
}

/**
 * Add the dedicated managed hook where it is missing, without replacing an
 * authored file that happens to use the same path.
 *
 * Only scopes that can have a sandbox get it. `ctx.getSandbox()` PROVISIONS
 * a sandbox when the session has none (eve docs, "Delete a sandbox": the next
 * call provisions a fresh workspace), so a cleanup hook on a scope that has
 * disabled its sandbox tools would start a container at session end in order
 * to delete it — on Kyber, ten knowledge specialists doing that per closed
 * session.
 */
export function repairTerminalSandboxCleanupHooks(cwd: string): string[] {
  const agent = join(cwd, "agent");
  if (!existsSync(agent)) return [];

  const scopes = [agent, ...findLocalSubagents(join(agent, "subagents"))].filter(scopeHasSandboxTools);
  const added: string[] = [];
  for (const scope of scopes) {
    const hooks = join(scope, "hooks");
    const target = join(hooks, SANDBOX_CLEANUP_HOOK_FILE);
    if (existsSync(target)) continue;
    mkdirSync(hooks, { recursive: true });
    writeFileSync(target, terminalSandboxCleanupHookTs());
    added.push(target);
  }
  return added;
}
