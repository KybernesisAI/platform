import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Publish a built page so the user can actually LOOK at it.
 *
 * Why this exists rather than using `deliver`: Vercel Blob refuses to serve
 * HTML inline (it forces a download, an XSS defence for its own domain), so a
 * delivered .html is a file you must download rather than a page you can open.
 *
 * This instead copies the artifact out of the sandbox onto the host VM and
 * serves it over exe.dev's port proxy, which forwards ports 3000–9999 to
 * `https://<vm>.exe.xyz:<port>/`. That URL is reachable by anyone signed in to
 * the exe.dev account (the VM's single *public* port stays reserved for the
 * agent itself), so it is a real, clickable preview — not an attachment.
 */
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? "/home/exedev/preview";
const PREVIEW_PORT = process.env.PREVIEW_PORT ?? "3456";
const PREVIEW_BASE =
  process.env.PREVIEW_BASE_URL ?? `https://${process.env.EXE_VM_NAME ?? "sid-agent"}.exe.xyz:${PREVIEW_PORT}`;

export const previewTool = defineTool({
  description:
    "Publish a file from the sandbox as a VIEWABLE web page and return its URL. Use this whenever the user wants to SEE something you built (a page, a report, a chart) rather than download it. For non-viewable artifacts they want to keep, use deliver instead.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Absolute sandbox path of the file to publish, e.g. /workspace/index.html"),
    name: z
      .string()
      .optional()
      .describe("Public filename; defaults to the file's basename. Use index.html for the site root."),
  }),
  async execute({ path, name }, ctx) {
    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (!bytes) throw new Error(`No file found at ${path} — write it in the sandbox first.`);

    const safe = (name ?? basename(path)).replace(/[^\w.\-]/g, "_");
    mkdirSync(PREVIEW_DIR, { recursive: true });
    writeFileSync(join(PREVIEW_DIR, safe), Buffer.from(bytes));

    const url = `${PREVIEW_BASE}/${safe}`;
    return {
      url,
      note:
        `Published. Give the user this URL exactly as-is, on its own line, with no markdown ` +
        `formatting around it (bold or backticks break the link): ${url}`,
    };
  },
});

export default previewTool;
