/**
 * The rule for what an agent reaches for, and the guard that enforces the
 * part of it a model is most likely to get wrong.
 *
 * Same order every time: connected app, then a tool, then the agent's
 * browser, then the person's machine. The browser is the fallback for sites
 * that have NO connector. A service that has a connector — connected or not —
 * is reached through it; if it is not connected, the agent asks the person to
 * connect it rather than clicking through the website. The one exception is
 * identity: when something must go out as the person, not as an app, the
 * signed-in browser is the right tool.
 *
 * Instructions say this; this module makes the browser tool refuse to run
 * silently when the model forgets. A browser call to a connector-covered host
 * with no stated override parks for the person's approval instead.
 */

/** Hosts covered by a connector in the Kybernesis catalogue, by service slug. */
export const CONNECTOR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["mail.google.com", "gmail.com"],
  "google-calendar": ["calendar.google.com"],
  "google-drive": ["drive.google.com", "docs.google.com", "sheets.google.com", "slides.google.com"],
  notion: ["notion.so", "www.notion.so", "notion.site"],
  linear: ["linear.app"],
  attio: ["app.attio.com", "attio.com"],
  github: ["github.com", "www.github.com"],
  vercel: ["vercel.com", "www.vercel.com"],
  slack: ["slack.com", "app.slack.com"],
  hubspot: ["app.hubspot.com", "hubspot.com"],
  salesforce: ["salesforce.com", "lightning.force.com", "my.salesforce.com"],
  asana: ["app.asana.com"],
  jira: ["atlassian.net"],
  zoom: ["zoom.us"],
  calendly: ["calendly.com"],
};

/** Why the model is allowed to open a connector-covered site in the browser. */
export type BrowserOverride =
  /** The person said to use the browser / the computer for this. */
  | "person-asked-for-browser"
  /** The action must carry the person's own identity (a post or message as them), which a connector would send as an app. */
  | "must-act-as-the-person"
  /** The person must look at the page themselves (a cart, a form, a review). */
  | "person-must-see-the-page";

export const BROWSER_OVERRIDES: readonly BrowserOverride[] = [
  "person-asked-for-browser",
  "must-act-as-the-person",
  "person-must-see-the-page",
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The connector slug whose service this URL belongs to, or null when no connector covers it. */
export function serviceForUrl(url: string, hosts: Readonly<Record<string, readonly string[]>> = CONNECTOR_HOSTS): string | null {
  const host = hostOf(url);
  if (host === null) return null;
  for (const [slug, names] of Object.entries(hosts)) {
    if (names.some((name) => host === name || host.endsWith(`.${name}`))) return slug;
  }
  return null;
}

export type BrowserDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "ask"; readonly service: string; readonly reason: string };

/**
 * The decision for one browser call. Pure, so it can be tested without eve:
 * the tool wraps it in an approval policy.
 */
export function decideBrowserUse(input: {
  readonly url: string;
  readonly override?: BrowserOverride | undefined;
  readonly hosts?: Readonly<Record<string, readonly string[]>>;
}): BrowserDecision {
  const service = serviceForUrl(input.url, input.hosts);
  if (service === null) return { kind: "allowed" };
  if (input.override !== undefined && BROWSER_OVERRIDES.includes(input.override)) return { kind: "allowed" };
  return {
    kind: "ask",
    service,
    reason:
      `${service} has a connector, so the browser is not the way to reach it. ` +
      `Use the ${service} connector (or ask the person to connect it). ` +
      `Opening it in the browser needs the person's approval unless they asked for the browser or the action must be done as them.`,
  };
}
