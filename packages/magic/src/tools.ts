import { defineHook } from "eve/hooks";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { kindLabel } from "./feedback.js";
import { isQuietHours, sentToday } from "./gate.js";
import { MAGIC_INSTRUCTIONS } from "./instructions.js";
import { recentHeadsUps } from "./packet.js";
import { clockIn, describeLocal, isTimeZone } from "./time.js";
import { MOMENT_KINDS, type MomentKind } from "./types.js";
import {
  addReminder,
  cancelReminder,
  personAuth,
  readProfile,
  readState,
  recordFeedback,
  recordTurn,
  status,
  updateSettings,
  type MagicOptions,
} from "./steps.js";

/**
 * The agent-facing side of magic: settings, reminders, status and feedback
 * tools, the hook that remembers where each person talks, and the dynamic
 * instruction. Each tool acts for the verified person in the turn and nobody
 * else; an unattended or shared-principal turn gets a plain refusal.
 */

const NO_PERSON =
  "Heads-ups belong to one person, and this turn is not from a signed-in person, so there is nothing to change here.";

function personOf(ctx: unknown): string | undefined {
  const current = (ctx as { session?: { auth?: { current?: unknown } } })?.session?.auth?.current;
  return personAuth(current)?.principalId;
}

const kindSchema = z.enum(MOMENT_KINDS as [MomentKind, ...MomentKind[]]);
const clock = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM, 24-hour");

export function magicSettingsTool(options: MagicOptions = {}) {
  return defineTool({
    description:
      "Turn heads-ups on or off for the person you are talking to, or change how they work: time zone, brief and wrap times, quiet hours, places, people whose mail matters, how bold to be, and which kinds they want. Only the fields you pass change.",
    inputSchema: z.object({
      enabled: z.boolean().optional().describe("true to turn heads-ups on, false to turn them off."),
      timeZone: z.string().optional().describe("IANA time zone, such as Asia/Bangkok. Required to turn on."),
      name: z.string().max(80).optional().describe("What to call them."),
      briefAt: clock.nullable().optional().describe("Morning brief time, local, or null for none."),
      wrapAt: clock.nullable().optional().describe("Evening wrap time, local, or null for none."),
      quietHours: z.object({ start: clock, end: clock }).partial().optional(),
      dailyBudget: z.number().int().min(0).max(50).optional().describe("Most interruptions in a day; the rest wait for the brief."),
      meetingLeadMinutes: z.number().int().min(5).max(120).optional(),
      leaveBufferMinutes: z.number().int().min(0).max(120).optional(),
      travelFallbackMinutes: z.number().int().min(0).max(600).optional().describe("Travel time to assume when no live estimate is available."),
      travelMode: z.enum(["DRIVE", "TRANSIT", "WALK", "BICYCLE", "TWO_WHEELER"]).optional(),
      places: z
        .object({ home: z.string().max(300).nullable(), office: z.string().max(300).nullable() })
        .partial()
        .optional()
        .describe("Addresses as a map would find them; null clears one."),
      vips: z.array(z.string().max(200)).max(100).optional().describe("Email addresses or domains whose mail always matters. Replaces the list."),
      workHours: z.object({ start: clock, end: clock, days: z.array(z.number().int().min(0).max(6)) }).partial().optional(),
      boldness: z.enum(["tell", "suggest", "draft"]).optional(),
      kinds: z
        .record(kindSchema, z.object({ enabled: z.boolean().optional(), cooldownMinutes: z.number().int().min(0).optional() }))
        .optional()
        .describe("Per kind: brief, wrap, meeting_prep, leave, conflict, reply_owed, vip_mail, reminder."),
    }),
    async execute(input, ctx) {
      const person = personOf(ctx);
      if (!person) return { ok: false, note: NO_PERSON };
      if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) {
        return { ok: false, note: `${input.timeZone} is not a time zone name. Use an IANA name such as Asia/Bangkok.` };
      }
      const current = readProfile(person, options);
      if (input.enabled && !(input.timeZone ?? current.timeZone)) {
        return { ok: false, note: "Ask for their time zone first; heads-ups cannot be timed without it." };
      }
      const change = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      const profile = await updateSettings(person, change, options);
      return { ok: true, settings: profile };
    },
  });
}

export function remindMeTool(options: MagicOptions = {}) {
  return defineTool({
    description:
      "Set a one-off reminder for the person you are talking to, delivered to them at that time even in quiet hours. Give either `at` (an ISO time with its offset) or `inMinutes`. Pass `cancel` with a reminder id to cancel one instead.",
    inputSchema: z.object({
      text: z.string().max(500).optional().describe("What to remind them of, written to them."),
      at: z.string().optional().describe("When, as an ISO 8601 time with offset, e.g. 2026-10-24T15:00:00+07:00."),
      inMinutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
      cancel: z.string().optional().describe("The id of a reminder to cancel."),
    }),
    async execute(input, ctx) {
      const person = personOf(ctx);
      if (!person) return { ok: false, note: NO_PERSON };
      if (input.cancel) {
        return (await cancelReminder(person, input.cancel, options))
          ? { ok: true, note: "Cancelled." }
          : { ok: false, note: "No reminder with that id is waiting." };
      }
      if (!input.text?.trim()) return { ok: false, note: "Say what to remind them of." };
      const due = input.inMinutes !== undefined ? new Date(Date.now() + input.inMinutes * 60_000) : input.at ? new Date(input.at) : undefined;
      if (!due || Number.isNaN(due.getTime())) return { ok: false, note: "Give a time: `at` with an offset, or `inMinutes`." };
      if (input.at && !/([+-]\d{2}:?\d{2}|Z)$/i.test(input.at.trim())) {
        return { ok: false, note: "Include the UTC offset in `at` (for example +07:00) so the time is not misread." };
      }
      if (due.getTime() < Date.now() - 60_000) return { ok: false, note: "That time has already passed." };
      const reminder = await addReminder(person, input.text, due, options);
      const tz = readProfile(person, options).timeZone;
      return {
        ok: true,
        id: reminder.id,
        dueAt: reminder.dueAt,
        ...(tz ? { localTime: describeLocal(due, tz) } : {}),
        note: "Set. It arrives within five minutes of that time, in this conversation.",
      };
    },
  });
}

export function magicStatusTool(options: MagicOptions = {}) {
  return defineTool({
    description:
      "What heads-ups are doing for the person you are talking to: on or off, what they are set to, which sources are working, waiting reminders, and what was sent recently.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const person = personOf(ctx);
      if (!person) return { ok: false, note: NO_PERSON };
      const now = new Date();
      const { profile, state, surface, reminders, notReady } = status(person, options);
      const tz = profile.timeZone ?? "UTC";
      const problems = Object.entries(state.health)
        .filter(([, h]) => h)
        .map(([source, h]) => ({ source, since: h!.at, problem: h!.error }));
      return {
        ok: true,
        on: !notReady,
        ...(notReady ? { why: notReady } : {}),
        settings: profile,
        deliversTo: surface ? { conversation: surface.kind ?? "unknown", lastHeardFromThem: surface.at } : "nowhere yet: they need to message you once",
        calendarReadAt: state.calendar?.at ?? null,
        mailReadAt: state.inbox?.at ?? null,
        problems,
        quietHoursNow: isQuietHours(profile, now),
        interruptionsToday: `${sentToday(state, profile, now)} of ${profile.dailyBudget}`,
        savedForBrief: state.digest.map((m) => m.summary),
        reminders: reminders.map((r) => ({ id: r.id, text: r.text, at: describeLocal(new Date(r.dueAt), tz) })),
        recent: state.ledger
          .filter((e) => e.status === "sent")
          .slice(-10)
          .map((e) => ({ at: `${clockIn(new Date(e.at), tz)}`, kind: e.kind, said: e.summary ?? e.key })),
      };
    },
  });
}

export function magicFeedbackTool(options: MagicOptions = {}) {
  return defineTool({
    description:
      "Record how the person felt about a kind of heads-up: useful, not_useful, less (fewer of these), more, off (stop these), on. Adjusts how often that kind is sent.",
    inputSchema: z.object({
      kind: kindSchema,
      verdict: z.enum(["useful", "not_useful", "less", "more", "off", "on"]),
    }),
    async execute(input, ctx) {
      const person = personOf(ctx);
      if (!person) return { ok: false, note: NO_PERSON };
      const note = await recordFeedback(person, input.kind, input.verdict, options);
      return { ok: true, kind: kindLabel(input.kind), note };
    },
  });
}

/**
 * Remember, for every message a person sends, which conversation it came in
 * on. That conversation is where their heads-ups go.
 */
export function magicHook(options: MagicOptions = {}) {
  return defineHook({
    events: {
      async "message.received"(event, ctx) {
        try {
          await recordTurn(
            {
              auth: ctx.session.auth.current,
              ...(ctx.channel.kind ? { channelKind: ctx.channel.kind } : {}),
              ...(ctx.channel.continuationToken ? { continuationToken: ctx.channel.continuationToken } : {}),
              text: event.data.message,
            },
            options,
          );
        } catch (error) {
          console.error(`[magic] could not record the conversation: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
  });
}

/** The standing guidance, plus what magic said to this person lately. */
export function magicInstructions(options: MagicOptions = {}) {
  return defineDynamic({
    events: {
      "turn.started": (_event, ctx) => {
        const person = personAuth(ctx.session.auth.current)?.principalId;
        const recent = person ? recentHeadsUps(readState(person, options), new Date()) : undefined;
        return defineInstructions({ content: recent ? `${MAGIC_INSTRUCTIONS}\n\n${recent}` : MAGIC_INSTRUCTIONS });
      },
    },
  });
}
