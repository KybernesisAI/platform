/**
 * @kybernesis/magic: proactive agents.
 *
 * This entry point is pure (no Node builtins, no network): profiles, the
 * detectors, the gate, the ledger and the message a background turn starts
 * from. The store, the connector calls and the tick live in
 * `@kybernesis/magic/steps`; the agent's tools, hook and instructions in
 * `@kybernesis/magic/tools`.
 */
export * from "./types.js";
export { DEFAULT_PROFILE, DEFAULT_COOLDOWN_MINUTES, normalizeProfile, updateProfile, kindEnabled, cooldownMinutes, notReady } from "./profile.js";
export { isTimeZone, localParts, localDate, localMinutes, parseClock, inWindow, describeLocal, clockIn } from "./time.js";
export { parseCalendarEvents, parseEmails, parseAddress } from "./parse.js";
export {
  detect,
  attendable,
  currentEvent,
  eventKey,
  isPhysicalLocation,
  isVip,
  legFor,
  owedReplies,
  type DetectInput,
} from "./detect.js";
export {
  gate,
  commit,
  prune,
  digestToFlush,
  emptyState,
  normalizeState,
  isQuietHours,
  inConversation,
  sentToday,
  CONVERSATION_HOLD_MS,
  type GateInput,
  type GateResult,
} from "./gate.js";
export { buildPacket, recentHeadsUps, isMagicMessage, MAGIC_MARKER } from "./packet.js";
export { applyFeedback, kindLabel, type FeedbackVerdict, type FeedbackResult } from "./feedback.js";
export { MAGIC_INSTRUCTIONS } from "./instructions.js";
export { threadIdFor } from "./surface.js";
