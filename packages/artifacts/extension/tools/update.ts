import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateArtifact, viewerFromContext } from "../../src/index.js";
import { contentFrom, forModel, requireDisk, result } from "../lib/shared.js";

/** A new version of an artifact, under the same id, so every card for it opens the latest. */
export default defineTool({
  description:
    "Change an artifact you made: saves a new version under the same id, and every card for it in the chat opens the new version. Give the WHOLE new page as `content` or `path`, not a diff. Use read first when you need the current page to edit it.",
  inputSchema: z.object({
    id: z.string().describe("The artifact's id, from create or list."),
    content: z.string().optional().describe("The whole new page."),
    path: z.string().optional().describe("Absolute sandbox path of a file holding the whole new page, instead of content."),
    title: z.string().optional().describe("A new title, only when the old one no longer fits."),
    display: z.enum(["inline", "document"]).optional().describe("Change how it shows in the chat."),
    note: z.string().optional().describe("What changed, in a few words, e.g. \"added October\"."),
  }),
  async execute({ id, content, path, title, display, note }, ctx) {
    requireDisk();
    const body = await contentFrom({ content, path }, ctx);
    return result(updateArtifact({ id, content: body, title, display, note }, viewerFromContext(ctx)));
  },
  toModelOutput: (output) => forModel(output, "Updated"),
});
