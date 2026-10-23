import { defineTool } from "eve/tools";
import { z } from "zod";
import { readArtifact, viewerFromContext } from "../../src/index.js";

/** The page behind an artifact, so the agent can edit it rather than rewrite it from memory. */
export default defineTool({
  description:
    "Read an artifact's page (the latest version unless you name one), to change it with update or to answer questions about it.",
  inputSchema: z.object({
    id: z.string().describe("The artifact's id."),
    version: z.number().int().positive().optional().describe("An earlier version number. Omit for the latest."),
  }),
  async execute({ id, version }, ctx) {
    const found = readArtifact(id, viewerFromContext(ctx), version);
    if (!found) return `There is no artifact ${id}${version ? ` version ${version}` : ""} here for this person.`;
    return {
      artifactId: found.meta.id,
      title: found.meta.title,
      format: found.meta.format,
      version: found.version,
      latest: found.meta.version,
      content: found.content,
    };
  },
});
