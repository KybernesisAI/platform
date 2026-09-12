import { verifyKybernesisRequest } from "@kybernesis/enterprise";
import { defineChannel, GET, POST } from "eve/channels";

/**
 * @kybernesis/voice — the agent side of KYBER Studio's realtime voice orb.
 *
 * Voice is a per-agent capability, not a Studio-global one. An agent that mounts
 * this channel becomes voice-capable; one that doesn't has no orb in Studio. The
 * agent holds its OWN OpenAI key (never a shared one, never in Studio), and this
 * channel is the only thing that reads it: the key is passed into `voiceChannel`
 * from the mount file's `process.env` and closed over here, so nothing else in
 * the agent picks it up by name.
 *
 * How a call runs: gpt-live-1 is the spoken voice and delegates every real
 * request (client delegation); Studio routes that delegation to THIS agent's own
 * session, where the tools, connectors, and memory live. So the voice can do
 * anything the text chat can. This channel does two things only — say the agent
 * is voice-capable, and mint the realtime session with the agent's key — both
 * behind the same control-plane grant that guards every other door.
 *
 * ```ts title="agent/channels/voice.ts"
 * import { voiceChannel } from "@kybernesis/voice";
 * export default voiceChannel({
 *   openaiApiKey: process.env.KYBERNESIS_VOICE_OPENAI_KEY!,
 *   voice: "cedar",
 * });
 * ```
 */

/** Routes mount verbatim at the server root, so they are namespaced here. */
const PREFIX = "/eve/v1/voice";
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const DEFAULT_MODEL = "gpt-live-1";
const DEFAULT_VOICE = "marin";

export interface VoiceOptions {
  /**
   * This agent's OpenAI API key, used only to mint realtime sessions. Read it
   * from a NON-generic env var in the mount file (e.g.
   * `process.env.KYBERNESIS_VOICE_OPENAI_KEY`) so no other code — and no OpenAI
   * SDK that auto-reads `OPENAI_API_KEY` — ever picks it up. It is never sent to
   * Studio; only the short-lived realtime answer SDP is returned.
   */
  openaiApiKey: string;
  /** The spoken voice (OpenAI Live voice name). Defaults to "marin". */
  voice?: string;
  /** How the voice refers to itself. Defaults to KYBERNESIS_AGENT. */
  displayName?: string;
  /** Realtime model. Defaults to gpt-live-1 (override with OPENAI_LIVE_MODEL). */
  model?: string;
  /** Control-plane issuer. Defaults to KYBERNESIS_ISSUER. */
  issuer?: string;
  /** This agent's registered name, for grant checks. Defaults to KYBERNESIS_AGENT. */
  agent?: string;
}

/**
 * The spoken persona. The voice model is a mouth, not a mind: it holds none of
 * the agent's knowledge and must delegate everything real back to the agent,
 * then speak the result in the first person. This is what stops it answering
 * "what is your role?" as a generic assistant instead of as the agent.
 */
function liveInstructions(displayName: string): string {
  return (
    `You are the live spoken voice of ${displayName}, on a phone-style call. Speak as ${displayName}, in the first person — warm, natural, and concise. ` +
    `Handle these yourself, immediately, WITHOUT delegating — they are social conversation, not requests for information or action: greetings and farewells ("hi", "hey", "good morning", "goodbye"), "how are you" and light small talk, thanks and acknowledgements ("thanks", "got it", "okay", "great"), and confirming you can hear the user. Answer them briefly and naturally as ${displayName} would. ` +
    `For ANYTHING else — any question, task, or request for information or action, INCLUDING who you are, your role, what you can do, your memory, your routines, creating or changing routines, or anything factual or personal — you have no knowledge of your own, so delegate it to ${displayName}'s real mind and speak the result back in the first person, as if you had known it all along. ` +
    `Never answer a real question from your own knowledge, never describe yourself in generic terms like "a helpful assistant," and when you are unsure whether something is small talk or a real request, delegate.`
  );
}

/**
 * Verify the SAME control-plane identity the user already signed in with — the
 * bearer token plus policy bundle — and require a grant for this agent. Custom
 * channels do not run the eve channel's authenticator, so each route checks
 * here, exactly as @kybernesis/manage does. No separate shared secret.
 */
async function authorize(req: Request, options: VoiceOptions): Promise<Response | null> {
  const issuer = options.issuer ?? process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
  const agent = options.agent ?? process.env.KYBERNESIS_AGENT;
  if (!agent) {
    return Response.json(
      { ok: false, error: "This agent has no KYBERNESIS_AGENT set, so it cannot check grants." },
      { status: 500 },
    );
  }
  const result = await verifyKybernesisRequest(req, { issuer, agent });
  if (result.ok) return null;
  return Response.json({ ok: false, error: result.error }, { status: result.status });
}

export function voiceChannel(options: VoiceOptions) {
  const voice = options.voice ?? DEFAULT_VOICE;
  const model = options.model ?? process.env.OPENAI_LIVE_MODEL ?? DEFAULT_MODEL;
  const displayName = options.displayName ?? options.agent ?? process.env.KYBERNESIS_AGENT ?? "the agent";

  return defineChannel({
    routes: [
      /**
       * Say this agent is voice-capable, and how it should sound. Studio calls
       * this per agent to decide whether to show the orb at all.
       */
      GET(PREFIX + "/manifest", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        return Response.json({ ok: true, enabled: true, voice, displayName });
      }),

      /**
       * Mint a realtime session for the browser's WebRTC offer, using THIS
       * agent's own OpenAI key, and return the answer SDP. The key never leaves
       * the agent; Studio relays only SDP. The session is configured for client
       * delegation, so the voice hands real work back to the agent's session.
       */
      POST(PREFIX + "/session", async (req) => {
        const denied = await authorize(req, options);
        if (denied) return denied;
        if (!options.openaiApiKey) {
          return Response.json(
            { ok: false, error: "This agent has no voice key set (KYBERNESIS_VOICE_OPENAI_KEY)." },
            { status: 500 },
          );
        }
        let sdp: string;
        let requestedVoice: string | undefined;
        try {
          const body = (await req.json()) as { sdp?: unknown; voice?: unknown };
          if (typeof body.sdp !== "string" || !body.sdp) throw new Error("missing sdp");
          sdp = body.sdp;
          if (typeof body.voice === "string" && body.voice) requestedVoice = body.voice;
        } catch {
          return Response.json({ ok: false, error: "Expected a JSON body with an SDP offer." }, { status: 400 });
        }

        const upstream = await fetch(LIVE_SESSIONS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${options.openaiApiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            session: {
              model,
              instructions: liveInstructions(displayName),
              audio: { output: { voice: requestedVoice ?? voice } },
              delegation: { type: "client" },
            },
            transport: { type: "webrtc", sdp },
          }),
        }).catch((err: unknown) => {
          return { ok: false, status: 502, text: async () => String(err) } as unknown as Response;
        });

        const text = await upstream.text();
        if (!upstream.ok) {
          return Response.json(
            { ok: false, error: `OpenAI Live session ${upstream.status}: ${text.slice(0, 400)}` },
            { status: 502 },
          );
        }
        let data: { transport?: { sdp?: string }; sdp?: string };
        try {
          data = JSON.parse(text);
        } catch {
          return Response.json({ ok: false, error: "OpenAI returned a non-JSON session." }, { status: 502 });
        }
        const answer = data.transport?.sdp ?? data.sdp;
        if (!answer) {
          return Response.json({ ok: false, error: "OpenAI session had no answer SDP." }, { status: 502 });
        }
        return Response.json({ ok: true, sdp: answer });
      }),
    ],
  });
}
