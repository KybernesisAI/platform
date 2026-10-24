import { card } from "./build.js";
import { cardPrompt } from "./asks.js";
import { parseCard } from "./parse.js";
import type { Card, FormData, FormField } from "./types.js";

/**
 * Cards a client can make itself, from what a tool was asked and what it said.
 *
 * Some tools are not ours to change: memory is a remote server, a pull request
 * is opened through a GitHub connector, an approval is eve's own question. The
 * stream still carries the tool's name, its input and its result, which is
 * everything the card needs. These read those, and return nothing for a call
 * they do not recognise, so a client can run every finished step through them.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const last = (tool: string): string => (tool.split("__").pop() ?? tool).toLowerCase();

/** A tool's output as an object: plain, a JSON string, or an MCP result whose first text part is JSON. */
export function outputObject(output: unknown): Obj | undefined {
  const parse = (s: string): Obj | undefined => {
    const t = s.trim();
    if (!t.startsWith("{")) return undefined;
    try {
      const v: unknown = JSON.parse(t);
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  if (typeof output === "string") return parse(output);
  if (!isObj(output)) return undefined;
  if (Array.isArray(output.content)) {
    for (const part of output.content) {
      if (isObj(part) && part.type === "text" && typeof part.text === "string") {
        const inner = parse(part.text);
        if (inner) return inner;
      }
    }
  }
  if (isObj(output.structuredContent)) return output.structuredContent;
  return output;
}

const REMEMBER = /(^|_)(remember|add_memory)$/;
const PULL_REQUEST = /(^|_)(create|open)_(a_)?(pull_request|pr)$/;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** What a memory save stored, as a remembered card. */
function remembered(input: unknown): Card | null {
  if (!isObj(input)) return null;
  const fact = text(input.text) ?? text(input.content) ?? text(input.fact) ?? text(input.memory);
  if (!fact) return null;
  const short = fact.length > 400 ? `${fact.slice(0, 399)}…` : fact;
  return card(
    "remembered",
    { fact: short },
    {
      source: "Memory",
      actions: [
        { label: "Correct it", say: `That's not quite right. You remembered: "${short}". Ask me what to change.` },
        { label: "Forget it", say: `Please forget this, it's no longer true: "${short}"` },
      ],
    },
  );
}

/**
 * The API object inside a connector's answer.
 *
 * A broker wraps what GitHub returned: `{ data: {...}, successful }`, sometimes
 * one level deeper under `response_data`. The pull request is the first level
 * that has its address.
 */
function unwrapped(output: unknown): Obj | undefined {
  let o = outputObject(output);
  for (let i = 0; o && i < 3; i++) {
    if (text(o.html_url) ?? text(o.url)) return o;
    const inner = isObj(o.data) ? o.data : isObj(o.response_data) ? o.response_data : typeof o.data === "string" ? outputObject(o.data) : undefined;
    if (!inner) return o;
    o = inner;
  }
  return o;
}

/** A pull request a connector opened, from the API object it returned. */
function pullRequest(input: unknown, output: unknown): Card | null {
  const pr = unwrapped(output);
  if (!pr) return null;
  const url = text(pr.html_url) ?? text(pr.url);
  const m = url ? PR_URL.exec(url) : null;
  if (!url || !m) return null;
  const number = typeof pr.number === "number" ? pr.number : Number(m[2]);
  const title = text(pr.title) ?? (isObj(input) ? text(input.title) : undefined);
  if (!title) return null;
  const body = text(pr.body) ?? (isObj(input) ? text(input.body) : undefined);
  const summary = body?.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").slice(0, 300);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return card(
    "pull-request",
    { repo: m[1]!, number, title, url, summary, additions: num(pr.additions), deletions: num(pr.deletions) },
    { source: "GitHub", actions: [{ label: "Review", url: `${url}/files`, primary: true }] },
  );
}

/**
 * Cards for a finished tool call the tool did not make itself.
 *
 * Only for a call that succeeded: a failed save remembered nothing.
 */
export function derivedCards(tool: string, input: unknown, output: unknown): Card[] {
  const name = last(tool);
  const made = REMEMBER.test(name) ? remembered(input) : PULL_REQUEST.test(name) ? pullRequest(input, output) : null;
  return made ? [made] : [];
}

// --------------------------------------------------------------------- forms

/** A question with fields, for a tool to pass to `ctx.ask`. The sentence is what text-only channels show. */
export function formPrompt(fields: FormField[], sentence: string, options: { title?: string; submit?: string } = {}): string {
  const data: FormData = { fields, ...(options.submit ? { submit: options.submit } : {}) };
  const made = parseCard(card("form", data, options.title ? { title: options.title } : {}));
  if (!made || made.card !== "form") throw new Error("A form needs at least one field with an id and a label.");
  return cardPrompt(made, sentence);
}

const FORM_ANSWER = "[kyb:form]";

/** How a client answers a form: one line a person could read, with the values after the marker. */
export function formAnswer(values: Record<string, string>): string {
  return `${FORM_ANSWER} ${JSON.stringify(values)}`;
}

/**
 * A form's answer, read back by the tool that asked.
 *
 * A client sends `formAnswer`; a person on a text channel types whatever they
 * like, which comes back as `text` for the model to read.
 */
export function readFormAnswer(answer: string): { values: Record<string, string> } | { text: string } {
  const t = answer.trim();
  if (t.startsWith(FORM_ANSWER)) {
    try {
      const v: unknown = JSON.parse(t.slice(FORM_ANSWER.length).trim());
      if (isObj(v)) {
        const values: Record<string, string> = {};
        for (const [k, x] of Object.entries(v)) if (typeof x === "string") values[k] = x.slice(0, 4000);
        return { values };
      }
    } catch {
      // Fall through: treat it as words.
    }
  }
  return { text: t };
}
