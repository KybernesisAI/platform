/**
 * The agent's view of a person's vault, through the control plane.
 *
 * Two calls. `listItems` returns what the agent may know: a label, a site, a
 * username, a card's brand and last four. `materialize` returns one item's
 * secret, and exists for exactly one caller — the fill tool, which types it into
 * a page and returns nothing. Both name the person from the turn's VERIFIED
 * principal, never from the model: a vault is someone's, and an unattended turn
 * (a schedule, an unlinked chat sender) has no one.
 */
export type VaultKind = "login" | "card" | "address" | "contact";

export interface VaultSummary {
  readonly id: string;
  readonly kind: VaultKind;
  readonly label: string;
  readonly origin: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface MaterializedItem extends VaultSummary {
  readonly secret: Readonly<Record<string, unknown>>;
}

export interface VaultClientOptions {
  /** The control plane. Defaults to KYBERNESIS_ISSUER, then agent.kybernesis.ai. */
  readonly issuer?: string;
  /** This agent's credential. Defaults to KYBERNESIS_AGENT_CREDENTIAL. */
  readonly credential?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_ISSUER = "https://agent.kybernesis.ai";

function base(options: VaultClientOptions): string {
  return (options.issuer ?? process.env.KYBERNESIS_ISSUER ?? DEFAULT_ISSUER).replace(/\/$/, "");
}

function credentialOf(options: VaultClientOptions): string {
  const credential = options.credential ?? process.env.KYBERNESIS_AGENT_CREDENTIAL;
  if (!credential) throw new Error("This agent has no control-plane credential, so it cannot reach anyone's vault.");
  return credential;
}

/** The shape of eve's tool context this package reads. Kept structural so the package has no opinion about the rest. */
export interface PrincipalContext {
  readonly session?: { readonly auth?: { readonly current?: { readonly principalId?: string; readonly authenticator?: string; readonly principalType?: string } | null } };
}

/**
 * The person this turn is for, or null. Default-deny: only a principal the
 * control plane itself authenticated (Studio, a linked chat sender) counts.
 * eve's own local-dev and channel-default principals are not people the vault
 * knows, so they get nothing.
 */
export function personFromContext(ctx: PrincipalContext): string | null {
  const current = ctx.session?.auth?.current;
  if (!current?.principalId) return null;
  if (current.authenticator !== "kybernesis") return null;
  if (current.principalType && current.principalType !== "user") return null;
  return current.principalId;
}

export const NO_PERSON = "This conversation has no signed-in person, so there is no vault to use. Ask them to continue from KYBER Studio or a linked channel.";

async function post<T>(options: VaultClientOptions, path: string, body: unknown): Promise<T> {
  const f = options.fetchImpl ?? fetch;
  const res = await f(`${base(options)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credentialOf(options)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error("The control plane did not accept this agent's credential.");
  if (res.status === 404) throw new Error("That vault item does not exist (or is not this person's).");
  if (!res.ok) throw new Error(`The vault call failed (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

export async function listItems(options: VaultClientOptions, user: string, origin?: string): Promise<VaultSummary[]> {
  const body = await post<{ items: VaultSummary[] }>(options, "/api/vault/items", { user, ...(origin ? { origin } : {}) });
  return body.items ?? [];
}

export async function materialize(options: VaultClientOptions, user: string, id: string): Promise<MaterializedItem> {
  const body = await post<{ item: MaterializedItem }>(options, "/api/vault/materialize", { user, id });
  return body.item;
}

/** `accounts.example.com` and `example.com` are the same site for a stored login; `example.com.evil.net` is not. */
export function sameSite(stored: string | null, pageUrl: string): boolean {
  if (!stored) return false;
  try {
    const a = new URL(stored).hostname.replace(/^www\./, "").toLowerCase();
    const b = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

/**
 * Every value a form field may be filled with, by field name. Summary and
 * secret flatten together; a card also gets `expiration` (MM/YY) and
 * `expiration_long` (MM/YYYY), and a zero-padded `exp_month`.
 */
export function valuesOf(item: MaterializedItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of [item.summary, item.secret]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined) continue;
      out[key] = String(value);
    }
  }
  if (item.kind === "card") {
    const mm = out.expMonth ? out.expMonth.padStart(2, "0") : undefined;
    const yyyy = out.expYear;
    if (mm) out.exp_month = mm;
    if (yyyy) {
      out.exp_year = yyyy;
      out.exp_year_short = yyyy.slice(-2);
      if (mm) {
        out.expiration = `${mm}/${yyyy.slice(-2)}`;
        out.expiration_long = `${mm}/${yyyy}`;
      }
    }
    if (out.cardholder) out.name = out.cardholder;
  }
  return out;
}
