import { defineDurableCallback } from "eve/tools";

/**
 * Which connector tools wait for the person before they run.
 *
 * Anything that speaks for the person or changes their calendar: sending,
 * replying to or forwarding mail, posting or sending a message, and creating,
 * changing or deleting an event. Drafts, reads and searches run as before.
 * Matched on the tool's own name with word boundaries, so `gmail_send_email`,
 * `gmail_reply_to_thread`, `slack_sends_a_message_to_a_slack_channel` and
 * `googlecalendar_delete_event` ask, and `gmail_create_email_draft` and
 * `googlecalendar_find_event` do not. A second account's suffix
 * (`gmail_send_email_work`) changes nothing.
 */
const SPEAKS = /(^|_)(send|sends|reply|replies|forward|forwards)(_|$)|(^|_)posts?_(a_)?(message|to)(_|$)/;
const CALENDAR = /(calendar|(^|_)events?(_|$))/;
const CHANGES = /(^|_)(create|update|delete|patch|move|insert|remove|quick_add|quickadd)(_|$)/;

export function asksFirst(toolName: string): boolean {
  const name = (toolName.split("__").pop() ?? toolName).toLowerCase();
  return SPEAKS.test(name) || (CALENDAR.test(name) && CHANGES.test(name));
}

interface PolicyContext {
  toolName: string;
  session?: { auth?: { current?: { principalType?: string; attributes?: Record<string, unknown> } | null } };
}

/**
 * Ask the person, when there is one.
 *
 * A routine or webhook runs with nobody to ask, and a question there would
 * hold the run forever; the person set the routine up, which is their yes.
 * A routine runs AS its person (so it can read their calendar and ring their
 * phone), and says so with `trigger: "routine"`: that turn is still unasked.
 */
export function personApproves(ctx: PolicyContext): "user-approval" | "not-applicable" {
  if (!asksFirst(ctx.toolName)) return "not-applicable";
  const current = ctx.session?.auth?.current;
  if (current?.attributes?.trigger === "routine") return "not-applicable";
  return current?.principalType === "user" ? "user-approval" : "not-applicable";
}

/** The policy as a durable callback, so a parked call finds it again after a restart. */
export const askBeforeSending = () =>
  defineDurableCallback({ closure: {}, callback: (_closure: object, ctx: PolicyContext) => personApproves(ctx) });
