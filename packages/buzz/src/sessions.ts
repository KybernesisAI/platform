import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One conversation: which eve session it is, and how far the bridge has read. */
export interface StoredSession {
  id: string;
  streamIndex: number;
  /** When it was last used, so a store that runs for years does not grow forever. */
  updated: number;
}

/** How long an untouched conversation is kept before it is forgotten. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which eve session belongs to which channel, across restarts.
 *
 * @remarks
 * The eve session itself is durable — it lives on the agent's disk and survives
 * anything. What did NOT survive was the bridge's knowledge of WHICH session
 * belonged to a channel: that was a Map in memory, so a restart silently
 * orphaned every conversation. The next message opened a new session and the
 * agent answered "I have no context", while the old session sat on disk intact,
 * holding a turn whose reply nobody was left to read.
 *
 * Reported from a live deployment after a restart mid-conversation, and the
 * diagnosis there was exactly right: durable on one side, ephemeral on the
 * other, and the join between them was the part that could not survive.
 *
 * Keyed by community AND channel: channel ids are issued per relay, so an agent
 * in two workspaces cannot assume they never collide.
 */
export class SessionStore {
  #file: string;
  #entries = new Map<string, StoredSession>();
  #onError: (message: string) => void;

  constructor(file: string, options: { onError?: (message: string) => void } = {}) {
    this.#file = file;
    this.#onError = options.onError ?? (() => {});
    this.#load();
  }

  static key(community: string, channel: string): string {
    return `${community}|${channel}`;
  }

  get(community: string, channel: string): StoredSession | undefined {
    return this.#entries.get(SessionStore.key(community, channel));
  }

  set(community: string, channel: string, session: { id: string; streamIndex: number }): void {
    this.#entries.set(SessionStore.key(community, channel), { ...session, updated: Date.now() });
    this.#save();
  }

  delete(community: string, channel: string): void {
    this.#entries.delete(SessionStore.key(community, channel));
    this.#save();
  }

  get size(): number {
    return this.#entries.size;
  }

  #load(): void {
    if (!existsSync(this.#file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, StoredSession>;
      const cutoff = Date.now() - KEEP_MS;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value?.id === "string" && (value.updated ?? 0) > cutoff) {
          this.#entries.set(key, value);
        }
      }
    } catch (error) {
      // A corrupt store is not worth refusing to start over. Losing the mapping
      // costs conversation history; refusing to start costs the whole agent.
      this.#onError(`could not load Buzz session store ${this.#file}: ${(error as Error).message}`);
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      // Written beside the target and renamed, because the failure being
      // guarded against is a restart — and a restart during a plain write
      // leaves a truncated file that reads as "no sessions at all", which is
      // the exact bug this class exists to prevent.
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#entries)), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      // Best effort: an agent that cannot write its store still answers, it
      // just forgets across restarts — which is where this started.
      this.#onError(`could not write Buzz session store ${this.#file}: ${(error as Error).message}`);
    }
  }
}
