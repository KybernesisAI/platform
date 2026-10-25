/**
 * "On it" notes: one short line an agent sends when it starts on something
 * that will take a while, before the result.
 *
 * Without one, a person who asks for a page or a report on a text channel
 * sees nothing until the whole job is done, and cannot tell work from a hang.
 * The model's own words before a tool call do not help: every surface treats
 * them as narration (a typing label at most) and posts only the final reply.
 * So the agent calls a tool, `working_on_it` (in the notify extension), and
 * each surface posts that call's message the moment it sees it: the Buzz
 * bridge from the stream, a Linq or other chat channel through
 * `progressEvents`, and KYBER Studio and the phone as the turn's live step.
 *
 * Matched on the name's final segment, like every tool here, because the mount
 * namespace can change the prefix.
 */

/** The tool's name without its mount namespace. */
export const PROGRESS_TOOL = "working_on_it";

/** Past this many characters a note is cut: it is one sentence, not a reply. */
export const PROGRESS_MAX = 280;

export interface ProgressNote {
  callId: string;
  /** The turn the note belongs to, when the event names it. */
  turnId?: string;
  text: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** True for the progress tool under any mount namespace. */
export const isProgressTool = (tool: string | undefined): boolean =>
  typeof tool === "string" && (tool === PROGRESS_TOOL || tool.endsWith(`__${PROGRESS_TOOL}`));

/** One line of note text, cut at a word boundary. */
export function progressText(value: unknown): string | undefined {
  const line = str(value)?.replace(/\s+/g, " ");
  if (!line) return undefined;
  if (line.length <= PROGRESS_MAX) return line;
  const cut = line.slice(0, PROGRESS_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > PROGRESS_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * The progress notes in one stream event.
 *
 * `actions.requested` carries them before the tool runs, which is the earliest
 * a reader can post one. `action.result` carries the same text in the tool's
 * output, for a reader that only sees results (a chat channel whose
 * `actions.requested` handler already sets its typing label). A call through
 * eve's catalogue (`eve__tool`) names the real tool in its input.
 */
export function progressNotes(type: string, data: unknown): ProgressNote[] {
  if (!isObj(data)) return [];
  const turnId = str(data.turnId);
  const note = (callId: string | undefined, text: string | undefined): ProgressNote[] =>
    callId && text ? [{ callId, text, ...(turnId ? { turnId } : {}) }] : [];

  if (type === "actions.requested" && Array.isArray(data.actions)) {
    return data.actions.flatMap((raw) => {
      if (!isObj(raw)) return [];
      const callId = str(raw.callId) ?? str(raw.id);
      const viaCatalogue = str(raw.toolName) === "eve__tool" && isObj(raw.input);
      const tool = viaCatalogue ? str((raw.input as Obj).name) : (str(raw.toolName) ?? str(raw.name));
      if (!isProgressTool(tool)) return [];
      const input = viaCatalogue ? (raw.input as Obj).input : raw.input;
      return note(callId, isObj(input) ? progressText(input.message) : undefined);
    });
  }

  if (type === "action.result") {
    const result = isObj(data.result) ? data.result : {};
    if (!isProgressTool(str(result.toolName))) return [];
    if (data.status === "failed" || data.status === "rejected" || result.isError === true) return [];
    const output = isObj(result.output) ? result.output : {};
    return note(str(result.callId) ?? str(data.callId), progressText(output.message));
  }

  return [];
}

/**
 * Remembers which notes were already posted, so one turn posts at most one.
 *
 * The model is told to send a single note per task; this holds the line when
 * it sends a second, and when a durable step replays events a reader has
 * already handled. Keyed by turn when the event names one, else by call.
 */
export function progressGate(limit = 500): (note: ProgressNote) => boolean {
  const seen = new Set<string>();
  return (note) => {
    const key = note.turnId ? `turn:${note.turnId}` : `call:${note.callId}`;
    if (seen.has(key) || seen.has(`call:${note.callId}`)) return false;
    seen.add(key);
    seen.add(`call:${note.callId}`);
    while (seen.size > limit) seen.delete(seen.values().next().value as string);
    return true;
  };
}

/** The part of a chat channel's event context a note needs: somewhere to post. */
interface ChatThread {
  post(message: string | { markdown: string }): unknown;
}

/**
 * Event handlers that post each turn's progress note into a chat thread, for
 * eve's Chat SDK channels (Linq iMessage and SMS, and the others built on it):
 *
 *     linqChannel({ credentials, events: progressEvents() })
 *
 * It handles `action.result` only, because the channel's default
 * `actions.requested` handler is what shows the typing indicator, and an
 * override would replace it. The tool returns at once, so the note still
 * arrives before the work. A failed post is logged and never fails the turn.
 */
export function progressEvents(): {
  "action.result"(eventData: unknown, channel: { thread?: ChatThread | null }, ...rest: unknown[]): Promise<void>;
} {
  const fresh = progressGate();
  return {
    async "action.result"(eventData, channel, ...rest) {
      for (const note of progressNotes("action.result", eventData)) {
        if (!channel.thread || !fresh(note)) continue;
        try {
          await channel.thread.post(note.text);
        } catch (error) {
          console.warn(`[progress] could not post the note: ${(error as Error).message}`);
        }
      }
      // A renderer chain (Slack) passes the rest of the chain last; let it run.
      const next = rest.at(-1);
      if (typeof next === "function") await (next as () => unknown)();
    },
  };
}
