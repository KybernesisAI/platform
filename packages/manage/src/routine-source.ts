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

export interface RoutineSourceInput {
  name: string;
  cron: string;
  instruction: string;
  /** The module name of this agent's manage channel under agent/channels/. */
  manageChannelModule: string;
  /** Set only when the routine names its own destination. */
  destination?: RoutineDestination;
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
 * starts one.`}
 */
export default defineSchedule({
  cron: ${JSON.stringify(input.cron)},
  run: ({ to, waitUntil, appAuth }) => {
    waitUntil(
      ${sendTo}.send(
        ${JSON.stringify(input.instruction)},
        { auth: appAuth },
      ),
    );
  },
});
`;
}
