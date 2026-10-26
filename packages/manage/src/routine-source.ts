/**
 * What a routine created from KYBER Studio actually looks like on disk.
 *
 * It used to be eve's `markdown` form, which eve documents plainly: "runs the
 * agent on the prompt and DISCARDS the output". So every routine anyone made in
 * Studio ran on time, did the work, and threw the answer away. Nothing arrived,
 * on any agent, for any user — not a deploy problem, not a cron problem: the
 * scaffold picked the one form that has no destination.
 *
 * The `run` form has a destination. It delivers through this agent's own
 * management channel, which knows the conversation the person is currently in
 * and continues it — or starts a new one when there is none.
 */

/** Where a routine's answer should go, when the person wanted somewhere specific. */
export interface RoutineDestination {
  /** Module under agent/channels/ to deliver to, without extension. */
  channel: string;
  /** The target object that channel's receive expects. */
  target: Record<string, unknown>;
}

/**
 * The person a routine runs as: the one who asked for it.
 *
 * A routine used to run as the agent itself (`appAuth`), and that turn has
 * nobody in it. So the phone was never rung (there is no person to ring), the
 * person's own connectors were out of reach (their calendar answered as the
 * company's), and a page they owned could not be updated (it is theirs alone).
 * A daily calendar routine on Sid ran on time and could do none of its job.
 *
 * Same shape as a verified session principal, and nothing secret: who, in
 * which org, at what grant level. `trigger: "routine"` marks the turn as one
 * nobody is watching live, so tools that would stop to ask the person (a
 * connector send) still run, as they always did for routines.
 */
export interface RoutineOwner {
  authenticator: string;
  principalId: string;
  principalType: "user";
  subject?: string;
  issuer?: string;
  attributes: Record<string, string | readonly string[]>;
}

/** Attributes describing where a live turn came from; a routine was not there. */
const LIVE_ONLY = new Set(["surface", "assertedAskerId", "assertedAskerLabel", "linq_user_id"]);

/**
 * The owner for a routine, from the verified principal of the turn or request
 * that asked for it. Undefined when that is not a person (a routine creating a
 * routine, an eval, a webhook): the routine then runs as the agent, as before.
 */
export function routineOwner(principal: unknown, routine: string): RoutineOwner | undefined {
  const p = principal as Partial<RoutineOwner> | null | undefined;
  if (!p || p.principalType !== "user" || typeof p.principalId !== "string" || !p.principalId) return undefined;
  // Namespaced framework principals are never people, whatever the type says.
  if (p.principalId.startsWith("eve:")) return undefined;
  const attributes: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(p.attributes && typeof p.attributes === "object" ? p.attributes : {})) {
    if (LIVE_ONLY.has(key)) continue;
    if (typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"))) attributes[key] = value;
  }
  return {
    authenticator: typeof p.authenticator === "string" && p.authenticator ? p.authenticator : "kybernesis",
    principalId: p.principalId,
    principalType: "user",
    ...(typeof p.subject === "string" ? { subject: p.subject } : {}),
    ...(typeof p.issuer === "string" ? { issuer: p.issuer } : {}),
    attributes: { ...attributes, trigger: "routine", routine },
  };
}

export interface RoutineSourceInput {
  name: string;
  cron: string;
  instruction: string;
  /** The module name of this agent's manage channel under agent/channels/. */
  manageChannelModule: string;
  /** Set only when the routine names its own destination. */
  destination?: RoutineDestination;
  /** The person it runs as. Without one it runs as the agent (`appAuth`). */
  owner?: RoutineOwner;
}

/**
 * Render the routine file.
 *
 * The instruction is embedded with JSON.stringify rather than interpolated, so
 * a quote or a newline in what someone typed cannot end the string and change
 * the meaning of the file.
 */
export function routineSource(input: RoutineSourceInput): string {
  const dest = input.destination;
  const importLine = dest
    ? `import target from "../channels/${dest.channel}.js";`
    : `import manage from "../channels/${input.manageChannelModule}.js";`;
  const auth = input.owner ? JSON.stringify(input.owner) : "appAuth";
  const runArgs = input.owner ? "{ to, waitUntil }" : "{ to, waitUntil, appAuth }";
  const sendTo = dest
    ? `to(target, ${JSON.stringify(dest.target)})`
    : `to(manage, { routine: ${JSON.stringify(input.name)} })`;

  return `import { defineSchedule } from "eve/schedules";
${importLine}

/**
 * ${input.name}
 *
 * Created from KYBER Studio.${dest ? "" : `
 *
 * Delivered into the conversation this agent is already having, so the answer
 * arrives where the person is looking. When there is no open conversation it
 * starts one.`}${input.owner ? `
 *
 * Runs as the person who asked for it, so it can use what they can (their
 * calendar, their pages) and their phone hears when it is done.` : ""}
 */
export default defineSchedule({
  cron: ${JSON.stringify(input.cron)},
  run: (${runArgs}) => {
    waitUntil(
      ${sendTo}.send(
        ${JSON.stringify(input.instruction)},
        { auth: ${auth} },
      ),
    );
  },
});
`;
}
