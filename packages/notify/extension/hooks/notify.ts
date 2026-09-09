import { defineHook } from "eve/hooks";

import { askingUser, notify, preview } from "../../src/index.js";

/**
 * Two moments a person wants to hear about: the agent parked on a question
 * only they can answer, and the agent finished a reply while they were away.
 *
 * Observe-only and at-least-once, as eve hooks are. Every branch here is
 * wrapped, because a thrown hook fails the turn, and a phone that did not
 * buzz is not worth a conversation that did not finish.
 */
const lastReply = new Map<string, string>();

function settings(): { issuer: string; credential: string } | null {
  const credential = process.env.KYBERNESIS_AGENT_CREDENTIAL;
  if (!credential) return null;
  return { issuer: process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai", credential };
}

export default defineHook({
  events: {
    async "input.requested"(event, ctx) {
      try {
        const s = settings();
        const user = askingUser(ctx as never);
        const sessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (!s || !user || !sessionId) return;
        // Both shapes eve has used: the prompt at the top level, or under the tool call's input.
        const first = (event as unknown as { data?: { requests?: readonly { prompt?: string; action?: { input?: Record<string, unknown> } }[] } }).data?.requests?.[0];
        const inner = (first?.action?.input ?? {}) as { prompt?: unknown; question?: unknown };
        const prompt = first?.prompt ?? (typeof inner.prompt === "string" ? inner.prompt : typeof inner.question === "string" ? inner.question : "");
        const r = await notify({ ...s, user, sessionId, kind: "question", body: prompt ? preview(prompt) : undefined });
        console.log(`[notify] question for ${user.slice(0, 8)} → ${r.status}`);
      } catch {
        /* never fail the turn */
      }
    },
    async "message.completed"(event, ctx) {
      try {
        const sessionId = (ctx as { session?: { id?: string } }).session?.id;
        const data = (event as { data?: { message?: string; finishReason?: string } }).data;
        if (!sessionId || typeof data?.message !== "string" || data.finishReason === "tool-calls") return;
        lastReply.set(sessionId, data.message);
      } catch {
        /* never fail the turn */
      }
    },
    async "session.waiting"(_event, ctx) {
      try {
        const s = settings();
        const user = askingUser(ctx as never);
        const sessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (!sessionId) return;
        const reply = lastReply.get(sessionId);
        lastReply.delete(sessionId);
        // A turn that ended without a reply — a question parked, a cancel — already said what it had to.
        if (!s || !user || !reply) return;
        const r = await notify({ ...s, user, sessionId, kind: "reply", body: preview(reply) });
        console.log(`[notify] reply for ${user.slice(0, 8)} → ${r.status}`);
      } catch {
        /* never fail the turn */
      }
    },
  },
});
