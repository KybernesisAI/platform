import { card, withCards } from "@kybernesis/cards";
import { defineTool } from "eve/tools";
import { put } from "@vercel/blob";
import { z } from "zod";

/**
 * The engineer's outbox: hand a finished file to the user as a URL they can
 * open in a browser or download — the missing last mile between "the file
 * exists in my sandbox" and "the user actually has it".
 *
 * Where the file goes, first match wins:
 * - Vercel Blob (public access) when BLOB_READ_WRITE_TOKEN is set.
 * - DELIVER_DIR, served by whatever serves it at DELIVER_BASE_URL.
 * - The agent itself, on a host that knows its own address (EVE_PUBLIC_URL,
 *   or EXE_VM_NAME on exe.dev): the file is written under
 *   ~/.kybernesis/deliveries and served by @kybernesis/manage at
 *   /eve/v1/kyb/files. The customer's files stay on the customer's agent.
 *
 * Every link carries 128 random bits, so a link is the only way to a file.
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
    // host, served either by something the operator set up or by the agent.
    const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    const hostBase = process.env.DELIVER_BASE_URL ?? agentServedBase();
    if (!hasBlob && !hostBase) {
      throw new Error(
        "File delivery is not configured. Either set BLOB_READ_WRITE_TOKEN " +
          "(vercel blob create-store <name> --access public --yes), set " +
          "DELIVER_DIR and DELIVER_BASE_URL to a directory this host serves, or set " +
          "EVE_PUBLIC_URL so the agent serves delivered files itself.",
      );
    }
    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (!bytes) throw new Error(`No file found at ${path} — write it in the sandbox first.`);
    if (bytes.byteLength > 100 * 1024 * 1024) {
      throw new Error("File exceeds the 100 MB delivery limit; split or compress it first.");
    }
    // No leading dots: "." and ".." would name the directory, not a file in it.
    const name = (filename ?? path.split("/").pop() ?? "file").replace(/[^\w.\-()+ ]/g, "_").replace(/^\.+/, "_") || "file";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const contentType = RENDER_AS_TEXT.has(ext)
      ? "text/plain; charset=utf-8"
      : (NATIVE[ext] ?? "application/octet-stream");
    // Unguessable, unlike a timestamp: on the agent's own address the link is
    // the only thing between a stranger and a customer's file.
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

    let url: string;
    if (hasBlob) {
      const blob = await put(`deliveries/${id}/${name}`, Buffer.from(bytes), {
        access: "public",
        addRandomSuffix: false,
        contentType,
      });
      url = blob.url;
    } else {
      // Host-served delivery: write under the delivery directory and hand back
      // the URL it is served at. Whatever serves it owns access control.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(process.env.DELIVER_DIR ?? join(homedir(), ".kybernesis", "deliveries"), id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from(bytes));
      url = `${hostBase!.replace(/\/$/, "")}/${id}/${encodeURIComponent(name)}`;
    }

    // The file as a card in KYBER Studio and the phone. The reply still carries
    // the URL, because text-only channels never see tool results.
    // The apps draw the file's own Open button.
    const file = card("file", { url, name, size: bytes.byteLength, mediaType: contentType.split(";")[0] });
    return withCards({
      url,
      filename: name,
      byteSize: bytes.byteLength,
      note:
        (hasBlob
          ? "Share this URL with the user. Text formats render inline; HTML is served as a DOWNLOAD by Vercel Blob (it will not render in a browser) — to show someone a web page, deploy it or use a preview host instead. It is public to anyone with the link. "
          : "Share this URL with the user. Text formats, images, PDF and HTML open in the browser; other files download. Anyone with the link can open it. ") +
        "IMPORTANT: post the URL as PLAIN TEXT on its own line. Never wrap it in bold, italics, backticks, angle-bracket labels, or trailing punctuation — formatting characters get glued onto the URL in chat clients and BREAK the link.",
    }, file);
  },
  // The model reads the delivery without the card data.
  toModelOutput: (output) => {
    const { kyb: _card, ...rest } = output as Record<string, unknown>;
    return { type: "json", value: rest };
  },
});

/**
 * The delivery base URL when the agent serves files itself, or undefined when
 * it cannot tell its own public address. DELIVER_DIR alone is not enough: a
 * custom directory is served by whatever the operator pointed at it.
 */
function agentServedBase(): string | undefined {
  // A serverless deployment has no disk that outlives the request.
  if (process.env.DELIVER_DIR || process.env.VERCEL) return undefined;
  const vm = process.env.EXE_VM_NAME?.trim();
  const origin = process.env.EVE_PUBLIC_URL?.trim() || (vm ? `https://${vm}.exe.xyz` : "");
  return origin ? `${origin.replace(/\/$/, "")}/eve/v1/kyb/files` : undefined;
}
