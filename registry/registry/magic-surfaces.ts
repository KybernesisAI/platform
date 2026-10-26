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
 *   import { threadIdFor } from "@kybernesis/magic";
 *   import linq from "../channels/linq.js";
 *   const threadId = threadIdFor(dispatch.surface.token, "linq");
 *   if (threadId) {
 *     return to(linq, { threadId }).send(dispatch.packet, { auth: dispatch.surface.auth });
 *   }
 *
 * The recorded address is `<channel name>:<thread id>`; pass the thread id,
 * never the whole address, or the adapter refuses it without the send failing.
 */
export function deliver(to: ScheduleToFn, dispatch: MagicDispatch) {
  return to(kyb, { routine: "magic" }).send(dispatch.packet, { auth: dispatch.surface.auth });
}
