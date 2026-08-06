import { defineTool } from "eve/tools";
import { put } from "@vercel/blob";
import { z } from "zod";

/**
 * The engineer's outbox: hand a finished file to the user as a URL they can
 * open in a browser or download — the missing last mile between "the file
 * exists in my sandbox" and "the user actually has it".
 *
 * Uploads the sandbox file to Vercel Blob (public access) and returns the
 * URL. Requires BLOB_READ_WRITE_TOKEN — create and link a store with:
 *   vercel blob create-store <name> --access public --yes
 *
 * Text formats upload as text/plain so browsers RENDER them; everything else
 * keeps its real content type (browsers render images/PDF/HTML natively and
 * download the rest).
 */

const RENDER_AS_TEXT = new Set(["md", "markdown", "txt", "csv", "json", "log", "yaml", "yml", "ts", "tsx", "js", "py"]);
const NATIVE: Record<string, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  zip: "application/zip",
};

export default defineTool({
  description:
    "Deliver a file from the sandbox to the user: uploads it to durable storage and returns a public URL they can open in a browser or download and keep. Use this WHENEVER the user asks for a file, document, report, export, or artifact — writing to the sandbox or a memory note alone does NOT give the user the file.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Absolute sandbox path of the file to deliver, e.g. /workspace/reports/fde.md"),
    filename: z
      .string()
      .optional()
      .describe("Public filename shown in the URL; defaults to the file's basename"),
  }),
  async execute({ path, filename }, ctx) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error(
        "File delivery is not configured: BLOB_READ_WRITE_TOKEN is missing. " +
          "Create and link a Blob store: vercel blob create-store <name> --access public --yes",
      );
    }
    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (!bytes) throw new Error(`No file found at ${path} — write it in the sandbox first.`);
    if (bytes.byteLength > 100 * 1024 * 1024) {
      throw new Error("File exceeds the 100 MB delivery limit; split or compress it first.");
    }
    const name = (filename ?? path.split("/").pop() ?? "file").replace(/[^\w.\-()+ ]/g, "_");
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const contentType = RENDER_AS_TEXT.has(ext)
      ? "text/plain; charset=utf-8"
      : (NATIVE[ext] ?? "application/octet-stream");
    const day = new Date().toISOString().slice(0, 10);
    const blob = await put(`deliveries/${day}/${Date.now().toString(36)}/${name}`, Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: false,
      contentType,
    });
    return {
      url: blob.url,
      filename: name,
      byteSize: bytes.byteLength,
      note:
        "Share this URL with the user — it opens in a browser (text renders inline) and can be downloaded and kept. It is public to anyone with the link.",
    };
  },
});
