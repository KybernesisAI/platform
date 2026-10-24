import { card, withCards } from "@kybernesis/cards";

/**
 * "Connect HubSpot", answered from a chat.
 *
 * The control plane makes the sign-in link for the person whose turn it is,
 * the same one the Connectors page opens; the agent only ever holds the link.
 * The person signs in in their own browser, and the service's tools appear on
 * their next message, because connector tools are resolved per turn.
 */

export interface AgentLinkAnswer {
  ok: boolean;
  reason?: string;
  message?: string;
  service?: string;
  slug?: string;
  logo?: string | null;
  connected?: boolean;
  url?: string;
  available?: string[];
  /** Connected for the whole company (a shared sign-in), not just this person. */
  shared?: boolean;
  /** What the person should know before signing in, e.g. that their workspace admin may need to approve. */
  note?: string;
  shelf?: { name: string; slug: string; connected: boolean; fromChat: boolean }[];
}

/** The tool's answer: a card with the sign-in link, or words the model can repeat. */
export function connectAnswer(answer: AgentLinkAnswer): Record<string, unknown> {
  if (answer.shelf) {
    return {
      services: answer.shelf.map((s) => ({ name: s.name, connected: s.connected, connectFromChat: s.fromChat })),
      note: "These are the services this company has approved. Connected ones already have tools.",
    };
  }
  if (!answer.ok) {
    return {
      connected: false,
      message: answer.message ?? "That service could not be connected from here.",
      ...(answer.available?.length ? { available: answer.available } : {}),
    };
  }
  const service = answer.service ?? "the service";
  const note = answer.note ? ` ${answer.note}` : "";
  if (answer.connected) {
    return { connected: true, message: `${service} is already connected for this person. Its tools are available now.` };
  }
  if (!answer.url) return { connected: false, message: `The sign-in link for ${service} could not be made. Try again in a moment.` };
  return withCards(
    {
      connected: false,
      linkSent: true,
      message: `The person now has a button to sign in to ${service} in their own browser. After they finish, ${service}'s tools are available from their next message.${note}`,
    },
    card(
      "link",
      {
        url: answer.url,
        title: `Connect ${service}`,
        site: service,
        description: `${
          answer.shared
            ? `Sign in to ${service} for the whole company in your browser.`
            : `Sign in with your own ${service} account in your browser.`
        } When you're done, send me your next message and I can use it.${note}`,
      },
      {
        id: `connect-${answer.slug ?? service.toLowerCase()}`,
        source: "Connectors",
        actions: [{ label: `Connect ${service}`, url: answer.url, primary: true }],
        text: `Connect ${service}: ${answer.url}`,
      },
    ),
  );
}
