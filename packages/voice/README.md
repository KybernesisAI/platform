# @kybernesis/voice

Give a KYBER Studio agent its own realtime voice. The floating orb in Studio
speaks **as the agent** and delegates every real request back to the agent's own
session, so the voice can do anything the text chat can — recall from memory,
know its role and routines, create routines, run tools and connectors.

Voice is a **per-agent capability**. An agent that mounts this channel is
voice-capable; one that doesn't shows no orb. Each agent holds its **own** OpenAI
key — never a shared one, and never in Studio.

## Install

```bash
eve add @kybernesis/voice
```

Set the agent's own key in a non-generic variable so nothing else picks it up:

```bash
# in the agent's .env.local
KYBERNESIS_VOICE_OPENAI_KEY=sk-...
```

## Mount

```ts title="agent/channels/voice.ts"
import { voiceChannel } from "@kybernesis/voice";

export default voiceChannel({
  openaiApiKey: process.env.KYBERNESIS_VOICE_OPENAI_KEY!,
  voice: "cedar", // any OpenAI Live voice; Studio's per-agent setting overrides at mint time
});
```

## Routes

Both require the caller's control-plane grant for this agent (verified with
`@kybernesis/enterprise`), the same identity every other door uses.

- `GET /eve/v1/voice/manifest` — `{ ok, enabled, voice, displayName }`. Studio
  calls this per agent to decide whether to show the orb.
- `POST /eve/v1/voice/session` — body `{ sdp }` (the browser's WebRTC offer);
  mints an OpenAI Live session with this agent's key, configured for client
  delegation, and returns `{ ok, sdp }` (the answer). The key never leaves the
  agent; only SDP crosses the wire.

## How it fits together

gpt-live-1 is the spoken voice and, under client delegation, hands every real
turn to the client. KYBER Studio routes that delegation to this agent's own eve
session and speaks back the result. This package is the agent's half: advertise
the capability, and mint the session with the agent's own key.
