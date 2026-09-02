import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InputRequest } from "eve/client";

/** One conversation: which eve session it is, and how far the bridge has read. */
export interface StoredSession {
  id: string;
  streamIndex: number;
  /** Pending HITL controls, when the active turn is parked. */
  pending?: readonly InputRequest[];
  /** The speaker whose short-lived authority follows a parked turn. */
  speaker?: string;
  /** Explicit routing fields make pending entries restorable without parsing keys. */
  community?: string;
  channel?: string;
  /** When it was last used, so a store that runs for years does not grow forever. */
  updated: number;
}

export interface SessionEntry {
  community: string;
  channel: string;
  session: StoredSession;
}

/** How long an untouched conversation is kept before it is forgotten. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Which eve session belongs to which channel, across restarts. */
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

  set(
    community: string,
    channel: string,
    session: Omit<StoredSession, "updated" | "community" | "channel">,
  ): void {
    this.#entries.set(SessionStore.key(community, channel), {
      ...session,
      community,
      channel,
      updated: Date.now(),
    });
    this.#save();
  }

  delete(community: string, channel: string): void {
    this.#entries.delete(SessionStore.key(community, channel));
    this.#save();
  }

  entries(): SessionEntry[] {
    const result: SessionEntry[] = [];
    for (const [key, session] of this.#entries) {
      const separator = key.lastIndexOf("|");
      const community = session.community ?? key.slice(0, separator);
      const channel = session.channel ?? key.slice(separator + 1);
      if (community && channel) result.push({ community, channel, session });
    }
    return result;
  }

  pending(): SessionEntry[] {
    return this.entries().filter(({ session }) => Boolean(session.pending?.length && session.speaker));
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
        if (
          typeof value?.id === "string" &&
          typeof value.streamIndex === "number" &&
          (value.updated ?? 0) > cutoff
        ) {
          this.#entries.set(key, value);
        }
      }
    } catch (error) {
      this.#onError(`could not load Buzz session store ${this.#file}: ${(error as Error).message}`);
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#entries)), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      this.#onError(`could not write Buzz session store ${this.#file}: ${(error as Error).message}`);
    }
  }
}
