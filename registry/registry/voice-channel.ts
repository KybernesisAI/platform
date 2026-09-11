import { voiceChannel } from "@kybernesis/voice";

// Realtime voice for KYBER Studio: the floating orb speaks as this agent and
// delegates every real request back to the agent's own session, authorized by
// the caller's control-plane grant. This agent holds its OWN OpenAI key
// (KYBERNESIS_VOICE_OPENAI_KEY), read only here — never a shared one, never in
// Studio.
export default voiceChannel({
  openaiApiKey: process.env.KYBERNESIS_VOICE_OPENAI_KEY!,
  // voice: "cedar", // any OpenAI Live voice; the Studio per-agent setting overrides per call
});
