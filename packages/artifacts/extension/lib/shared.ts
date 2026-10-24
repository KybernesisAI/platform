import { artifactCard, MAX_BYTES, type ArtifactMeta } from "../../src/index.js";

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
 * own, because chat channels that draw no cards only ever see the words.
 */
export function forModel(output: { artifactId: string; version: number; title: string }, verb: string) {
  return {
    type: "text" as const,
    value:
      `${verb} artifact "${output.title}" (id ${output.artifactId}, version ${output.version}). ` +
      "The person sees it as a card in KYBER Studio, the phone app and Buzz, so do not paste its content into your reply. " +
      "Say in a sentence or two what it shows. On a channel without cards, tell them it is under this agent's Artifacts in KYBER Studio.",
  };
}

/** The full output of a create or update: the facts, and the card the apps draw. */
export function result(meta: ArtifactMeta) {
  return {
    artifactId: meta.id,
    version: meta.version,
    title: meta.title,
    format: meta.format,
    display: meta.display,
    kyb: artifactCard(meta),
  };
}
