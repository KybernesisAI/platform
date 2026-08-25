import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { defineTool } from "eve/tools";
import { z } from "zod";

const run = promisify(execFile);

/**
 * Everything in the workspace that is not talking.
 *
 * @remarks
 * Buzz's own model is that an agent acts through this CLI — the harness prompts
 * the agent, "and the agent replies using the Buzz CLI". We replaced the
 * harness to get governed per-person identity on messages, and for a while
 * shipped only that: an agent that could hold a conversation in a workspace and
 * do nothing in it. Asked about Projects it would say they did not exist, which
 * was true of its own tools and false of the workspace.
 *
 * ## Why a CLI rather than a client of our own
 *
 * The surface is twenty-two groups wide and belongs to someone else's roadmap.
 * Reimplementing it in TypeScript means being permanently a version behind on
 * every one of them, and being wrong in ways that look like the workspace
 * misbehaving. Shelling out to the tool the platform ships means a new
 * capability arrives with an upgrade rather than a port.
 *
 * ## Arguments are a LIST, never a string
 *
 * The arguments come from a model, and the model is reading text written by
 * whoever is in the channel. `execFile` with an argv array has no shell to
 * interpret, so a message containing `; rm -rf ~` is an argument with a
 * semicolon in it and nothing more. There is no code path here that builds a
 * command line, and there should never be one.
 *
 * ## Permissions are the relay's, not ours
 *
 * The agent is a workspace member with its own standing, so the relay is the
 * authority on what it may do — it answers `relay_membership_required` and the
 * like. A second permission model here would be a second thing to get wrong,
 * and would drift from the first.
 */

/** Where the agent's own identity lives, written by `kybernesis-buzz init`. */
function secretKeyHex(keyFile: string): string {
  const stored = JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: number[] };
  // Stored as bytes, wanted as 64-char hex. A silent mismatch here reads as
  // "invalid secret key" from the CLI, which sounds like a corrupt key file
  // rather than an encoding difference.
  return Buffer.from(Uint8Array.from(stored.secretKey)).toString("hex");
}

export default defineTool({
  description:
    "Act in the Buzz workspace: projects, issues, pull requests, patches, repos, long-form notes, channel canvases, workflows, the activity feed, media, emoji, moderation. Pass the command as a list of arguments, e.g. [\"projects\",\"list\"] or [\"issues\",\"create\",\"--repo\",\"acme/api\",\"--title\",\"Login fails on Safari\"]. Use [\"help\"] or [\"<group>\",\"--help\"] to see what a group takes instead of guessing at flags. Actions are signed as THIS AGENT and appear under its name. Do NOT use it to answer the message you are currently answering — returning your reply for the turn does that, threaded and marked; sending as well posts the same answer twice. Use messages/dms only for a DIFFERENT channel, an unprompted message, or a later follow-up.",
  inputSchema: z.object({
    args: z
      .array(z.string())
      .min(1)
      .describe(
        'The command as separate arguments, without the leading "buzz". Example: ["projects","get","--slug","atlas"].',
      ),
    community: z
      .string()
      .optional()
      .describe(
        "Which workspace to act in, when this agent belongs to more than one. Any distinctive part of its address is enough. Omit it when there is only one.",
      ),
  }),
  async execute({ args, community }) {
    // Where `kybernesis-buzz install-cli` puts it, then PATH. Preferring the
    // local copy means an agent is not at the mercy of what happens to be
    // installed globally on the box it was moved to.
    const local = ".buzz/bin/buzz";
    const binary = process.env.BUZZ_CLI_PATH ?? (existsSync(local) ? resolve(local) : "buzz");
    const keyFile = process.env.BUZZ_KEYFILE ?? ".buzz-key.json";

    /**
     * One workspace per command, chosen deliberately.
     *
     * An agent can belong to several communities — the bridge takes a list —
     * but the CLI addresses one relay. Handing it the list produced
     * `invalid dns name`, which says nothing about the actual problem. Picking
     * the first silently would be worse than the error: a project created in
     * the wrong company's workspace is not a mistake you can take back.
     */
    const configured = (process.env.BUZZ_RELAY_HTTP ?? process.env.BUZZ_RELAY ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^ws/, "http"))
      .filter(Boolean);

    if (configured.length === 0) {
      return "No Buzz relay configured: set BUZZ_RELAY (the bridge's websocket URL) or BUZZ_RELAY_HTTP.";
    }

    let relay: string;
    if (community) {
      const matches = configured.filter((entry) => entry.includes(community));
      if (matches.length !== 1) {
        return (
          `"${community}" ${matches.length === 0 ? "matches none of" : "matches more than one of"} ` +
          `this agent's workspaces: ${configured.join(", ")}`
        );
      }
      relay = matches[0]!;
    } else if (configured.length > 1) {
      return (
        `This agent belongs to more than one workspace, so say which one to act in: ` +
        `${configured.join(", ")}. Pass it as "community".`
      );
    } else {
      relay = configured[0]!;
    }
    if (!existsSync(keyFile)) {
      return `No Buzz identity at ${keyFile}. This agent has no standing in the workspace until \`kybernesis-buzz init\` has run on this host.`;
    }

    try {
      const { stdout } = await run(binary, args, {
        env: {
          // BUZZ_AUTH_TAG rides along in process.env when the workspace issues
          // one: the CLI reads it itself and sends it as x-auth-tag. Owner-
          // reviewed agent drafts are refused without it, in terms that mention
          // neither the tag nor the header.
          ...process.env,
          BUZZ_RELAY_URL: relay,
          BUZZ_PRIVATE_KEY: secretKeyHex(keyFile),
        },
        // Generous, because uploads and wide listings are legitimately slow —
        // but bounded, because a hung child would hold the whole turn open.
        timeout: 120_000,
        // A listing of a large workspace can be big; a runaway must not become
        // the entire context window.
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim() || "(no output)";
    } catch (error) {
      const failure = error as { code?: string; stderr?: string; message?: string };
      if (failure.code === "ENOENT") {
        return (
          `The Buzz CLI is not installed on this host (looked for "${binary}"). ` +
          `Install it with \`kybernesis-buzz install-cli\`, or set BUZZ_CLI_PATH to where it lives.`
        );
      }
      // The CLI already fails as structured JSON on stderr — pass it through
      // rather than wrapping it in prose. "relay_membership_required" is an
      // answer about permissions; rephrasing it loses that.
      const detail = (failure.stderr ?? failure.message ?? "").trim();
      return detail || "The Buzz CLI failed without saying why.";
    }
  },
});
