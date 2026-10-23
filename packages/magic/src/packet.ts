import { describeLocal } from "./time.js";
import type { MagicState, Moment, Profile } from "./types.js";

/**
 * The marker on every background check. A client that renders the
 * conversation can hide a message starting with it, and the hook uses it to
 * tell magic's own turns from the person writing.
 */
export const MAGIC_MARKER = "[kyb:magic]";

export function isMagicMessage(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(MAGIC_MARKER);
}

const BOLDNESS_RULE: Record<Profile["boldness"], string> = {
  tell: "Just tell them. Do not offer to do anything.",
  suggest: "You may offer one next step. Do not take it until they say yes.",
  draft:
    "You may prepare one thing in advance (a reply draft, a short brief) and show it, but never send, accept, decline or book anything without their yes.",
};

function compact(value: unknown, max = 1200): string {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The message a background turn starts from.
 *
 * It arrives in the person's own conversation, so it says plainly that nobody
 * typed it, gives the model the facts code already found, and leaves it free
 * to stay silent when, with everything it knows, the moment is not worth it.
 */
export function buildPacket(moments: Moment[], digest: Moment[], profile: Profile, now: Date): string {
  const tz = profile.timeZone ?? "UTC";
  const lines: string[] = [
    `${MAGIC_MARKER} This is your own background check, not a message from ${profile.name ?? "the person"}. Nobody typed it, and they cannot see it.`,
    `Their local time: ${describeLocal(now, tz)} (${tz}).`,
    "",
    "Code watching their calendar, mail and reminders noticed what follows. Use your tools if a fact needs checking (calendar, mail, memory), then write to them as yourself:",
    "- At most three short lines. Lead with what they need to know or do. No greeting, no sign-off, no mention of checks, packets or background work.",
    `- ${BOLDNESS_RULE[profile.boldness]}`,
    "- If, on reflection, none of it is worth interrupting them for, call no_reply instead of writing anything.",
    "",
  ];
  moments.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.kind} (${m.urgency}${m.urgent ? ", urgent" : ""}): ${m.summary}`);
    lines.push(`   facts: ${compact(m.evidence)}`);
    if (m.offer && profile.boldness !== "tell") lines.push(`   possible offer: ${m.offer}`);
  });
  if (digest.length) {
    lines.push("", "Saved from earlier for this message (mention only what still matters, briefly):");
    for (const m of digest.slice(0, 8)) lines.push(`- ${m.kind}: ${m.summary}`);
  }
  if (moments.some((m) => m.kind === "brief" || m.kind === "wrap")) {
    lines.push("", "For a brief or wrap you may use up to six short lines.");
  }
  return lines.join("\n");
}

/** What magic said lately, for the model's context in ordinary turns. */
export function recentHeadsUps(state: MagicState, now: Date, hours = 12): string | undefined {
  const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const sent = state.ledger.filter((e) => e.status === "sent" && e.at >= cutoff).slice(-8);
  if (!sent.length) return undefined;
  return [
    "Heads-ups you sent this person on your own in the last few hours (so you know what they may be replying to):",
    ...sent.map((e) => `- ${e.at.slice(11, 16)} UTC, ${e.kind}: ${e.summary ?? e.key}`),
  ].join("\n");
}
