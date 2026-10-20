import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Give every `exeModel({ …, createOpenAI })` call in an agent the Anthropic
 * factory too.
 *
 * @remarks
 * Claude on the exe gateway is served on its Messages API, not the OpenAI one.
 * Older scaffolds wrote subagents such as the builder with only `createOpenAI`
 * and a Claude default (`anthropic/claude-sonnet-5`). That never had a working
 * route, and since exe 0.17 `exeModel` refuses it at load, so the agent's whole
 * eval suite stops before the first case and an update is rolled back for a
 * file nobody touched. Passing `createAnthropic` as well is harmless for a
 * non-Claude id (exeModel only uses it for `anthropic/…`), so the repair is
 * unconditional for any call that lacks it.
 *
 * Returns the agent-relative paths it changed.
 */
export function repairExeClaudeRoute(cwd: string): string[] {
  const root = join(cwd, "agent");
  if (!existsSync(root)) return [];
  const changed: string[] = [];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    const next = withAnthropicFactory(source);
    if (next === source) continue;
    writeFileSync(file, next);
    changed.push(relative(cwd, file));
  }
  return changed;
}

/** The source with `createAnthropic` passed to each exeModel call that has only `createOpenAI`, and imported. */
export function withAnthropicFactory(source: string): string {
  if (!/\bexeModel\s*\(/.test(source)) return source;
  let touched = false;
  const next = source.replace(/\bexeModel\s*\(\s*\{([^{}]*)\}\s*\)/g, (call, body: string) => {
    if (!/\bcreateOpenAI\b/.test(body) || /\bcreateAnthropic\b/.test(body)) return call;
    touched = true;
    return call.replace(/\bcreateOpenAI\b/, "createOpenAI, createAnthropic");
  });
  if (!touched) return source;
  if (/\bimport\s*\{[^}]*\bcreateAnthropic\b[^}]*\}\s*from\s*["']@ai-sdk\/anthropic["']/.test(next)) return next;
  const openaiImport = /^import\s*\{[^}]*\bcreateOpenAI\b[^}]*\}\s*from\s*["']@ai-sdk\/openai["'];?[^\n]*\n/m.exec(next);
  const line = 'import { createAnthropic } from "@ai-sdk/anthropic";\n';
  if (openaiImport) {
    const at = openaiImport.index + openaiImport[0].length;
    return next.slice(0, at) + line + next.slice(at);
  }
  return line + next;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}
