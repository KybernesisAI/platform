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

import { asDelivery, deliveryDestination, deliveryLabel, deliveryNote, type RoutineDelivery } from "./routine-delivery.js";

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
  /**
   * Where its answer goes when not to its owner's thread: a Buzz room (posted
   * by the manage channel), or Slack or iMessage (the turn runs there).
   */
  delivery?: RoutineDelivery;
}

/**
 * Render the routine file.
 *
 * The instruction is embedded with JSON.stringify rather than interpolated, so
 * a quote or a newline in what someone typed cannot end the string and change
 * the meaning of the file.
 */
export function routineSource(input: RoutineSourceInput): string {
  const delivery = input.delivery;
  const dest = input.destination ?? (delivery ? deliveryDestination(delivery) : undefined);
  const importLine = dest
    ? `import target from "../channels/${dest.channel}.js";`
    : `import manage from "../channels/${input.manageChannelModule}.js";`;
  // A routine that delivers elsewhere is marked as such on its owner, so the
  // phone is not rung for something posted in a room (see @kybernesis/notify).
  const owner = input.owner && delivery ? { ...input.owner, attributes: { ...input.owner.attributes, delivery: delivery.surface } } : input.owner;
  const auth = owner ? JSON.stringify(owner) : "appAuth";
  const runArgs = owner ? "{ to, waitUntil }" : "{ to, waitUntil, appAuth }";
  const sendTo = dest
    ? `to(target, ${JSON.stringify(dest.target)})`
    : delivery
      ? `to(manage, { routine: ${JSON.stringify(input.name)}, deliver: ${JSON.stringify(delivery)} })`
      : `to(manage, { routine: ${JSON.stringify(input.name)} })`;
  const instruction = delivery ? `${input.instruction}\n\n${deliveryNote(delivery)}` : input.instruction;
  const where = delivery
    ? `
 *
 * Its answer is posted in ${deliveryLabel(delivery)}, and only there.`
    : dest
      ? ""
      : `
 *
 * Each firing runs in the background, in its own session. What it has to say
 * is reported in its owner's thread, never posted as a message there.`;

  return `import { defineSchedule } from "eve/schedules";
${importLine}

/**
 * ${input.name}
 *
 * Created from KYBER Studio.${where}${owner ? `
 *
 * Runs as the person who asked for it, so it can use what they can (their
 * calendar, their pages) and their phone hears when it is done.` : ""}
 */
export default defineSchedule({
  cron: ${JSON.stringify(input.cron)},
  run: (${runArgs}) => {
    waitUntil(
      ${sendTo}.send(
        ${JSON.stringify(instruction)},
        { auth: ${auth} },
      ),
    );
  },
});
`;
}

/** What a routine file sends when it fires, as `readRoutine` finds it. */
export interface RoutineRun {
  /** The routine's name, as its schedule names it to the manage channel. */
  routine: string;
  instruction: string;
  /** The person it runs as; undefined for a routine that runs as the agent (`appAuth`). */
  owner?: RoutineOwner;
  /** Where its answer goes, when it names a Buzz room rather than its owner's thread. */
  delivery?: RoutineDelivery;
}

/**
 * Read what a routine file sends: the shape `routineSource` writes, and the
 * same shape edited by hand (the instruction and the owner are JSON either
 * way). A routine that sends somewhere else (a destination channel) or has
 * any other shape is undefined: it runs only on its schedule.
 */
export function readRoutine(source: string): RoutineRun | undefined {
  const target = /to\(manage, \{ routine: ("(?:[^"\\]|\\.)*")/.exec(source);
  if (!target) return undefined;
  let tail = source.slice(target.index + target[0].length);
  // A Buzz routine names its room in the target: `deliver: {...}`.
  let delivery: RoutineDelivery | undefined;
  const named = /^, deliver: /.exec(tail);
  if (named) {
    const json = balancedObject(tail.slice(named[0].length));
    if (!json) return undefined;
    try {
      delivery = asDelivery(JSON.parse(json));
    } catch {
      return undefined;
    }
    if (!delivery) return undefined;
    tail = tail.slice(named[0].length + json.length);
  }
  const head = /^ \}\)\.send\(\s*("(?:[^"\\]|\\.)*")\s*,\s*\{\s*auth:\s*/.exec(tail);
  if (!head) return undefined;
  let routine: unknown;
  let instruction: unknown;
  try {
    routine = JSON.parse(target[1]!);
    instruction = JSON.parse(head[1]!);
  } catch {
    return undefined;
  }
  if (typeof routine !== "string" || typeof instruction !== "string" || !instruction.trim()) return undefined;
  const rest = tail.slice(head[0].length);
  const where = delivery ? { delivery } : {};
  if (/^appAuth\b/.test(rest)) return { routine, instruction, ...where };
  const json = balancedObject(rest);
  if (!json) return undefined;
  let auth: unknown;
  try {
    auth = JSON.parse(json);
  } catch {
    return undefined;
  }
  const owner = routineOwner(auth, routine);
  return owner ? { routine, instruction, owner, ...where } : undefined;
}

/** The `{ ... }` at the start of `text`, braces balanced and strings respected. */
function balancedObject(text: string): string | undefined {
  if (!text.startsWith("{")) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return undefined;
}
