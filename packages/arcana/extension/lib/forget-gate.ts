import type { ApprovalPolicy } from "eve/tools/approval";

/**
 * The ask-first gate on Arcana's forget tools.
 *
 * Arcana offers `arcana_find_memories`, `arcana_forget` and
 * `arcana_brain_delete` only to clients that send `X-Arcana-Forget:
 * ask-first`, a promise that a person approves every removal. This is that
 * promise: removals park for approval, only a person's turn may ask for one,
 * and only the person who asked may approve it (eve's default). Everything else (scheduled
 * turns, subagents, agent-to-agent calls) is denied, so a removal never runs
 * on its own initiative.
 */
export const FORGET_HEADER = "X-Arcana-Forget";
export const FORGET_HEADER_VALUE = "ask-first";

/** Remote names of the tools that remove something. Matched by suffix. */
export const REMOVING_TOOLS = ["arcana_forget", "arcana_brain_delete"] as const;

export function removes(toolName: string): boolean {
  return REMOVING_TOOLS.some((name) => toolName.endsWith(name));
}

/**
 * Request-time policy. No response policy on purpose: eve's default already
 * lets only the person whose turn asked approve or cancel the call.
 */
export const forgetApproval: ApprovalPolicy = ({ toolName, session }) => {
  if (!removes(toolName)) return "not-applicable";
  // Default-deny: a removal parks for a person only on a person's turn.
  if (session.auth.current?.principalType !== "user") {
    return { type: "denied", reason: "Only a person can ask for a memory to be removed." };
  }
  return "user-approval";
};
