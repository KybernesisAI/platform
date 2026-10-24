import { approvalCard } from "./approval.js";
import { parseCardPrompt, parseMarkedPrompt, promptText } from "./asks.js";
import { HIDDEN_CARD_MAX } from "./hidden.js";
import { parseCard } from "./parse.js";
import { cardTitle } from "./text.js";
import type { ApprovalData, Card } from "./types.js";

/**
 * Questions carried inside chat text, and the answers that come back.
 *
 * A chat bridge can only post words, so an agent's question goes out as its
 * sentence and numbered options, with the question itself hidden in an HTML
 * comment after them, the same way a card is:
 *
 *     Send email · Gmail
 *     To: dana@example.com
 *     …
 *
 *     <!-- kyb:ask v1 {"requestId":"…","kind":"tool-approval",…} -->
 *
 * A client that knows the marker draws the question the way Studio does (the
 * email itself, the amount and merchant, the form's fields) with buttons. A
 * press answers as the person, as a reply to that question: a short line
 * anyone can read, with the structured answer hidden after it:
 *
 *     Approved
 *
 *     <!-- kyb:answer v1 {"requestId":"…","optionId":"approve"} -->
 *
 * The bridge accepts a carried answer only as a direct reply to a question it
 * posted, and only for a request still open, so a comment anyone could type
 * answers nothing the bridge did not ask.
 */

export const HIDDEN_ASK_OPEN = "<!-- kyb:ask v1 ";
export const HIDDEN_ANSWER_OPEN = "<!-- kyb:answer v1 ";
const HIDDEN_ASK = /<!-- kyb:ask v1 (\{[\s\S]*?\}) -->/g;
const HIDDEN_ANSWER = /<!-- kyb:answer v1 (\{[\s\S]*?\}) -->/g;

export interface AskOption {
  id: string;
  label: string;
  description?: string;
  style?: string;
}

/** What `[kyb:vault-item]` carries: a login, card or address the agent could not find. */
export interface VaultNeed {
  kind: string;
  site?: string;
  label?: string;
  reason?: string;
}

/** What `[kyb:spend-request]` carries: a purchase waiting for approval in Link. Amount in minor units. */
export interface SpendNeed {
  id: string;
  amount: number;
  currency: string;
  merchant?: string;
  merchant_url?: string;
  approval_url?: string;
}

/** One open question, as a client needs it to draw and answer it. */
export interface Ask {
  requestId: string;
  /** eve's kind: `question`, `tool-approval` or `session-limit`. */
  kind: string;
  /** The sentence for people, without any marker. */
  text: string;
  options?: AskOption[];
  allowFreeform?: boolean;
  /** An approval drawn as what it would do, a form, or any card a question carries. */
  card?: Card;
  vault?: VaultNeed;
  spend?: SpendNeed;
}

/** How a client answers one question. */
export interface AskAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

/** The parts of eve's `InputRequest` an ask is made from. */
export interface AskSource {
  requestId: string;
  kind?: string;
  prompt: string;
  options?: readonly { id: string; label: string; description?: string; style?: string }[];
  allowFreeform?: boolean;
  action?: { toolName?: string; input?: unknown };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

const drop = <T extends Obj>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

function vaultNeed(v: unknown): VaultNeed | undefined {
  if (!isObj(v) || !str(v.kind, 40)) return undefined;
  return drop({ kind: str(v.kind, 40)!, site: str(v.site, 500), label: str(v.label, 200), reason: str(v.reason, 1000) });
}

function spendNeed(v: unknown): SpendNeed | undefined {
  if (!isObj(v) || !str(v.id, 200) || typeof v.amount !== "number" || !Number.isFinite(v.amount) || !str(v.currency, 10)) return undefined;
  const url = (u: unknown) => (typeof u === "string" && /^https:\/\//i.test(u) ? u.slice(0, 2000) : undefined);
  return drop({
    id: str(v.id, 200)!,
    amount: v.amount,
    currency: str(v.currency, 10)!,
    merchant: str(v.merchant, 200),
    merchant_url: url(v.merchant_url),
    approval_url: url(v.approval_url),
  });
}

/** An open request as the ask a client draws: the approval's card, the form, the purchase or the vault need. */
export function askFrom(request: AskSource): Ask {
  const ask: Ask = {
    requestId: request.requestId,
    kind: request.kind ?? "question",
    text: promptText(request.prompt),
    options: request.options?.length ? request.options.map((o) => drop({ id: o.id, label: o.label, description: o.description, style: o.style })) : undefined,
    allowFreeform: request.allowFreeform === true ? true : undefined,
  };
  const tool = request.action?.toolName;
  if (ask.kind === "tool-approval" && tool) {
    ask.card = approvalCard(tool, request.action?.input, request.requestId) ?? undefined;
  } else {
    const carried = parseCardPrompt(request.prompt);
    if (carried) {
      ask.card = carried.card;
    } else {
      const marked = parseMarkedPrompt(request.prompt);
      if (marked?.marker === "vault-item") ask.vault = vaultNeed(marked.payload);
      if (marked?.marker === "spend-request") ask.spend = spendNeed(marked.payload);
    }
  }
  return drop(ask as unknown as Obj) as unknown as Ask;
}

/** A comment's JSON: `--` only ever appears inside a JSON string, where `-` reads back as `-`. */
const commentJson = (v: unknown): string => JSON.stringify(v).replace(/--/g, "-\\u002d");

/**
 * The comment that carries `ask`. A card too large to carry is left out, and
 * the client draws the question from its sentence and options, which the
 * visible text repeats in full.
 */
export function hiddenAsk(ask: Ask): string | null {
  let json = commentJson(ask);
  if (json.length > HIDDEN_CARD_MAX && ask.card) {
    const { card: _card, ...rest } = ask;
    json = commentJson(rest);
  }
  return json.length > HIDDEN_CARD_MAX ? null : `${HIDDEN_ASK_OPEN}${json} -->`;
}

function readAsk(v: unknown): Ask | null {
  if (!isObj(v) || !str(v.requestId, 200) || typeof v.text !== "string") return null;
  const options = Array.isArray(v.options)
    ? v.options.flatMap((o) => (isObj(o) && str(o.id, 200) && str(o.label, 500) ? [drop({ id: str(o.id, 200)!, label: str(o.label, 500)!, description: str(o.description, 1000), style: str(o.style, 40) })] : []))
    : [];
  return drop({
    requestId: str(v.requestId, 200)!,
    kind: str(v.kind, 40) ?? "question",
    text: v.text.slice(0, 8000),
    options: options.length ? options : undefined,
    allowFreeform: v.allowFreeform === true ? true : undefined,
    // Through the same parser any card goes through.
    card: isObj(v.card) ? (parseCard(v.card) ?? undefined) : undefined,
    vault: vaultNeed(v.vault),
    spend: spendNeed(v.spend),
  } as Obj) as unknown as Ask;
}

/** Every question hidden in `content`, in order. */
export function readHiddenAsks(content: string): Ask[] {
  if (!content.includes(HIDDEN_ASK_OPEN)) return [];
  const out: Ask[] = [];
  for (const m of content.matchAll(HIDDEN_ASK)) {
    try {
      const ask = readAsk(JSON.parse(m[1]!));
      if (ask) out.push(ask);
    } catch {
      // Damaged in transit: the words around it still read.
    }
  }
  return out;
}

/** The longest typed answer a carried answer keeps. */
export const ANSWER_TEXT_MAX = 8_000;

/** One reply answering a question: `label` for people, the answer hidden after it. */
export function answerMessage(answer: AskAnswer, label: string): string {
  const carried: AskAnswer = { requestId: answer.requestId };
  if (answer.optionId) carried.optionId = answer.optionId;
  if (answer.text !== undefined) carried.text = answer.text.slice(0, ANSWER_TEXT_MAX);
  const words = label.trim() || "Answered";
  return `${words}\n\n${HIDDEN_ANSWER_OPEN}${commentJson(carried)} -->`;
}

/** Every answer hidden in `content`. Comments that are not answers are skipped. */
export function readHiddenAnswers(content: string): AskAnswer[] {
  if (!content.includes(HIDDEN_ANSWER_OPEN)) return [];
  const out: AskAnswer[] = [];
  for (const m of content.matchAll(HIDDEN_ANSWER)) {
    try {
      const v: unknown = JSON.parse(m[1]!);
      if (!isObj(v) || !str(v.requestId, 200)) continue;
      const answer: AskAnswer = { requestId: str(v.requestId, 200)! };
      if (str(v.optionId, 200)) answer.optionId = str(v.optionId, 200);
      if (typeof v.text === "string") answer.text = v.text.slice(0, ANSWER_TEXT_MAX);
      if (answer.optionId || answer.text !== undefined) out.push(answer);
    } catch {
      // Not an answer.
    }
  }
  return out;
}

/** `content` without hidden questions and answers, for surfaces that show raw text. */
export function withoutHiddenAsks(content: string): string {
  return content.replace(HIDDEN_ASK, "").replace(HIDDEN_ANSWER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The longest email or message body a text-only channel shows in an approval. */
const BODY_MAX = 4_000;

/**
 * The question as a person reads it on a text-only channel.
 *
 * An approval reads as what it would do, the whole email rather than "Allow
 * gmail send email?", so nobody approves a message they could not read. Other
 * questions read as their sentence.
 */
export function askText(ask: Ask): string {
  const c = ask.card;
  if (c?.card === "approval") {
    const d = c.data as ApprovalData;
    const body = d.body && d.body.length > BODY_MAX ? `${d.body.slice(0, BODY_MAX - 1)}…` : d.body;
    return [
      cardTitle(c) ?? d.action,
      ...(d.to?.length ? [`To: ${d.to.join(", ")}`] : []),
      ...(d.cc?.length ? [`Cc: ${d.cc.join(", ")}`] : []),
      ...(d.channel ? [`In: ${d.channel}`] : []),
      ...(d.subject ? [d.kind === "event" ? `Event: ${d.subject}` : `Subject: ${d.subject}`] : []),
      ...(d.when ? [`When: ${d.when}${d.until ? ` to ${d.until}` : ""}`] : []),
      ...(d.where ? [`Where: ${d.where}`] : []),
      ...(d.people?.length ? [`With: ${d.people.join(", ")}`] : []),
      ...(d.fields ?? []).map((f) => `${f.label}: ${f.value}`),
      ...(body ? ["", body] : []),
    ].join("\n");
  }
  return ask.text;
}
