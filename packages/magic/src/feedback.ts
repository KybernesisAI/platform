import { cooldownMinutes, updateProfile } from "./profile.js";
import type { MagicState, MomentKind, Profile } from "./types.js";

/**
 * The person's dial. "Useful" and "not useful" are counted; "less" doubles a
 * kind's cooldown, "more" halves it, "off" and "on" switch it. Three misses in
 * a row on one kind slow it down without being asked, so a heads-up nobody
 * wants fades on its own.
 */
export type FeedbackVerdict = "useful" | "not_useful" | "less" | "more" | "off" | "on";

export interface FeedbackResult {
  profile: Profile;
  state: MagicState;
  /** One plain sentence on what changed, for the agent to repeat. */
  note: string;
}

const LABEL: Record<MomentKind, string> = {
  brief: "morning briefs",
  wrap: "evening wraps",
  meeting_prep: "meeting prep",
  leave: "time-to-leave alerts",
  conflict: "double-booking alerts",
  reply_owed: "reply nudges",
  vip_mail: "important-mail alerts",
  reminder: "reminders",
};

export function kindLabel(kind: MomentKind): string {
  return LABEL[kind];
}

export function applyFeedback(profile: Profile, state: MagicState, kind: MomentKind, verdict: FeedbackVerdict): FeedbackResult {
  const counts = { useful: 0, notUseful: 0, ...state.feedback[kind] };
  const label = LABEL[kind];
  const slower = () => Math.max(60, cooldownMinutes(profile, kind) * 2);
  let next = profile;
  let note: string;
  switch (verdict) {
    case "useful":
      counts.useful += 1;
      counts.notUseful = 0;
      note = `Noted that ${label} help.`;
      break;
    case "not_useful":
      counts.notUseful += 1;
      if (counts.notUseful >= 3) {
        next = updateProfile(profile, { kinds: { [kind]: { cooldownMinutes: slower() } } });
        counts.notUseful = 0;
        note = `Three misses in a row, so ${label} now come at most every ${next.kinds[kind]?.cooldownMinutes} minutes.`;
      } else {
        note = `Noted that this one did not help.`;
      }
      break;
    case "less":
      next = updateProfile(profile, { kinds: { [kind]: { cooldownMinutes: slower() } } });
      note = `${capital(label)} now come at most every ${next.kinds[kind]?.cooldownMinutes} minutes.`;
      break;
    case "more": {
      const current = cooldownMinutes(profile, kind);
      next = updateProfile(profile, { kinds: { [kind]: { enabled: true, cooldownMinutes: Math.floor(current / 2) } } });
      note = `${capital(label)} are on${current > 1 ? `, at most every ${next.kinds[kind]?.cooldownMinutes} minutes` : ""}.`;
      break;
    }
    case "off":
      next = updateProfile(profile, { kinds: { [kind]: { enabled: false } } });
      note = `${capital(label)} are off.`;
      break;
    case "on":
      next = updateProfile(profile, { kinds: { [kind]: { enabled: true } } });
      note = `${capital(label)} are on.`;
      break;
  }
  return { profile: next, state: { ...state, feedback: { ...state.feedback, [kind]: counts } }, note };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
