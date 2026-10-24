import { cardTitle, formAnswer, isKnownCard, money, settledLabel, settledLine, type Ask, type ApprovalData, type FormData, type FormField } from "@kybernesis/cards";
import { type ReactNode, useState } from "react";
import { ApprovalBody, CardView, type CardContext } from "./CardView.js";

/**
 * A question the agent is waiting on, drawn as what it asks.
 *
 * An approval shows the email, event or message it would send, with Send it,
 * Edit and Don't send. A purchase shows the amount and merchant and opens Link.
 * A form shows its fields. Anything else shows its sentence, its options as
 * buttons and, when it takes words, a box to type them. The host sends the
 * answer the way it answers anything (`onAnswer`); a pressed question then
 * shows what was said, so it is still on record.
 *
 * In a shared conversation a question can be someone else's. `waitingOn`
 * draws it without buttons, saying whose answer it waits for, and a question
 * that carries `settled` shows how it ended for everyone who sees it.
 */

export interface AskReply {
  optionId?: string;
  text?: string;
  /** What the answer said, in words, for the conversation. */
  label: string;
}

export interface AskViewProps {
  ask: Ask;
  ctx: CardContext;
  /** How it was answered, once it was. */
  answered?: AskReply;
  /** Why the last answer did not go, shown under the buttons. */
  error?: string;
  /** True while an answer is on its way. */
  sending?: boolean;
  /** Someone else's question: drawn without buttons, waiting on this name. */
  waitingOn?: string;
  onAnswer(reply: AskReply): void;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Done({ title, label, good, detail }: { title: string; label: string; good: boolean; detail?: string }): ReactNode {
  return (
    <div className="kcard kask is-done">
      <div className="kcard__head">
        <span className="kcard__title">{title}</span>
        <span className={`kpill${good ? " is-good" : ""}`}>{label}</span>
      </div>
      {detail ? <div className="kcard__text">{detail}</div> : null}
    </div>
  );
}

function Status({ error, sending }: { error?: string; sending?: boolean }): ReactNode {
  if (error) return <div className="kask__error">{error}</div>;
  if (sending) return <div className="kask__note">Sending…</div>;
  return null;
}

function ApprovalAsk({ ask, data, title, props }: { ask: Ask; data: ApprovalData; title: string; props: AskViewProps }): ReactNode {
  const editable = data.kind !== "action" && (data.subject !== undefined || data.body !== undefined);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(data.subject ?? "");
  const [body, setBody] = useState(data.body ?? "");
  const sends = data.kind === "email" || data.kind === "message";
  const approve = ask.options?.find((o) => o.id === "approve") ? "approve" : ask.options?.[0]?.id ?? "approve";
  const busy = props.sending === true;

  const sendBack = (): void => {
    const lines = ["Not as written. Make it again with these changes, then ask me again."];
    if (subject.trim() !== (data.subject ?? "")) lines.push(`${data.kind === "event" ? "Title" : "Subject"}: ${subject.trim()}`);
    if (body !== (data.body ?? "")) lines.push(`${data.kind === "event" ? "Description" : "Body"}:\n${body.trim()}`);
    props.onAnswer({ optionId: "cancel", text: lines.join("\n"), label: "Sent back with changes" });
  };

  return (
    <div className="kcard kcard--approval kask">
      <div className="kcard__head">
        <span className="kcard__title">{title}</span>
        {data.service ? <span className="klabel kcard__source">{data.service}</span> : null}
      </div>
      {editing ? (
        <div className="kform">
          {data.subject !== undefined ? (
            <label className="kform__field">
              <span className="klabel">{data.kind === "event" ? "Event" : "Subject"}</span>
              <input className="kinput" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
          ) : null}
          <label className="kform__field">
            <span className="klabel">{data.kind === "event" ? "Description" : "Message"}</span>
            <textarea className="kinput kinput--long" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
      ) : (
        <ApprovalBody data={data} />
      )}
      <div className="kcard__actions">
        {editing ? (
          <>
            <button type="button" className="kbtn kbtn--primary" disabled={busy} onClick={sendBack}>
              Send back with changes
            </button>
            <button type="button" className="kbtn" disabled={busy} onClick={() => setEditing(false)}>
              Never mind
            </button>
          </>
        ) : (
          <>
            <button type="button" className="kbtn kbtn--primary" disabled={busy} onClick={() => props.onAnswer({ optionId: approve, label: "Approved" })}>
              {sends ? (data.action === "Save draft" ? "Save it" : "Send it") : "Approve"}
            </button>
            {editable ? (
              <button type="button" className="kbtn" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            <button type="button" className="kbtn" disabled={busy} onClick={() => props.onAnswer({ optionId: "cancel", label: "Declined" })}>
              {sends ? "Don't send" : "Decline"}
            </button>
          </>
        )}
      </div>
      <Status error={props.error} sending={props.sending} />
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange(v: string): void }): ReactNode {
  if (field.kind === "long") {
    return <textarea className="kinput kinput--long" rows={4} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.kind === "choice" && field.options?.length) {
    return (
      <div className="kform__choices">
        {field.options.map((o) => (
          <button key={o} type="button" className={`kbtn${value === o ? " kbtn--primary" : ""}`} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    );
  }
  const type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : field.kind === "email" ? "email" : "text";
  return <input className="kinput" type={type} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function FormAsk({ ask, data, title, props }: { ask: Ask; data: FormData; title?: string; props: AskViewProps }): ReactNode {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.fields.map((f) => [f.id, f.value ?? ""])));
  const missing = data.fields.some((f) => f.required && !values[f.id]?.trim());
  const cancel = ask.options?.find((o) => o.id === "cancel");
  const busy = props.sending === true;

  const submit = (): void => {
    const filled = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const summary = data.fields.filter((f) => filled[f.id]).map((f) => `${f.label}: ${filled[f.id]}`).join("\n");
    props.onAnswer({ text: formAnswer(filled), label: summary || "Sent" });
  };

  return (
    <div className="kcard kcard--form kask">
      <div className="kcard__head">
        <span className="kcard__title">{title ?? "A few details"}</span>
        <span className="klabel kcard__source">Question</span>
      </div>
      {ask.text ? <div className="kask__text">{ask.text}</div> : null}
      <div className="kform">
        {data.fields.map((f) => (
          <label key={f.id} className="kform__field">
            <span className="klabel">
              {f.label}
              {f.required ? " *" : ""}
            </span>
            <FieldInput field={f} value={values[f.id] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))} />
          </label>
        ))}
      </div>
      <div className="kcard__actions">
        <button type="button" className="kbtn kbtn--primary" disabled={missing || busy} onClick={submit}>
          {data.submit ?? "Send"}
        </button>
        {cancel ? (
          <button type="button" className="kbtn" disabled={busy} onClick={() => props.onAnswer({ optionId: cancel.id, label: cancel.label })}>
            {cancel.label}
          </button>
        ) : null}
      </div>
      <Status error={props.error} sending={props.sending} />
    </div>
  );
}

/** The options as buttons and, when the question takes words, a box for them. */
function Choices({ ask, props, skip = [] }: { ask: Ask; props: AskViewProps; skip?: string[] }): ReactNode {
  const [words, setWords] = useState("");
  const options = ask.options?.filter((o) => !skip.includes(o.id)) ?? [];
  const typed = ask.allowFreeform === true || !ask.options?.length;
  const busy = props.sending === true;
  return (
    <>
      {options.length ? (
        <div className="kcard__actions">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              title={o.description}
              className={`kbtn${o.style === "primary" || (i === 0 && ask.kind === "tool-approval") ? " kbtn--primary" : ""}`}
              disabled={busy}
              onClick={() => props.onAnswer({ optionId: o.id, label: o.label })}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {typed ? (
        <form
          className="kask__typed"
          onSubmit={(e) => {
            e.preventDefault();
            const t = words.trim();
            if (t) props.onAnswer({ text: t, label: t });
          }}
        >
          <input className="kinput" value={words} placeholder="Your answer" onChange={(e) => setWords(e.target.value)} />
          <button type="submit" className="kbtn" disabled={busy || !words.trim()}>
            Send
          </button>
        </form>
      ) : null}
      <Status error={props.error} sending={props.sending} />
    </>
  );
}

function outcome(reply: AskReply): { label: string; good: boolean } {
  if (reply.optionId === "cancel") return { label: /changes/i.test(reply.label) ? "Sent back" : "Declined", good: false };
  return { label: reply.optionId === "approve" || reply.optionId === "approved" ? "Approved" : "Answered", good: true };
}

function askTitle(ask: Ask): string {
  const card = ask.card && isKnownCard(ask.card) ? ask.card : undefined;
  if (card?.card === "approval") return cardTitle(card) ?? card.data.action;
  if (card?.card === "form") return card.title ?? "A few details";
  if (ask.spend) return "Purchase approval";
  return ask.text.split("\n")[0]!.slice(0, 120) || "Question";
}

/** What the question asks, without anything to press: the email, the amount, or the sentence. */
function AskBody({ ask }: { ask: Ask }): ReactNode {
  const card = ask.card && isKnownCard(ask.card) ? ask.card : undefined;
  if (card?.card === "approval") return <ApprovalBody data={card.data} />;
  if (ask.spend) {
    const s = ask.spend;
    return (
      <div className="kask__amount">
        <span className="kask__total">{money(s.amount, s.currency)}</span>
        <span className="kask__note">at {s.merchant ?? (s.merchant_url ? host(s.merchant_url) : "a merchant")}</span>
      </div>
    );
  }
  return ask.text ? <div className="kask__text">{ask.text}</div> : null;
}

/** A question answered or let go, as everyone in the conversation sees it. */
function Settled({ ask }: { ask: Ask }): ReactNode {
  const outcome = ask.settled!.outcome;
  const good = outcome === "approved" || outcome === "answered";
  const card = ask.card && isKnownCard(ask.card) ? ask.card : undefined;
  return (
    <div className="kcard kask is-done">
      <div className="kcard__head">
        <span className="kcard__title">{askTitle(ask)}</span>
        <span className={`kpill${good ? " is-good" : ""}`}>{settledLabel(ask)}</span>
      </div>
      {card?.card === "approval" && card.data.subject ? <div className="kcard__text">{card.data.subject}</div> : null}
      <div className="kask__note">{settledLine(ask)}</div>
    </div>
  );
}

/** Someone else's question, open: what it asks, and whose answer it waits for. */
function Waiting({ ask, name }: { ask: Ask; name: string }): ReactNode {
  return (
    <div className="kcard kask">
      <div className="kcard__head">
        <span className="kcard__title">{askTitle(ask)}</span>
        <span className="kpill">Waiting on {name}</span>
      </div>
      <AskBody ask={ask} />
    </div>
  );
}

export function AskView(props: AskViewProps): ReactNode {
  const { ask, ctx, answered } = props;
  const card = ask.card && isKnownCard(ask.card) ? ask.card : undefined;

  if (ask.settled) return <Settled ask={ask} />;
  if (props.waitingOn && !answered) return <Waiting ask={ask} name={props.waitingOn} />;

  if (card?.card === "approval") {
    const title = cardTitle(card) ?? card.data.action;
    if (answered) {
      const o = outcome(answered);
      return <Done title={title} label={o.label} good={o.good} detail={card.data.subject} />;
    }
    return <ApprovalAsk ask={ask} data={card.data} title={title} props={props} />;
  }

  if (card?.card === "form") {
    if (answered) {
      const skipped = answered.optionId === "cancel";
      return <Done title={card.title ?? "Your answers"} label={skipped ? "Skipped" : "Sent"} good={!skipped} detail={skipped ? undefined : answered.label} />;
    }
    return <FormAsk ask={ask} data={card.data} title={card.title} props={props} />;
  }

  if (ask.spend) {
    const s = ask.spend;
    const merchant = s.merchant ?? (s.merchant_url ? host(s.merchant_url) : "a merchant");
    if (answered) {
      const cancelled = answered.optionId === "cancel";
      return <Done title="Purchase approval" label={cancelled ? "Cancelled" : "Approved"} good={!cancelled} detail={`${money(s.amount, s.currency)} at ${merchant}`} />;
    }
    return (
      <div className="kcard kcard--spend kask">
        <div className="kcard__head">
          <span className="kcard__title">Purchase approval</span>
          <span className="klabel kcard__source">Link</span>
        </div>
        <div className="kask__amount">
          <span className="kask__total">{money(s.amount, s.currency)}</span>
          <span className="kask__note">
            at {merchant}
            {s.merchant_url && s.merchant ? <> · {host(s.merchant_url)}</> : null}
          </span>
        </div>
        {s.approval_url ? (
          <div className="kcard__actions">
            <button type="button" className="kbtn kbtn--primary" onClick={() => ctx.openUrl(s.approval_url!)}>
              Approve in Link
            </button>
          </div>
        ) : null}
        <Choices ask={ask} props={props} />
        <div className="kask__note">Approving in Link issues a one-time card for exactly this amount. The agent checks with Link before paying.</div>
      </div>
    );
  }

  if (ask.vault) {
    const v = ask.vault;
    const what = v.kind === "login" ? "a login" : v.kind === "card" ? "a card" : v.kind === "address" ? "an address" : "contact details";
    if (answered) return <Done title={`Needs ${what}`} label={answered.optionId === "cancel" ? "Cancelled" : "Answered"} good={answered.optionId !== "cancel"} />;
    return (
      <div className="kcard kcard--vault kask">
        <div className="kcard__head">
          <span className="kcard__title">
            Needs {what}
            {v.site ? <> for {host(v.site)}</> : null}
          </span>
          <span className="klabel kcard__source">Vault</span>
        </div>
        {v.reason ? <div className="kask__text">{v.reason}</div> : ask.text ? <div className="kask__text">{ask.text}</div> : null}
        <div className="kask__note">Add it to your vault in KYBER Studio. Never type a password or card number in a conversation.</div>
        <Choices ask={{ ...ask, allowFreeform: false }} props={props} />
      </div>
    );
  }

  // Any other question: its card, if it carries one, then its sentence and options.
  if (answered) return <Done title={ask.text.split("\n")[0]!.slice(0, 120) || "Question"} label="Answered" good detail={answered.label} />;
  return (
    <div className="kask-stack">
      {ask.card ? <CardView card={ask.card} ctx={ctx} /> : null}
      <div className="kcard kask">
        <div className="kask__text">{ask.text}</div>
        <Choices ask={ask} props={props} />
      </div>
    </div>
  );
}
