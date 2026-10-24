import type { Context } from "@buzz/author";
import { HIDDEN_CARD_OPEN, readHiddenCards, type Card } from "@kybernesis/cards";
import { CardStack, cardStyles, type CardContext } from "@kybernesis/cards-react";
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
 * Without the plugin, or if it fails, people read the text: nothing is lost.
 */

export const inject = ["react", "conversation", "panels", "browser"];

type Message = { content: string };
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
  --kyb-ink-inverse: var(--surface-base, #ffffff);
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
  max-width: 640px;
}
.kyb-buzz .kcards { margin-top: 2px; }
.kyb-buzz__page {
  display: flex;
  flex-direction: column;
  height: 420px;
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

  function CardMessage({ message, canOpen, open }: Opener & { message: Message }) {
    const cards = cardsIn(message);
    const host: CardContext = {
      // A target Buzz has a panel for (a pull request, say) opens beside the conversation.
      openUrl: (url) => {
        if (!(canOpen(url) && open(url))) openOutside(url);
      },
      renderArtifact: (artifact, title) =>
        artifact.url && browsing() && isSharedPage(artifact.url) ? <InlinePage url={artifact.url} title={title} /> : null,
    };
    return (
      <div className="kyb-buzz">
        <style>{THEME + cardStyles}</style>
        <CardStack cards={cards} ctx={host} />
      </div>
    );
  }

  ctx.conversation.registerMessage({
    id: "cards",
    title: "Kybernesis cards",
    matches: (message) => cardsIn(message).length > 0,
    component: CardMessage,
  });
}
