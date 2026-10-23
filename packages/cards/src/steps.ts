import { cardsFromOutput } from "./parse.js";
import type { Card } from "./types.js";

/**
 * What the agent did in a turn, read off its session stream.
 *
 * Every tool call already arrives on the stream a client reads: requested,
 * sometimes a partial, then a result. This turns those events into steps a
 * person can follow ("PostHog · Pageviews, visitors and signups, last 7
 * days") and collects the cards tools handed back. Both survive a reload,
 * because replaying a session from the start returns the same events.
 *
 * Pure and dependency-free so the desktop app, the phone and a bridge read a
 * stream the same way. Field names are the ones eve emits, verified against
 * recorded streams: a tool call carries `toolName`, a subagent or remote agent
 * call carries `name`, and a result carries its `callId` inside `result`.
 */

export type StepStatus = "running" | "done" | "failed" | "rejected";

export interface Step {
  callId: string;
  /** The tool's name as eve reports it, e.g. "arcana__arcana_recall". */
  tool: string;
  /** The short uppercase-able label before the line: "Memory", "Computer", "Gmail". */
  chip: string;
  /** One line of what it did. eve's own activity label when the tool defines one. */
  label: string;
  status: StepStatus;
  turnId?: string;
  /** Milliseconds since the epoch, from the event's `meta.at`. */
  at?: number;
  /** Cards the tool handed back, in the order they arrived. */
  cards: Card[];
}

export interface StepState {
  /** Steps by call id, in the order they were first seen. */
  steps: Map<string, Step>;
  /** Calls running as tasks: their result is a receipt, and they settle later. */
  tasks: Set<string>;
}

export const newStepState = (): StepState => ({ steps: new Map(), tasks: new Set() });

/** Tools that are plumbing, not work a person needs to see. */
const HIDDEN = new Set(["eve__search", "eve__skill", "load_skill", "connection_search", "show"]);
const hidden = (tool: string): boolean => HIDDEN.has(tool) || HIDDEN.has(tool.split("__").pop() ?? tool);

/** Chips for tools whose names do not say what they touch. Matched on the name's final segment. */
const CHIPS: Record<string, string> = {
  remember: "Memory",
  recall: "Memory",
  computer: "Computer",
  computer_use: "Computer",
  open_browser: "Computer",
  close_tabs: "Computer",
  show_screen: "Computer",
  pay_on_computer: "Payments",
  approve_spend_request: "Payments",
  create_spend_request: "Payments",
  list_vault: "Vault",
  fill_from_vault: "Vault",
  request_vault_item: "Vault",
  deliver: "Files",
  screenshot: "Browser",
  bash: "Workspace",
  read_file: "Workspace",
  write_file: "Workspace",
  edit_file: "Workspace",
  glob: "Workspace",
  grep: "Workspace",
  web_search: "Web",
  web_fetch: "Web",
  ask_question: "Question",
};

/** Namespaces that read better under another name. */
const NAMESPACES: Record<string, string> = {
  arcana: "Memory",
  memory: "Memory",
  github: "GitHub",
  posthog: "PostHog",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googleslides: "Google Slides",
  gcal: "Google Calendar",
};

const words = (s: string): string => s.replace(/[_-]+/g, " ").trim();
const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The chip for a tool name.
 *
 * In order: a known tool; the mount namespace (`ns__tool`); a connector
 * tool's service, which is the first word of a name like
 * `gmail_send_email`; otherwise "Tool". Matching is on the end of the name,
 * because a mount namespace can change the prefix.
 */
export function chipFor(tool: string, kind?: string): string {
  if (kind === "subagent-call" || kind === "remote-agent-call") return capital(words(tool));
  const parts = tool.split("__");
  const last = parts[parts.length - 1]!.toLowerCase();
  if (CHIPS[last]) return CHIPS[last]!;
  // Longest suffix first, so pay_on_computer is Payments, not Computer.
  const suffix = Object.keys(CHIPS)
    .sort((a, b) => b.length - a.length)
    .find((name) => last.endsWith(`_${name}`));
  if (suffix) return CHIPS[suffix]!;
  if (/^ask_[a-z0-9_]+$/.test(last)) return capital(words(last.slice(4)));
  if (parts.length > 1) {
    const ns = parts[0]!.toLowerCase();
    return NAMESPACES[ns] ?? capital(words(ns));
  }
  const segments = last.split("_");
  if (segments.length >= 3) return NAMESPACES[segments[0]!] ?? capital(segments[0]!);
  return "Tool";
}

/** A readable line from a tool name when eve sends no label: "gmail_send_email" → "Send email". */
export function labelFor(tool: string, chip: string): string {
  const last = tool.split("__").pop() ?? tool;
  let rest = words(last);
  const service = chip.toLowerCase();
  if (rest.toLowerCase().startsWith(`${service} `)) rest = rest.slice(service.length + 1);
  else {
    // A renamed service ("googlecalendar" shown as "Google Calendar") still leads the raw name.
    const raw = rest.split(" ")[0]!.toLowerCase();
    if (NAMESPACES[raw] === chip) rest = rest.slice(raw.length + 1);
  }
  return capital(rest) || capital(words(tool));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function presented(data: Obj, callId: string): string | undefined {
  const p = isObj(data.presentation) ? data.presentation[callId] : undefined;
  return isObj(p) ? text(p.label) : undefined;
}

/**
 * Feed one stream event. Returns the steps it changed, so a caller can update
 * only those; the full list is `state.steps`.
 */
export function readStep(state: StepState, type: string, data: unknown, meta?: { at?: unknown }): Step[] {
  if (!isObj(data)) return [];
  const at = typeof meta?.at === "string" ? Date.parse(meta.at) : undefined;
  const turnId = text(data.turnId);
  const changed: Step[] = [];

  if (type === "actions.requested" && Array.isArray(data.actions)) {
    for (const raw of data.actions) {
      if (!isObj(raw)) continue;
      const callId = text(raw.callId) ?? text(raw.id);
      const kind = text(raw.kind);
      // A tool called through eve's catalogue names the real tool in its input.
      const viaCatalogue = text(raw.toolName) === "eve__tool" && isObj(raw.input) ? text(raw.input.name) : undefined;
      const tool = viaCatalogue ?? text(raw.toolName) ?? text(raw.name);
      if (!callId || !tool || kind === "load-skill") continue;
      if (hidden(tool) && !viaCatalogue) continue;
      if (state.steps.has(callId)) continue;
      const chip = chipFor(tool, kind);
      const step: Step = {
        callId,
        tool,
        chip,
        label: presented(data, callId) ?? labelFor(tool, chip),
        status: "running",
        turnId,
        at,
        cards: [],
      };
      state.steps.set(callId, step);
      changed.push(step);
    }
    return changed;
  }

  if (type === "action.partial" || type === "action.result") {
    const result = isObj(data.result) ? data.result : {};
    const callId = text(result.callId) ?? text(data.callId) ?? text(data.actionId);
    if (!callId) return [];
    let step = state.steps.get(callId);
    const tool = text(result.toolName);
    if (!step) {
      // A result for a call this reader never saw requested: a `show` card, or a
      // replay window that starts mid-turn. Cards still count; a step for a
      // hidden tool does not.
      const cards = type === "action.result" ? cardsFromOutput(result.output) : [];
      if (!tool || (hidden(tool) && cards.length === 0)) return [];
      const chip = chipFor(tool);
      step = { callId, tool, chip, label: labelFor(tool, chip), status: "running", turnId, at, cards: [] };
      if (hidden(tool)) {
        // Hidden tools never show a step line, but their cards do; keep them on a step the client skips.
        step.status = "done";
        step.label = "";
      }
      state.steps.set(callId, step);
    }
    const label = presented(data, callId);
    if (label) step.label = label;
    if (type === "action.result") {
      const status = text(data.status);
      // A task's result is only a receipt; it settles later.
      if (!state.tasks.has(callId)) {
        step.status = status === "failed" ? "failed" : status === "rejected" ? "rejected" : "done";
      }
      if (step.cards.length === 0) step.cards = cardsFromOutput(result.output);
    }
    changed.push(step);
    return changed;
  }

  if (type === "task.started") {
    const callId = text(data.callId);
    if (callId) state.tasks.add(callId);
    return [];
  }

  if (type === "task.settled") {
    const callId = text(data.callId);
    const step = callId ? state.steps.get(callId) : undefined;
    if (!step) return [];
    const status = text(data.status);
    step.status = status === "completed" ? "done" : status === "cancelled" ? "rejected" : "failed";
    if (step.cards.length === 0) step.cards = cardsFromOutput(data.output);
    changed.push(step);
    return changed;
  }

  return [];
}

/** Steps a person should see as lines: hidden tools only ever contribute cards. */
export function visibleSteps(steps: Iterable<Step>): Step[] {
  return [...steps].filter((s) => s.label !== "");
}

/** Every card in these steps, in order, with a later card replacing an earlier one that has the same id. */
export function cardsOf(steps: Iterable<Step>): Card[] {
  const out: Card[] = [];
  for (const step of steps) {
    for (const card of step.cards) {
      const at = card.id ? out.findIndex((c) => c.id === card.id) : -1;
      if (at >= 0) out[at] = card;
      else out.push(card);
    }
  }
  return out;
}
