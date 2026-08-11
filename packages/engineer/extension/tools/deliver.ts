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
    // Storage is pluggable: a self-hosted client may have no Vercel account at
    // all. Vercel Blob when a token is present; otherwise a directory on the
    // host that something already serves (DELIVER_DIR + DELIVER_BASE_URL).
    const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    const hostDir = process.env.DELIVER_DIR;
    const hostBase = process.env.DELIVER_BASE_URL;
    if (!hasBlob && !(hostDir && hostBase)) {
      throw new Error(
        "File delivery is not configured. Either set BLOB_READ_WRITE_TOKEN " +
          "(vercel blob create-store <name> --access public --yes), or set " +
          "DELIVER_DIR and DELIVER_BASE_URL to a directory this host serves.",
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
    const key = `deliveries/${day}/${Date.now().toString(36)}/${name}`;

    let url: string;
    if (hasBlob) {
      const blob = await put(key, Buffer.from(bytes), {
        access: "public",
        addRandomSuffix: false,
        contentType,
      });
      url = blob.url;
    } else {
      // Host-served delivery: write under DELIVER_DIR and hand back the URL the
      // host serves it at. Whatever serves that directory owns access control.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const target = join(hostDir!, key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(bytes));
      url = `${hostBase!.replace(/\/$/, "")}/${key}`;
    }

    return {
      url,
      filename: name,
      byteSize: bytes.byteLength,
      note:
        "Share this URL with the user. Text formats render inline; HTML is served as a DOWNLOAD by Vercel Blob (it will not render in a browser) — to show someone a web page, deploy it or use a preview host instead. It is public to anyone with the link. " +
        "IMPORTANT: post the URL as PLAIN TEXT on its own line. Never wrap it in bold, italics, backticks, angle-bracket labels, or trailing punctuation — formatting characters get glued onto the URL in chat clients and BREAK the link.",
    };
  },
});
