import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where this runtime keeps its .agent identity.
 *
 * Resolution order, per read: explicit options → environment (`ARP_AGENT_DID`,
 * `ARP_ISSUER`, `ARP_AGENT_CREDENTIAL`, `AGENTID_CHALLENGE`) → the identity
 * file. The file is what "Connect your agent" writes, so an owner never
 * touches environment variables; env stays for hosts without a writable disk.
 */
export interface Identity {
  did: string;
  issuer: string;
  credential: string;
  challenge: string;
  /** Where the identity came from. */
  source: "options" | "env" | "file" | "none";
}

export const DEFAULT_ISSUER = "https://gateway.arp.run";

export function identityFilePath(): string {
  return process.env.ARP_IDENTITY_FILE ?? join(process.cwd(), ".eve", "arp-identity.json");
}

let cache: { path: string; mtimeMs: number; value: Partial<Identity> } | null = null;

/** The identity file as written by "Connect your agent" ({} when absent). */
export function readIdentityFile(): Partial<Identity> {
  const path = identityFilePath();
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.value;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Identity>;
    cache = { path, mtimeMs, value };
    return value;
  } catch {
    cache = null;
    return {};
  }
}

/** Current identity. Never throws; missing pieces are empty strings. */
export function resolveIdentity(options: { agentDid?: string; issuer?: string; credential?: string; challenge?: string } = {}): Identity {
  const env = {
    did: process.env.ARP_AGENT_DID ?? "",
    issuer: process.env.ARP_ISSUER ?? "",
    credential: process.env.ARP_AGENT_CREDENTIAL ?? "",
    challenge: process.env.AGENTID_CHALLENGE ?? "",
  };
  const file = readIdentityFile();
  const pick = (opt: string | undefined, e: string, f: string | undefined): [string, Identity["source"]] =>
    opt ? [opt, "options"] : e ? [e, "env"] : f ? [f, "file"] : ["", "none"];
  const [did, didSource] = pick(options.agentDid, env.did, file.did);
  const [issuer] = pick(options.issuer, env.issuer, file.issuer);
  const [credential] = pick(options.credential, env.credential, file.credential);
  const [challenge] = pick(options.challenge, env.challenge, file.challenge);
  return { did, issuer: (issuer || DEFAULT_ISSUER).replace(/\/+$/, ""), credential, challenge, source: didSource };
}

/** Persist a connected identity. Throws when the store is not writable. */
export function saveIdentity(identity: { did: string; issuer: string; credential: string; challenge: string }): string {
  const path = identityFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...identity, connected_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  cache = null;
  return path;
}

/** Can this host keep an identity on disk? */
export function storeKind(): "file" | "none" {
  const path = identityFilePath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.arp-probe-${process.pid}`);
    writeFileSync(probe, "", { mode: 0o600 });
    try { unlinkSync(probe); } catch { /* ignore */ }
    return "file";
  } catch {
    return "none";
  }
}
