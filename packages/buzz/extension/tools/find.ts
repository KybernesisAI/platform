import { existsSync, readFileSync } from "node:fs";
import { getPublicKey } from "nostr-tools/pure";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { queryRelay } from "../../src/query.js";

/**
 * What exists in this workspace — everyone's, not only mine.
 *
 * @remarks
 * The CLI's list commands answer "mine": `--owner` defaults to the current
 * identity. Asked "what projects exist in this relay?" in a workspace holding
 * three, an agent using them answered "none" — it had listed its own, had none,
 * and had no way to know the question meant something else.
 *
 * This asks the relay directly, which is what the CLI does underneath, without
 * the owner filter. Kinds, rather than friendly names, because the platform
 * addresses its own objects that way and a translation table here would go
 * stale the first time one is added.
 */

/** The kinds worth naming, so the model does not have to memorise numbers. */
const KINDS: Record<string, number> = {
  project: 30621,
  repo: 30617,
  issue: 1621,
  patch: 1617,
  message: 9,
  note: 30023,
  profile: 0,
};

export default defineTool({
  description:
    "Find what exists in the Buzz workspace, across everyone — projects, repos, issues, patches, notes, profiles. Use this for questions like \"what projects exist here?\", which the buzz CLI's list commands CANNOT answer: those are scoped to this agent's own items and will report none when the workspace is full of other people's. Give a `type` (project, repo, issue, patch, note, message, profile) or raw `kinds`.",
  inputSchema: z.object({
    type: z
      .enum(["project", "repo", "issue", "patch", "note", "message", "profile"])
      .optional()
      .describe("What to look for. Omit only if passing raw kinds."),
    kinds: z.array(z.number()).optional().describe("Raw Nostr kind numbers, for anything not named above."),
    authors: z
      .array(z.string())
      .optional()
      .describe("Restrict to these author pubkeys (64-char hex). Omit for everyone in the workspace."),
    limit: z.number().optional().describe("How many at most. Defaults to 50."),
    community: z
      .string()
      .optional()
      .describe("Which workspace, when this agent belongs to more than one. Any distinctive part of its address."),
  }),
  async execute({ type, kinds, authors, limit, community }) {
    const keyFile = process.env.BUZZ_KEYFILE ?? ".buzz-key.json";
    if (!existsSync(keyFile)) {
      return `No Buzz identity at ${keyFile}: this agent has no standing in the workspace yet.`;
    }
    const configured = (process.env.BUZZ_RELAY_HTTP ?? process.env.BUZZ_RELAY ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^ws/, "http"))
      .filter(Boolean);
    if (configured.length === 0) return "No Buzz relay configured (BUZZ_RELAY).";

    let relay: string;
    if (community) {
      const matches = configured.filter((entry) => entry.includes(community));
      if (matches.length !== 1) {
        return `"${community}" does not pick out exactly one of: ${configured.join(", ")}`;
      }
      relay = matches[0]!;
    } else if (configured.length > 1) {
      // Same rule as acting: never guess which company's workspace was meant.
      return `This agent belongs to more than one workspace — say which: ${configured.join(", ")}`;
    } else {
      relay = configured[0]!;
    }

    /**
     * An empty array is not a filter, it is the absence of one.
     *
     * Models fill optional array parameters with `[]` all the time. `??` does
     * not treat that as missing and neither does truthiness, so `kinds: []`
     * became a filter matching no kind and `authors: []` a filter matching no
     * author — and the relay dutifully returned nothing. The tool then said
     * "nothing of that kind here" about a workspace full of them, which is
     * worse than an error: it is a confident wrong answer that reads as fact,
     * and it sent an agent to tell someone their projects did not exist.
     */
    const asked = kinds?.length ? kinds : undefined;
    const wanted = asked ?? (type ? [KINDS[type]!] : undefined);
    const by = authors?.length ? authors : undefined;
    if (!wanted) return "Say what to look for: a `type`, or raw `kinds`.";

    const stored = JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: number[] };
    const asWhom = getPublicKey(Uint8Array.from(stored.secretKey));
    try {
      const filter = { kinds: wanted, ...(by ? { authors: by } : {}), limit: limit ?? 50 };
      const { events, status, bytes } = await queryRelay(relay, Uint8Array.from(stored.secretKey), [filter]);
      if (events.length === 0) {
        // Names the workspace it actually searched. "Nothing here" is a claim
        // about a specific place, and an agent in several communities can look
        // in the wrong one and report the right answer to the wrong question.
        // The filter is named, because "nothing here" is a claim that has been
        // wrong before — sent with an empty kinds list, it matched nothing and
        // read as an empty workspace.
        return `Nothing in ${relay} matching ${JSON.stringify(filter)} (searched as ${asWhom.slice(0, 8)}…, relay answered ${status}).`;
      }
      // Summarised, not dumped: a raw event carries a signature and a pubkey per
      // item, and fifty of those is a context window spent on noise.
      return JSON.stringify(
        events.map((event) => ({
          id: event.id,
          author: event.pubkey,
          created: new Date(event.created_at * 1000).toISOString(),
          name: event.tags.find((tag) => tag[0] === "name")?.[1],
          slug: event.tags.find((tag) => tag[0] === "d")?.[1],
          subject: event.tags.find((tag) => tag[0] === "subject")?.[1],
          content: event.content?.slice(0, 400),
        })),
        null,
        1,
      );
    } catch (error) {
      return `Could not read the workspace: ${(error as Error).message}`;
    }
  },
});
