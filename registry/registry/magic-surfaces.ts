import type { MagicDispatch } from "@kybernesis/magic";
import type { ScheduleToFn } from "eve/schedules";
import kyb from "../channels/kyb.js";

/**
 * Where a heads-up is delivered: the conversation the person last used.
 *
 * Studio and the phone app share the agent's canonical conversation through
 * the kyb channel, and a turn run as the person rings their phone. To deliver
 * into another channel's conversation, import that channel and add a branch
 * on the recorded address. For iMessage through Linq:
 *
 *   import linq from "../channels/linq.js";
 *   if (dispatch.surface.token?.startsWith("linq:")) {
 *     return to(linq, { threadId: dispatch.surface.token }).send(dispatch.packet, { auth: dispatch.surface.auth });
 *   }
 */
export function deliver(to: ScheduleToFn, dispatch: MagicDispatch) {
  return to(kyb, { routine: "magic" }).send(dispatch.packet, { auth: dispatch.surface.auth });
}
