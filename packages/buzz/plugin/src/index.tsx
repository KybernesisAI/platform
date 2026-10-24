import type { Context } from "@buzz/author";
import { answerMessage, HIDDEN_ASK_OPEN, HIDDEN_CARD_OPEN, readHiddenAsks, readHiddenCards, type Ask, type Card } from "@kybernesis/cards";
import { AskView, CardStack, cardStyles, type AskReply, type CardContext } from "@kybernesis/cards-react";
import { bindReact, useEffect, useRef, useState } from "./react.js";

/**
 * Kybernesis cards in Buzz.
 *
 * A Kybernesis agent's bridge posts each card a tool handed back as its own
 * message: the card's text for people, and the card itself in an HTML comment
 * Buzz hides. This plugin draws those messages as the card. The agent's reply
 * above them stays an ordinary message, drawn by Buzz.
 *
 * An artifact the agent shared into the channel carries a share link. On the
 * desktop app the page is drawn inside its card by Buzz's own browser view,
 * and Open puts it beside the conversation.
 *
 * A question the agent is waiting on travels the same way. The plugin draws
 * it as Studio does (an approval as the email it would send, a purchase with
 * its amount, a form with its fields) and a press answers it as the person:
 * a reply to the question, with a line anyone can read and the answer hidden
 * after it. The bridge takes it exactly as it takes a typed reply.
 *
 * Without the plugin, or if it fails, people read the text: nothing is lost.
 */

export const inject = ["react", "conversation", "panels", "browser", "relay"];

type Message = { id: string; channelId: string; authorId: string; content: string; threadRootId?: string };
type Opener = { canOpen(target: string): boolean; open(target: string): boolean };

/** Messages are frozen and long-lived, so a parse per message object is enough. */
const parsed = new WeakMap<object, Card[]>();

function cardsIn(message: Message): Card[] {
  let cards = parsed.get(message);
  if (!cards) {
    cards = message.content.includes(HIDDEN_CARD_OPEN) ? readHiddenCards(message.content) : [];
    parsed.set(message, cards);
  }
  return cards;
}

const parsedAsks = new WeakMap<object, Ask[]>();

function asksIn(message: Message): Ask[] {
  let asks = parsedAsks.get(message);
  if (!asks) {
    asks = message.content.includes(HIDDEN_ASK_OPEN) ? readHiddenAsks(message.content) : [];
    parsedAsks.set(message, asks);
  }
  return asks;
}

/**
 * What this person already answered, so a question they pressed shows its
 * outcome after the conversation scrolls away or the app restarts. Only on
 * this device; it is a reminder, not the record (the reply is).
 */
const ANSWERED_KEY = "kybernesis.cards.answered.v1";
const ANSWERED_MAX = 200;

function answeredStore(): Record<string, AskReply> {
  try {
    const raw = localStorage.getItem(ANSWERED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" ? (value as Record<string, AskReply>) : {};
  } catch {
    return {};
  }
}

function remember(key: string, reply: AskReply): void {
  try {
    const all = { ...answeredStore(), [key]: { optionId: reply.optionId, label: reply.label.slice(0, 500) } };
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - ANSWERED_MAX))) delete all[old];
    localStorage.setItem(ANSWERED_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the outcome lasts as long as the message is on screen.
  }
}

/** An artifact page the agent shared, at its share route. */
const SHARED_PATH = "/eve/v1/kyb/artifact-shares/";

function isSharedPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && parsedUrl.pathname.includes(SHARED_PATH);
  } catch {
    return false;
  }
}

/** One website storage for every shared page, so a page scrolled away and back keeps its session. */
const STORAGE = "kybernesis-artifacts";

/** The conversation's scrolling list, which the page must sit wholly inside. */
function scrollRoot(element: HTMLElement): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent;
  }
  return null;
}

/** Buzz's theme, mapped onto the cards' variables. */
const THEME = `
.kyb-buzz {
  --kyb-ink: var(--text-color-primary, #16181d);
  --kyb-ink-secondary: var(--text-color-secondary, #5c6270);
  --kyb-ink-tertiary: var(--text-color-tertiary, #8b91a0);
  --kyb-ink-inverse: var(--text-color-inverse, #ffffff);
  --kyb-surface: var(--surface-base, #ffffff);
  --kyb-surface-raised: var(--surface-popover, #ffffff);
  --kyb-stroke: var(--border-color-standard, rgba(22, 24, 29, 0.09));
  --kyb-stroke-strong: var(--border-color-prominent, rgba(22, 24, 29, 0.16));
  --kyb-hover: color-mix(in srgb, var(--text-color-primary, #16181d) 5%, transparent);
  --kyb-selected: color-mix(in srgb, var(--text-color-primary, #16181d) 9%, transparent);
  --kyb-good: var(--text-color-success, #15803d);
  --kyb-bad: var(--text-color-danger, #dc2626);
  --kyb-font-label: var(--font-mono, ui-monospace, monospace);
  --kyb-font-mono: var(--font-mono, ui-monospace, monospace);
  /* A message sizes to its content; a card is one width, like Buzz's own wide blocks. */
  width: 640px;
  max-width: 100%;
  box-sizing: border-box;
}
.kyb-buzz .kcards { margin-top: 2px; }
.kyb-buzz .kask + .kask { margin-top: 8px; }
/* The message list restyles buttons; the primary one keeps its own colours. */
.kyb-buzz .kbtn--primary {
  background: var(--surface-inverse, #16181d) !important;
  color: var(--text-color-inverse, #ffffff) !important;
}
/* The card shows the page itself: the host's address bar and its buttons stay hidden. */
.kyb-buzz__page [role="toolbar"][aria-label="Browser controls"] { display: none !important; }
.kyb-buzz__page {
  display: flex;
  flex-direction: column;
  height: 460px;
  border: 1px solid var(--kyb-stroke);
  border-radius: 8px;
  overflow: hidden;
}
.kyb-buzz__waiting {
  display: grid;
  place-items: center;
  flex: 1;
  color: var(--kyb-ink-tertiary);
  font-size: 13px;
}
`;

function openOutside(url: string): void {
  // The way Buzz's own message links leave the app.
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
}

export function apply(ctx: Context) {
  const React = ctx.react;
  bindReact(React);
  // Buzz wraps service members on each read; one reference keeps React's component identity.
  const View = ctx.browser.View;
  const browsing = () => ctx.browser.available;

  /**
   * A shared page drawn in its card.
   *
   * The website draws above the app rather than inside the list, so it is
   * shown only while the card sits wholly inside the conversation; partly
   * scrolled away it would cover the header or the composer. Its session
   * waits, so it comes back as it was.
   */
  function InlinePage({ url, title }: { url: string; title?: string }) {
    const box = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(false);
    useEffect(() => {
      const element = box.current;
      if (!element) return;
      const observer = new IntersectionObserver(
        (entries) => setShown(entries.some((entry) => entry.intersectionRatio >= 0.99)),
        { root: scrollRoot(element), threshold: [0, 0.5, 0.99, 1] },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, []);
    return (
      <div ref={box} className="kyb-buzz__page">
        {shown ? <View url={url} storage={STORAGE} label={title} /> : <div className="kyb-buzz__waiting">{title ?? "Page"}</div>}
      </div>
    );
  }

  ctx.panels.register({
    id: "artifact",
    title: "Artifact",
    // Each page keeps its tab while the conversation moves on.
    keepOpen: true,
    matches: (target) => browsing() && isSharedPage(target),
    component: ({ target }) => <View url={target} storage={STORAGE} />,
  });

  /**
   * Post as the person, in the conversation the message is in: a reply to it,
   * inside its thread when it has one. `mentions` addresses the agent where
   * the words alone would not reach it.
   */
  function replyTo(message: Message, content: string, mentions: string[] = []): string | null {
    const connection = ctx.relay.snapshot();
    if (connection.status !== "ready") return "Not connected to the community right now. Try again in a moment.";
    try {
      connection.session.messages.reply(message.channelId, message.threadRootId ?? message.id, content, mentions, [], message.id);
      return null;
    } catch (error) {
      return `Could not send: ${(error as Error).message}`;
    }
  }

  function AskMessage({ message, ask, host }: { message: Message; ask: Ask; host: CardContext }) {
    const key = `${message.id}:${ask.requestId}`;
    const [answered, setAnswered] = useState<AskReply | undefined>(() => answeredStore()[key]);
    const [error, setError] = useState<string | undefined>();
    return (
      <AskView
        ask={ask}
        ctx={host}
        answered={answered}
        error={error}
        onAnswer={(reply) => {
          const failed = replyTo(message, answerMessage({ requestId: ask.requestId, optionId: reply.optionId, text: reply.text }, reply.label));
          if (failed) {
            setError(failed);
            return;
          }
          setError(undefined);
          remember(key, reply);
          setAnswered(reply);
        }}
      />
    );
  }

  function CardMessage({ message, canOpen, open }: Opener & { message: Message }) {
    const cards = cardsIn(message);
    const asks = asksIn(message);
    const host: CardContext = {
      // A target Buzz has a panel for (a pull request, say) opens beside the conversation.
      openUrl: (url) => {
        if (!(canOpen(url) && open(url))) openOutside(url);
      },
      renderArtifact: (artifact, title) =>
        artifact.url && browsing() && isSharedPage(artifact.url) ? <InlinePage url={artifact.url} title={title} /> : null,
      // A button that says something: the person's next message to the agent, in this thread.
      onSay: (text) => {
        const failed = replyTo(message, text, [message.authorId]);
        if (failed) console.warn(`[kybernesis.cards] ${failed}`);
      },
    };
    return (
      <div className="kyb-buzz">
        <style>{THEME + cardStyles}</style>
        {asks.map((ask) => (
          <AskMessage key={ask.requestId} message={message} ask={ask} host={host} />
        ))}
        <CardStack cards={cards} ctx={host} />
      </div>
    );
  }

  ctx.conversation.registerMessage({
    id: "cards",
    title: "Kybernesis cards",
    matches: (message) => cardsIn(message).length > 0 || asksIn(message).length > 0,
    component: CardMessage,
  });
}
