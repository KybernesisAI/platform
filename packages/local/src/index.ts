import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Local execution: let a deployed agent work on the user's own machine.
 *
 * The agent runs in the cloud and the files are on a laptop, so nothing here
 * connects to anything. KYBER Studio holds an outbound poll to the control
 * plane, and these tools drop work into that queue and wait for the answer.
 * If Studio is closed, the tools say so plainly — the model should tell the
 * user their desktop is offline, not invent a reason the file is missing.
 *
 * Permission lives on the DESKTOP, not here. Every action names its effect
 * (run-command, read-file, write-file, list-directory) and Studio asks the user
 * per effect. An agent cannot bypass that by choosing a different tool, because
 * two tools that read a file out both declare `read-file`.
 *
 * Mount the tools individually under `agent/tools/`:
 *
 * ```ts title="agent/tools/local_shell.ts"
 * import { localShellTool } from "@kybernesis/local";
 * export default localShellTool();
 * ```
 */

export interface LocalToolsOptions {
  /** Control-plane base URL. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /**
   * Shared secret the relay checks. Defaults to LOCAL_EXEC_AGENT_SECRET.
   *
   * TEMPORARY, and deliberately loud about it: local execution is not yet a
   * governed capability, so any holder of this secret can reach a connected
   * desktop in the org. It must become a revocable grant on the agent edge —
   * "may talk to this agent" and "may run commands on my laptop" are different
   * decisions and should not share one switch.
   */
  secret?: string;
  /** This agent's name; the relay resolves the org from its registration. */
  agent?: string;
}

interface CallResult {
  ok?: boolean;
  result?: unknown;
  error?: string;
  denied?: boolean;
  disconnected?: boolean;
  device?: string | null;
}

async function call(
  options: LocalToolsOptions,
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const issuer = (
    options.issuer ??
    process.env.KYBERNESIS_ISSUER ??
    "https://agent.kybernesis.ai"
  ).replace(/\/$/, "");
  const secret = options.secret ?? process.env.LOCAL_EXEC_AGENT_SECRET;
  const agent = options.agent ?? process.env.KYBERNESIS_AGENT ?? "unknown";

  if (!secret) {
    throw new Error(
      "Local execution is not configured on this agent (LOCAL_EXEC_AGENT_SECRET is unset).",
    );
  }

  const res = await fetch(`${issuer}/api/local-exec/call`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ agent, action, payload }),
    // Slightly longer than the relay's own wait, so a relay timeout surfaces as
    // its own explanatory message rather than as a fetch abort.
    signal: AbortSignal.timeout(190_000),
  });

  if (res.status === 401) {
    throw new Error("The local-execution relay rejected this agent's credentials.");
  }
  if (!res.ok) {
    throw new Error(`The local-execution relay refused this request (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as CallResult;

  // Disconnected, declined, and failed are three different answers, and the
  // model should tell the user which one happened rather than flattening them.
  if (body.disconnected) throw new Error(body.error ?? "Your computer is not connected.");
  if (body.denied) throw new Error(body.error ?? "The user declined this action.");
  if (!body.ok) throw new Error(body.error ?? "The action failed on your computer.");
  return body.result;
}

export function localShellTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Run a shell command on the USER'S OWN COMPUTER (not a sandbox), in their real files. Use when the user asks you to look at, build, or change something on their machine — a repo path like /Users/name/project, a local dev server, git in their working copy. Prefer local_read and local_list for inspection; use this when something must actually run.",
    inputSchema: z.object({
      command: z.string().describe("The command line to run, e.g. `git status`"),
      cwd: z.string().optional().describe("Absolute working directory on their machine"),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    }),
    execute: (input) => call(options, "run-command", input),
  });
}

export function localReadTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Read a file from the user's own computer. Absolute paths only. Prefer this over a shell `cat`: same effect, clearer permission prompt, cleaner result.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path on their machine"),
      maxBytes: z.number().int().min(1).max(2_000_000).optional(),
    }),
    execute: (input) => call(options, "read-file", input),
  });
}

export function localListTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "List a directory on the user's own computer. Absolute paths only. Use it to orient yourself in their project before reading or running anything.",
    inputSchema: z.object({
      path: z.string().describe("Absolute directory path on their machine"),
      depth: z.number().int().min(1).max(3).optional().describe("How deep to walk (default 1)"),
    }),
    execute: (input) => call(options, "list-directory", input),
  });
}

export function localWriteTool(options: LocalToolsOptions = {}) {
  return defineTool({
    description:
      "Write a file on the user's own computer, creating parent directories as needed. This changes their real files — say what you are about to write before calling it.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path on their machine"),
      content: z.string(),
    }),
    execute: (input) => call(options, "write-file", input),
  });
}

/** Guidance to paste into the agent's own instructions. */
export const LOCAL_INSTRUCTIONS = `
## Working on the user's own computer

You have tools that act on the user's real machine through KYBER Studio:
local_shell, local_read, local_list, local_write. Absolute paths only.

Studio asks the user to approve each KIND of action the first time — running a
command, reading a file, writing a file, listing a directory. A refusal is an
answer: say they declined and stop, do not look for another route to the same
effect.

If a tool reports that the computer is not connected, tell the user plainly that
KYBER Studio needs to be open. Do not conclude their files or repo are missing,
and do not retry in a loop.

Before writing or running anything that changes their files, say what you are
about to do in one line. Reading and listing need no preamble.
`.trim();
