import { artifactCard, MAX_BYTES, shareLink, wantsLink, type ArtifactMeta, type PrincipalContext } from "../../src/index.js";

/** A serverless deployment has no disk that outlives the request, so an artifact written there would vanish. */
export function requireDisk(): void {
  if (process.env.VERCEL && !process.env.ARTIFACTS_DIR) {
    throw new Error("Artifacts need a host with a disk that lasts; this deployment has none.");
  }
}

interface SandboxReader {
  getSandbox(): PromiseLike<{ readBinaryFile(input: { path: string }): PromiseLike<Uint8Array | null | undefined> }>;
}

/** The page, from the call itself or from a file in the sandbox. Exactly one of the two. */
export async function contentFrom(input: { content?: string; path?: string }, ctx: SandboxReader): Promise<string> {
  if (input.content && input.path) throw new Error("Give content or path, not both.");
  if (input.content) return input.content;
  if (!input.path) throw new Error("Give the page as content, or the sandbox path of a file holding it.");
  const sandbox = await ctx.getSandbox();
  const bytes = await sandbox.readBinaryFile({ path: input.path });
  if (!bytes) throw new Error(`No file found at ${input.path}; write it in the sandbox first.`);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`${input.path} is over the ${MAX_BYTES / 1024 / 1024} MB limit for an artifact.`);
  return new TextDecoder().decode(bytes);
}

/**
 * What the model sees after a create or update: enough to talk about it and
 * change it later, never the card JSON. The reply still has to stand on its
 * own, because chat channels that draw no cards only ever see the words; on
 * those the output carries a link and the model is told to send it.
 */
export function forModel(output: { artifactId: string; version: number; title: string; url?: string }, verb: string) {
  const what = `${verb} artifact "${output.title}" (id ${output.artifactId}, version ${output.version}). `;
  if (output.url) {
    return {
      type: "text" as const,
      value:
        what +
        "This conversation shows only text, so the person can open it only through this link. Put the link in your reply exactly as written, on its own line, and say in a sentence or two what the page shows: " +
        output.url,
    };
  }
  return {
    type: "text" as const,
    value:
      what +
      "The person sees it as a card in KYBER Studio, the phone app and Buzz, so do not paste its content into your reply. " +
      "Say in a sentence or two what it shows. If they ask for a link to it, get one with link.",
  };
}

/**
 * The full output of a create or update: the facts, and the card the apps
 * draw. On a surface that shows only text (iMessage) it also carries a share
 * link for the person who asked, and the card carries the same link.
 */
export function result(meta: ArtifactMeta, ctx: PrincipalContext) {
  let url: string | undefined;
  if (wantsLink(ctx)) {
    try {
      url = shareLink(meta);
    } catch (error) {
      console.warn(`[artifacts] could not make a link for ${meta.id.slice(0, 8)}: ${(error as Error).message}`);
    }
  }
  return {
    artifactId: meta.id,
    version: meta.version,
    title: meta.title,
    format: meta.format,
    display: meta.display,
    ...(url ? { url } : {}),
    kyb: artifactCard(meta, url),
  };
}
