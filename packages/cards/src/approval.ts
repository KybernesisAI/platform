import { card } from "./build.js";
import { parseCard } from "./parse.js";
import { chipFor, labelFor } from "./steps.js";
import type { ApprovalData, Card } from "./types.js";

/**
 * Approvals drawn as the thing they would do.
 *
 * eve's approval request carries the tool's name and its real input, so a
 * client can show the email instead of "Allow gmail send?".
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const last = (tool: string): string => (tool.split("__").pop() ?? tool).toLowerCase();

const list = (v: unknown): string[] | undefined => {
  if (typeof v === "string") {
    const parts = v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const parts = v.flatMap((x) => (typeof x === "string" ? x.trim() || [] : isObj(x) ? (text(x.email) ?? text(x.address) ?? text(x.name) ?? []) : []));
  return parts.length ? parts : undefined;
};

const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};

/** A time as a tool gave it: a string, or Google's `{dateTime}` / `{date}`. */
const when = (v: unknown): string | undefined => (isObj(v) ? (text(v.dateTime) ?? text(v.date)) : text(v));

const EMAIL = /(send|reply|forward)_?(an_)?(email|mail|message|draft)?$|(create|save)_?(email_)?draft$|send_email|send_mail/;
const EVENT = /(create|update|add|insert|quick_add)_?(calendar_)?event$/;
const MESSAGE = /(send|post)_?(chat_|channel_|slack_)?message$/;
const SECRET = /pass(word)?|secret|token|api_?key|cvc|card_?number|credential/i;

/**
 * An event's end from its start and a length, for tools that take
 * `event_duration_hour` / `event_duration_minutes` instead of an end time.
 * Kept in the start's own form, so a wall-clock time stays one.
 */
function endFromDuration(o: Obj): string | undefined {
  const start = when(pick(o, "start", "start_time", "startTime", "start_datetime"));
  const hours = Number(pick(o, "event_duration_hour", "duration_hours") ?? 0);
  const minutes = Number(pick(o, "event_duration_minutes", "duration_minutes") ?? 0);
  const length = (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  if (!start || length <= 0) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(.*)$/.exec(start);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec, zone] = m;
  const t = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi! + length, +(sec ?? 0)));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}${sec !== undefined ? `:${p(t.getUTCSeconds())}` : ""}${zone ?? ""}`;
}

function readable(v: unknown): string | undefined {
  if (typeof v === "string") return text(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ") || undefined;
  return undefined;
}

/** Up to eight of the input's plain values, for an action the reader has no special view of. */
function fieldsOf(input: Obj): ApprovalData["fields"] {
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (out.length >= 8) break;
    if (SECRET.test(k)) continue;
    const value = readable(v);
    if (!value) continue;
    out.push({ label: k.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()), value: value.length > 300 ? `${value.slice(0, 299)}…` : value });
  }
  return out.length ? out : undefined;
}

/**
 * An approval request drawn as the thing it would do.
 *
 * `tool` and `input` are the approval's own, from eve's `input.requested`
 * event (`action.toolName`, `action.input`). An email shows who it goes to,
 * the subject and the body; an event its time, place and guests; anything
 * else its plain inputs. Values that look like secrets are never shown.
 */
export function approvalCard(tool: string, input: unknown, id?: string): Card | null {
  const name = last(tool);
  if (!name) return null;
  const service = chipFor(tool);
  const o = isObj(input) ? input : {};
  const base = { tool, service: service === "Tool" ? undefined : service };
  let data: ApprovalData;
  if (EMAIL.test(name) && (pick(o, "to", "recipient", "recipients", "recipient_email", "to_email") !== undefined || pick(o, "subject") !== undefined)) {
    data = {
      ...base,
      kind: "email",
      action: /draft/.test(name) ? "Save draft" : /reply/.test(name) ? "Send reply" : /forward/.test(name) ? "Forward email" : "Send email",
      to: list(pick(o, "to", "recipient", "recipients", "recipient_email", "to_email")),
      cc: list(pick(o, "cc", "cc_email")),
      subject: text(pick(o, "subject")),
      body: text(pick(o, "body", "message_body", "text", "body_text", "plain_text", "content", "message")),
    };
  } else if (EVENT.test(name)) {
    data = {
      ...base,
      kind: "event",
      action: /update/.test(name) ? "Change event" : "Create event",
      subject: text(pick(o, "summary", "title", "name", "text")),
      when: when(pick(o, "start", "start_time", "startTime", "start_datetime", "when")),
      until: when(pick(o, "end", "end_time", "endTime", "end_datetime")) ?? endFromDuration(o),
      where: text(pick(o, "location", "where")),
      people: list(pick(o, "attendees", "guests", "invitees")),
      body: text(pick(o, "description")),
    };
  } else if (MESSAGE.test(name)) {
    data = {
      ...base,
      kind: "message",
      action: "Send message",
      channel: text(pick(o, "channel", "channel_name", "channel_id", "conversation")),
      to: list(pick(o, "to", "user", "recipient")),
      body: text(pick(o, "text", "message", "body", "content", "markdown_text")),
    };
  } else {
    data = { ...base, kind: "action", action: labelFor(tool, service), fields: fieldsOf(o) };
  }
  // Through the parser, so what the client draws is what any other card would be.
  return parseCard(card("approval", data, id ? { id } : {}));
}
