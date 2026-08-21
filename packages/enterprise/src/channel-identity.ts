/**
 * Resolve a chat-platform sender to a control-plane identity.
 *
 * @remarks
 * A bridge that carries messages from a shared room into an agent has to answer one question
 * before it can do anything else: who is this turn for? The easy answer — one identity for the
 * whole room — is the wrong one. It makes every person's memory, connections and grants the same
 * person's, and quietly grants the least privileged member of a channel everything the most
 * privileged one has.
 *
 * So the sender's platform id is resolved, per turn, to a session minted for that person. The
 * binding from id to person is not something this code decides or stores; it is established by
 * the person themselves in the control plane, and re-checked at every mint. Revoking a link,
 * suspending a user or pulling a grant therefore takes effect within one token lifetime,
 * everywhere, with no bridge to redeploy.
 *
 * Nothing durable is kept on the bridge's host. That is deliberate: a bridge holding long-lived
 * credentials for every person in a room is a single host whose compromise yields all of them.
 * The only lasting secret here is the agent's own credential, and it can act as nobody.
 */

/** What the caller needs to run a turn as somebody. */
export type ResolvedSpeaker = {
  linked: true;
  /** Bearer token for the agent, scoped to this person, valid for `expiresAt`. */
  token: string;
  bundle: string;
  issuer: string;
  expiresAt: number;
  user: { id: string; email: string; displayName: string };
};

/** Nobody yet — with the link that fixes it, to be delivered over the sender's own platform. */
export type UnlinkedSpeaker = {
  linked: false;
  reason: "not_linked";
  /** Send this TO the sender: receiving it is what proves they control the id. */
  link: string;
  expiresAt?: number;
};

/** Known, but not allowed — a distinct case from unknown, and never fixed by linking again. */
export type RefusedSpeaker = {
  linked: false;
  reason: "agent_not_granted" | "user_suspended" | "unknown_user";
};

export type SpeakerResolution = ResolvedSpeaker | UnlinkedSpeaker | RefusedSpeaker;

export type ChannelIdentityOptions = {
  /** The control plane, e.g. `https://control.example.com`. */
  issuer: string;
  /** This agent's own credential. The only durable secret a bridge needs. */
  credential: string;
  /** Re-mint this many milliseconds before expiry rather than at it. Default 30s. */
  refreshSkewMs?: number;
  fetchImpl?: typeof fetch;
};

type CacheEntry = { value: ResolvedSpeaker; expiresAt: number };

/** Seconds → ms, tolerating a control plane that omits the hint. */
function expiryFrom(expiresIn: unknown, skewMs: number): number {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 300;
  return Date.now() + seconds * 1000 - skewMs;
}

export function channelIdentity(options: ChannelIdentityOptions) {
  const issuer = options.issuer.replace(/\/$/, "");
  const skew = options.refreshSkewMs ?? 30_000;
  const doFetch = options.fetchImpl ?? fetch;
  const cache = new Map<string, CacheEntry>();
  /** One in-flight mint per speaker: a busy room must not stampede the control plane. */
  const inFlight = new Map<string, Promise<SpeakerResolution>>();

  async function mint(provider: string, externalId: string, label?: string): Promise<SpeakerResolution> {
    const response = await doFetch(`${issuer}/api/agent/identity`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider, externalId, ...(label ? { label } : {}) }),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.ok && typeof body.token === "string") {
      const resolved: ResolvedSpeaker = {
        linked: true,
        token: body.token,
        bundle: String(body.bundle ?? ""),
        issuer: String(body.issuer ?? issuer),
        expiresAt: expiryFrom(body.expiresIn, skew),
        user: (body.user ?? { id: "", email: "", displayName: "" }) as ResolvedSpeaker["user"],
      };
      cache.set(`${provider}:${externalId}`, { value: resolved, expiresAt: resolved.expiresAt });
      return resolved;
    }

    if (response.status === 404 && body.error === "not_linked" && typeof body.link === "string") {
      return {
        linked: false,
        reason: "not_linked",
        link: body.link,
        ...(typeof body.expiresAt === "string" ? { expiresAt: Date.parse(body.expiresAt) } : {}),
      };
    }

    const reason = body.error;
    if (reason === "agent_not_granted" || reason === "user_suspended" || reason === "unknown_user") {
      return { linked: false, reason };
    }

    // Anything else is the control plane being unreachable or unhappy, which is NOT the same as a
    // refusal — a bridge that treats a 500 as "you are not allowed" locks a whole room out over a
    // deploy. Callers see it as thrown, and should retry rather than reject the sender.
    throw new Error(
      `channel identity unavailable: ${response.status} ${typeof body.error === "string" ? body.error : ""}`.trim(),
    );
  }

  return {
    /**
     * Who this sender is, minting a session if the cached one is spent.
     *
     * @param provider - The platform, as registered in the control plane (e.g. `"slack"`).
     * @param externalId - The platform's id for the sender, in that platform's canonical form.
     * @param label - Optional display text, so a person recognises the account they are claiming.
     */
    async resolve(provider: string, externalId: string, label?: string): Promise<SpeakerResolution> {
      const key = `${provider}:${externalId}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      cache.delete(key);

      const existing = inFlight.get(key);
      if (existing) return existing;

      const attempt = mint(provider, externalId, label).finally(() => inFlight.delete(key));
      inFlight.set(key, attempt);
      return attempt;
    },

    /** Drop a cached session — for a sender whose turn was refused downstream. */
    forget(provider: string, externalId: string): void {
      cache.delete(`${provider}:${externalId}`);
    },
  };
}

export type ChannelIdentity = ReturnType<typeof channelIdentity>;
