import { defineTool } from "eve/tools";
import { z } from "zod";
import { readMeta, shareLink, viewerFromContext } from "../../src/index.js";

/**
 * A link to an artifact the person already has, for when a card cannot reach
 * them: iMessage and SMS show only text, and someone may want to open a page
 * in a browser or pass it on. Only the artifact's owner gets one, for a
 * version they choose (the latest by default), and they can withdraw it from
 * their artifacts in KYBER Studio.
 */
export default defineTool({
  description:
    "Get a web link to one of the person's artifacts that opens in any browser. Use it when they ask for a link, or on a text-only chat such as iMessage when you point them to an artifact you made earlier (create and update already give a link there for a new version). Anyone holding the link can open that version, so only make one when they ask to see or share the page. End your reply with the link exactly as written, on its own last line with nothing after it.",
  inputSchema: z.object({
    id: z.string().describe("The artifact's id, from create, update or list."),
    version: z.number().int().positive().optional().describe("A version number. Omit for the latest."),
  }),
  async execute({ id, version }, ctx) {
    const viewer = viewerFromContext(ctx);
    const meta = readMeta(id);
    if (!meta || !viewer.person || meta.owner !== viewer.person) {
      return `There is no artifact ${id} of this person's here to link to. Only the person an artifact belongs to can get a link to it.`;
    }
    const v = version ?? meta.version;
    if (v > meta.version || !meta.versions.some((x) => x.version === v)) return `Artifact ${id} has no version ${v}.`;
    const url = shareLink({ ...meta, version: v });
    if (!url) return "This agent does not know its public web address, so it cannot make a link. Point them to the artifact in KYBER Studio instead.";
    return { artifactId: meta.id, title: meta.title, version: v, url };
  },
});
