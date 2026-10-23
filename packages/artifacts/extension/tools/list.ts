import { defineTool } from "eve/tools";
import { z } from "zod";
import { listArtifacts, summary, viewerFromContext } from "../../src/index.js";

/** The artifacts this person can see, newest first. */
export default defineTool({
  description:
    "List the artifacts you have made for this person, newest first: id, version, format, last change and title. Use it to find an artifact to change or reopen before making a new one.",
  inputSchema: z.object({
    limit: z.number().int().positive().max(200).optional().describe("How many at most. Defaults to 30."),
  }),
  async execute({ limit }, ctx) {
    const all = listArtifacts(viewerFromContext(ctx));
    const shown = all.slice(0, limit ?? 30);
    if (shown.length === 0) return "No artifacts yet for this person.";
    const more = all.length > shown.length ? `\n(${all.length - shown.length} older not shown)` : "";
    return `${shown.map(summary).join("\n")}${more}`;
  },
});
