import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decode as decodeBech32, npubEncode } from "nostr-tools/nip19";

/**
 * The agent's own key, which is its whole identity in a workspace.
 *
 * @remarks
 * Kept in a file rather than an environment variable because it is generated once and then
 * referred to forever: the workspace invites a public key, and losing the private half means
 * being invited again as a stranger with none of the history.
 */
export type AgentKey = {
  secretKey: Uint8Array;
  publicKey: string;
  npub: string;
};

export function loadKey(file: string): AgentKey {
  const stored = JSON.parse(readFileSync(file, "utf8")) as { secretKey: number[] };
  const secretKey = Uint8Array.from(stored.secretKey);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, npub: npubEncode(publicKey) };
}

/** Load the key, or make one on first run. Never overwrites an existing key. */
export function loadOrCreateKey(file: string): { key: AgentKey; created: boolean } {
  try {
    return { key: loadKey(file), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secretKey = generateSecretKey();
  mkdirSync(dirname(file), { recursive: true });
  // 0600: this file is the agent. Anyone who can read it can be the agent.
  writeFileSync(file, JSON.stringify({ secretKey: Array.from(secretKey) }), { mode: 0o600 });
  const publicKey = getPublicKey(secretKey);
  return { key: { secretKey, publicKey, npub: npubEncode(publicKey) }, created: true };
}

/**
 * A public key in either form people actually have one in.
 *
 * @remarks
 * A workspace shows a member as `npub1…`; the protocol underneath uses hex, and so does the
 * control plane's record of who that member is. Asking a person to convert between them is
 * asking them to get it wrong, so both are accepted and normalised to one canonical form here.
 */
export function asHexPubkey(input: string | undefined | null): string | null {
  const value = String(input ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const { type, data } = decodeBech32(value);
    return type === "npub" ? String(data).toLowerCase() : null;
  } catch {
    return null;
  }
}

export { npubEncode };
