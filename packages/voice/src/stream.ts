import WebSocket from "ws";
import { Client } from "eve/client";

/**
 * The watch leg of voice: a relay that lets a device with no WebRTC hold a live
 * call with this agent.
 *
 * Studio and the phone speak WebRTC straight to GPT-Live and run the delegation
 * loop themselves. A watch can do neither: watchOS has no WebRTC, allows a
 * socket only inside a CallKit call, and — with the phone nearby — sends every
 * byte through the iPhone's companion relay, which cannot carry PCM at 24 kHz
 * (measured: round trip climbing 3 → 8 s, 40% of frames lost). So the agent
 * does the heavy half:
 *
 *  - It opens GPT-Live server to server with THIS agent's key, in G.711 mu-law
 *    at 8 kHz — about 11 KB/s, which the relay carries (275/275 frames of a
 *    27 s voice, measured). mu-law passes through untouched both ways.
 *  - It gates silence. GPT-Live streams audio continuously; over a five-minute
 *    call 95% of it was digital silence. None of that is sent to the watch.
 *  - It runs every delegation as a normal turn on this agent, AS THE PERSON on
 *    the watch, with the credentials the watch connected with. Same mind,
 *    tools, memory and grants as a turn typed in Studio.
 *
 * Wire format to the watch: binary frames are raw mu-law audio; text frames are
 * JSON status (`state`, `activity`, `error`). The watch sends mu-law audio as
 * binary and control as JSON text.
 */

export const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";

/** G.711 mu-law to a signed 16-bit sample. Used only by the silence gate; audio is never transcoded. */
export function muLawDecode(u: number): number {
  const v = ~u & 0xff;
  const sign = v & 0x80;
  const exponent = (v >> 4) & 0x07;
  const mantissa = v & 0x0f;
  const s = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -s : s;
}

/**
 * True when a chunk carries nothing audible. The threshold sits well under
 * speech: GPT-Live's pauses are exact digital zero, and its quietest speech
 * peaks far above 64 on the 16-bit scale.
 */
export function isSilent(bytes: Uint8Array, threshold = 64): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const s = muLawDecode(bytes[i]!);
    if (s > threshold || s < -threshold) return false;
  }
  return true;
}

/**
 * A JSON control frame from the watch, or null for audio. Audio frames are
 * 800 bytes of mu-law; one that happened to start with `{` and also parse as a
 * JSON object with a string `type` is not a case worth designing around.
 */
export function parseControl(bytes: Uint8Array): { type: string; [key: string]: unknown } | null {
  if (bytes.length === 0 || bytes.length > 4096 || bytes[0] !== 0x7b) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
      return value as { type: string };
    }
  } catch {
    /* audio that began with 0x7b */
  }
  return null;
}

/**
 * Split a reply into pieces GPT-Live will take in one `session.commentary.append`
 * (500 tokens each). Breaks on sentences where it can, so the voice never stops
 * mid-word between two appends.
 */
export function commentaryChunks(text: string, max = 1400): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    const at = cut > max * 0.5 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The label a watch shows while the agent works — the tool it is running, when there is one. */
export function activityFrom(event: { type: string; data?: Record<string, unknown> }): string | null {
  const data = event.data ?? {};
  if (event.type === "actions.requested") {
    const actions = (data.actions ?? data.calls) as { name?: unknown; toolName?: unknown }[] | undefined;
    const name = actions?.map((a) => a.toolName ?? a.name).find((n) => typeof n === "string") as string | undefined;
    if (name) return `Using ${name.replace(/__/g, " › ").replace(/_/g, " ")}`;
    return "Working";
  }
  if (event.type === "reasoning.appended") return "Thinking";
  return null;
}

export interface WatchSink {
  audio(bytes: Uint8Array): void;
  event(event: Record<string, unknown>): void;
  close(code: number, reason: string): void;
}

export interface LiveCallOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  displayName: string;
  /** Where this agent's eve routes are served, for the delegated turns. */
  agentUrl: string;
  /** The watch's own credentials, forwarded so each turn runs as that person. */
  userHeaders: { authorization: string; bundle: string };
  watch: WatchSink;
  log?: (event: Record<string, unknown>) => void;
}

/** Audio the watch sends before GPT-Live has started, kept so the first words are not lost. */
const EARLY_AUDIO_LIMIT = 8000 * 20;

type State = "connecting" | "listening" | "thinking" | "speaking" | "ended";

/** One live call: GPT-Live on one side, the watch on the other, this agent in between. */
export class LiveCall {
  private readonly ws: WebSocket;
  private readonly client: Client;
  private readonly work = new AbortController();
  private started = false;
  private ended = false;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  /** Transcription in progress, and a finished one waiting to be delegated. */
  private utterance = "";
  private pending = "";
  private delegating = false;
  private session: Awaited<ReturnType<Client["sessions"]["create"]>>["session"] | undefined;
  private state: State = "connecting";
  private stats = { framesIn: 0, framesOut: 0, silentDropped: 0, spoken: "" };
  private quietTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: LiveCallOptions) {
    const token = o.userHeaders.authorization.replace(/^Bearer\s+/i, "");
    this.client = new Client({
      host: o.agentUrl,
      auth: { bearer: token },
      // The bundle the person signed in with, and where they are: a live call.
      // The agent's notify hook uses the surface to not push a reply the person
      // is already hearing (see @kybernesis/notify).
      headers: { "x-kybernesis-bundle": o.userHeaders.bundle, "x-kybernesis-surface": "voice" },
      // Credential-bearing: never let fetch forward these to another origin.
      redirect: "manual",
    });
    this.setState("connecting");
    o.log?.({ ev: "call-start" });

    this.ws = new WebSocket(LIVE_WS_URL, { headers: { Authorization: `Bearer ${o.apiKey}` } });
    this.ws.on("open", () => {
      this.ws.send(
        JSON.stringify({
          type: "session.start",
          event_id: "evt_start",
          session: {
            model: o.model,
            instructions: o.instructions,
            audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: o.voice } },
            delegation: { type: "client" },
          },
        }),
      );
    });
    this.ws.on("message", (raw) => this.onLive(String(raw)));
    this.ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => this.fail(`GPT-Live refused the call (HTTP ${res.statusCode}). ${body.slice(0, 200)}`));
    });
    this.ws.on("error", (err) => this.fail(`GPT-Live connection failed: ${err.message}`));
    this.ws.on("close", () => {
      if (!this.ended) this.fail("GPT-Live ended the call.");
    });
  }

  /** mu-law from the watch's microphone. */
  audio(bytes: Uint8Array): void {
    if (this.ended || bytes.length === 0) return;
    const chunk = Buffer.from(bytes);
    this.stats.framesIn++;
    if (!this.started) {
      if (this.earlyBytes + chunk.length <= EARLY_AUDIO_LIMIT) {
        this.early.push(chunk);
        this.earlyBytes += chunk.length;
      }
      return;
    }
    this.sendAudio(chunk);
  }

  /** A control frame from the watch. */
  control(message: { type: string }): void {
    if (message.type === "hangup") this.end("hung up");
  }

  end(reason = "ended"): void {
    if (this.ended) return;
    this.ended = true;
    this.work.abort();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.setState("ended");
    this.o.log?.({ ev: "call-end", reason, ...this.stats, spoken: this.stats.spoken.slice(0, 300) });
    if (this.ws.readyState === WebSocket.OPEN) {
      // Ask for the final usage record, then close regardless.
      this.ws.send(JSON.stringify({ type: "session.close" }));
      setTimeout(() => this.ws.close(), 5_000).unref?.();
    } else {
      this.ws.close();
    }
  }

  private sendAudio(chunk: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session.input_audio.append", audio: chunk.toString("base64") }));
  }

  private setState(state: State): void {
    if (this.state === state) return;
    this.state = state;
    this.o.watch.event({ type: "state", state });
  }

  /** Speaking lasts while voice audio arrives; a short quiet means it is listening again. */
  private markSpeaking(): void {
    if (this.delegating) return;
    this.setState("speaking");
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      if (!this.ended && !this.delegating) this.setState("listening");
    }, 900);
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.o.log?.({ ev: "call-error", message });
    this.o.watch.event({ type: "error", message });
    this.end("error");
    this.o.watch.close(1011, message.slice(0, 120));
  }

  private onLive(text: string): void {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(e.type ?? "");

    if (type === "session.started") {
      this.started = true;
      this.o.log?.({ ev: "live-started", earlyBytes: this.earlyBytes });
      // The watch's first words, held while GPT-Live started. Small and brief:
      // at most a few seconds of mu-law, so it can go at once.
      for (const chunk of this.early) this.sendAudio(chunk);
      this.early = [];
      this.earlyBytes = 0;
      this.setState("listening");
      return;
    }
    if (type === "session.output_audio.delta" && typeof e.delta === "string") {
      const bytes = Buffer.from(e.delta, "base64");
      if (isSilent(bytes)) { this.stats.silentDropped++; return; }
      this.stats.framesOut++;
      this.o.watch.audio(bytes);
      this.markSpeaking();
      return;
    }
    if (/input.*transcript/.test(type)) {
      // Deltas build the utterance; a completed transcript REPLACES it — appending
      // asks the agent the same question twice ("what time is itwhat time is it").
      if (typeof e.delta === "string") this.utterance += e.delta;
      else if (typeof e.transcript === "string") {
        this.pending = e.transcript;
        this.utterance = "";
        this.o.log?.({ ev: "heard", text: e.transcript.slice(0, 200) });
      }
      if (this.utterance.length > 4000) this.utterance = this.utterance.slice(-4000);
      return;
    }
    if (/output.*transcript/.test(type) && typeof e.delta === "string") {
      this.stats.spoken += e.delta;
      return;
    }
    if (type === "session.delegation.created") {
      const delegation = e.delegation as { id?: unknown } | undefined;
      void this.delegate(typeof delegation?.id === "string" ? delegation.id : null);
      return;
    }
    if (type === "session.closed") {
      this.o.log?.({ ev: "call-usage", usage: e.usage });
      this.end("closed");
      this.o.watch.close(1000, "call ended");
      return;
    }
    if (type === "error" || type.endsWith(".error") || type.endsWith(".failed")) {
      const err = e.error as { message?: unknown } | undefined;
      this.o.watch.event({ type: "error", message: typeof err?.message === "string" ? err.message : type });
    }
  }

  private speak(delegationId: string | null, content: string, kind: "commentary" | "thinking" = "commentary"): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    for (const piece of kind === "commentary" ? commentaryChunks(content) : [content]) {
      this.ws.send(
        JSON.stringify({ type: `session.${kind}.append`, event_id: `${kind[0]}_${Date.now()}`, delegation_id: delegationId, content: piece }),
      );
    }
  }

  /** Run what the person asked as a normal turn on this agent, and have the voice say the answer. */
  private async delegate(delegationId: string | null): Promise<void> {
    // One at a time: overlapping turns would share the session cursor.
    if (this.delegating) return;
    const request = (this.pending || this.utterance).trim();
    this.pending = "";
    this.utterance = "";
    if (!request) {
      this.speak(delegationId, "Sorry, I didn't catch that — could you say it again?");
      return;
    }
    this.delegating = true;
    this.setState("thinking");
    this.speak(delegationId, "One moment.", "thinking");
    this.o.log?.({ ev: "delegation", chars: request.length });
    const began = Date.now();

    try {
      const response = this.session
        ? await this.session.send(request)
        : await this.client.sessions.create({ message: request }).then((created) => {
            this.session = created.session;
            return created.response;
          });

      let reply = "";
      let asked = false;
      for await (const event of response as AsyncIterable<{ type: string; data?: Record<string, unknown> }>) {
        if (this.work.signal.aborted) return;
        const label = activityFrom(event);
        if (label) this.o.watch.event({ type: "activity", label });
        const data = event.data ?? {};
        if (event.type === "input.requested") asked = true;
        if (event.type === "message.completed" && typeof data.message === "string" && data.finishReason !== "tool-calls") {
          reply = data.message;
        }
      }
      if (this.ended) return;
      this.o.watch.event({ type: "activity", label: null });
      const answer = asked
        ? `I need to ask you something back — open your conversation with ${this.o.displayName} in the app to answer.`
        : reply || "Done.";
      this.o.log?.({ ev: "delegation-done", ms: Date.now() - began, replyChars: answer.length, asked });
      this.speak(delegationId, answer);
    } catch (error) {
      if (this.ended) return;
      const message = error instanceof Error ? error.message : String(error);
      this.o.log?.({ ev: "delegation-error", message });
      this.o.watch.event({ type: "activity", label: null });
      this.speak(delegationId, `I couldn't reach ${this.o.displayName} just now: ${message.slice(0, 200)}`);
    } finally {
      this.delegating = false;
      if (!this.ended) this.setState("listening");
    }
  }
}
