import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The bridge, declaring itself.
 *
 * eve's `/eve/v1/info` lists the channels an agent authored; a workspace bridge
 * is a separate process the agent knows nothing about, so every console showed
 * an agent that was plainly answering in a workspace as reachable "only through
 * this app". Rather than have a console guess from process names, the bridge
 * writes one small file saying what it is connected to and touches it every
 * minute. Anything that reads the file — the agent's management routes, and
 * through them the desktop and the phone — can tell a live bridge from a stale
 * file by the heartbeat alone.
 */
export const HEARTBEAT_MS = 60_000;

/** Where every surface on this host writes its manifest; the management routes read the same directory. */
export function surfacesDir(): string {
  return process.env.KYB_SURFACES_DIR ?? join(homedir(), ".kybernesis", "surfaces");
}

export interface SurfaceManifest {
  kind: "buzz";
  name: string;
  /** The workspaces this bridge is connected to. */
  relays: string[];
  /** The key the workspace invited. */
  npub: string;
  /** Channels with a live conversation. */
  conversations: number;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface SurfaceWriter {
  /** Write the manifest now and keep its heartbeat fresh until `stop()`. */
  start(): void;
  /** Refresh what the manifest says, without waiting for the next beat. */
  update(patch: Partial<Pick<SurfaceManifest, "conversations">>): void;
  /** Remove the manifest: a stopped bridge should not look like a stale one. */
  stop(): void;
  readonly file: string;
}

export function surfaceWriter(
  input: { relays: string[]; npub: string; conversations(): number; dir?: string },
  onError: (message: string) => void = () => undefined,
): SurfaceWriter {
  const dir = input.dir ?? surfacesDir();
  // One file per connection set, so two bridges on one host for different workspaces do not overwrite each other.
  const file = join(dir, `buzz-${input.npub.slice(-8)}.json`);
  const startedAt = new Date().toISOString();
  let timer: ReturnType<typeof setInterval> | undefined;

  const write = (): void => {
    const manifest: SurfaceManifest = {
      kind: "buzz",
      name: "Buzz",
      relays: input.relays,
      npub: input.npub,
      conversations: input.conversations(),
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    } catch (error) {
      // A manifest that cannot be written costs a row on a console, not a conversation.
      onError(`could not write surface manifest ${file}: ${(error as Error).message}`);
    }
  };

  return {
    file,
    start() {
      write();
      timer = setInterval(write, HEARTBEAT_MS);
      timer.unref?.();
    },
    update() {
      write();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        /* a stale file is told apart by its heartbeat anyway */
      }
    },
  };
}

/** Read one manifest back; null when it is not one. */
export function readSurfaceManifest(file: string): SurfaceManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SurfaceManifest>;
    if (parsed.kind !== "buzz" || !Array.isArray(parsed.relays) || typeof parsed.heartbeatAt !== "string") return null;
    return parsed as SurfaceManifest;
  } catch {
    return null;
  }
}
