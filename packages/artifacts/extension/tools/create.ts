import { defineTool } from "eve/tools";
import { z } from "zod";
import { createArtifact, viewerFromContext } from "../../src/index.js";
import { contentFrom, forModel, requireDisk, result } from "../lib/shared.js";

/**
 * Make an artifact: a page for the person (a report, a dashboard, a tracker)
 * that KYBER Studio and the phone draw as a card in the conversation.
 *
 * The full output carries the card under `kyb` for the apps, which read it
 * from the `action.result` event; the model sees one line.
 */
export default defineTool({
  description:
    "Make an artifact: a page the person keeps and comes back to, such as a report, a dashboard, a tracker, a plan or an explainer. It shows as a card in the person's chat (KYBER Studio, the phone app, Buzz) with an Open button. Give either `content` (the whole page) or `path` (a file in your sandbox). HTML is one self-contained file: inline CSS and script, data written into the page, no external scripts, fonts, images or network calls (they are blocked). To change an artifact later, use update with its id instead of making a new one.",
  inputSchema: z.object({
    title: z.string().describe("A short name for the page, in the person's words, e.g. \"Website, last 7 days\"."),
    content: z.string().optional().describe("The whole page: one HTML document, or markdown when format is markdown."),
    path: z.string().optional().describe("Absolute sandbox path of a file holding the page, instead of content."),
    format: z.enum(["html", "markdown"]).optional().describe("html (default) for anything with layout, charts or controls; markdown for a plain document."),
    display: z
      .enum(["inline", "document"])
      .optional()
      .describe("inline for something small that reads in the chat, such as one chart or a short table; document (default) for a full page opened on its own."),
  }),
  async execute({ title, content, path, format, display }, ctx) {
    requireDisk();
    const body = await contentFrom({ content, path }, ctx);
    const meta = createArtifact({ title, content: body, format, display, owner: viewerFromContext(ctx).person });
    return result(meta);
  },
  toModelOutput: (output) => forModel(output, "Made"),
});

