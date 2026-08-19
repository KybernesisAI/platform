/**
 * Host preflight for a self-hosted eve agent on exe.dev.
 *
 * Every check here exists because its absence cost a real debugging session.
 * Run it from the host (a script, a boot hook, or `kyb doctor`), not from a
 * developer laptop — most checks are about the host's own environment.
 */

export interface HostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HostPreflightResult {
  ok: boolean;
  checks: HostCheck[];
}

export interface HostPreflightOptions {
  /** Agent directory, for reading durable workflow state. Defaults to cwd. */
  appDir?: string;
  /** LLM integration base URL. Defaults to EXE_LLM_URL or the default personal integration. */
  llmBaseUrl?: string;
  /** Local eve server base URL. Defaults to EVE_URL or http://127.0.0.1:8000. */
  eveUrl?: string;
  /** Slack integration hostname (e.g. https://kybot.int.exe.xyz/api/) when the agent uses Slack. */
  slackGateway?: string;
  /** Env var names the agent needs present on the host. */
  requiredEnv?: readonly string[];
}

async function probe(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
}

/**
 * Check that this host can actually run the agent.
 *
 * Checks, and the failure each one catches:
 * - **LLM integration reachable** — the agent has no model at all if the
 *   integration isn't attached to this VM.
 * - **Model is served** — asking for a model the integration doesn't expose
 *   fails only at the first turn, in production.
 * - **eve responds** — `eve start` silently exits when a Vercel-Connect-backed
 *   channel or sandbox can't get an OIDC token off-Vercel.
 * - **Required env present** — `eve start` does NOT load `.env.local` the way
 *   `eve dev` does; variables must be exported into the process.
 * - **Slack: exactly one socket connection** — Slack round-robins events across
 *   open Socket Mode connections, so a leaked forwarder silently swallows them.
 * - **Slack: token scopes** — a token issued before scopes were added stays
 *   valid but stops receiving events, with no error anywhere.
 */
export async function hostPreflight(
  options: HostPreflightOptions = {},
): Promise<HostPreflightResult> {
  const checks: HostCheck[] = [];
  const llm = (options.llmBaseUrl ?? process.env.EXE_LLM_URL ?? "https://llm.int.exe.xyz/v1").replace(/\/$/, "");
  const eve = (options.eveUrl ?? process.env.EVE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

  const models = await probe(`${llm}/models`);
  checks.push({
    name: "llm integration reachable",
    ok: Boolean(models?.ok),
    detail: models?.ok
      ? llm
      : `cannot reach ${llm} — is the LLM integration attached to this VM? (integrations attach <name> vm:<vm>)`,
  });

  if (models?.ok) {
    const body = (await models.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const ids = (body?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
    const wanted = process.env.EXE_MODEL;
    checks.push({
      name: "models served",
      ok: ids.length > 0,
      detail: ids.length
        ? wanted && !ids.includes(wanted)
          ? `${ids.length} models, but EXE_MODEL="${wanted}" is NOT among them`
          : `${ids.length} models available`
        : "integration returned no models",
    });
  }

  // Durable truth about work done. A log file can look frozen while the agent
  // is serving happily (`eve start` forwards only its startup banner to a
  // redirected log), so never diagnose "nothing is happening" from logs alone.
  try {
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const runsDir = join(options.appDir ?? process.cwd(), ".eve/.workflow-data/runs");
    const runs = readdirSync(runsDir).filter((f) => f.endsWith(".json")).length;
    checks.push({
      name: "workflow runs on disk",
      ok: true,
      detail: `${runs} run(s) recorded — the authoritative record of turns handled`,
    });
  } catch {
    checks.push({
      name: "workflow runs on disk",
      ok: true,
      detail: "no runs recorded yet (this agent has handled no turns)",
    });
  }

  // Remote-agent callbacks, and the trap in trying to fix them.
  //
  // eve builds the callback URL it hands a remote agent from, in order: a
  // Vercel production URL, WORKFLOW_LOCAL_BASE_URL, then workflow metadata,
  // which falls back to port 3000. A self-hosted host has no Vercel URL, so the
  // remote is told to post its terminal callback to localhost:3000, delivers it
  // to whatever is (not) listening there, and the CALLING turn parks forever
  // with no error surfacing on either side.
  //
  // The obvious fix is the trap. WORKFLOW_LOCAL_BASE_URL is not only the remote
  // callback base — it is the base for every framework workflow callback,
  // including the host's deliveries to itself. Set it to a public URL the host
  // cannot resolve back to itself and the agent stops processing work at all:
  // every queue message fails with "fetch failed", which is a far worse failure
  // than the one being fixed. Hosts commonly cannot reach their own public
  // hostname even when every peer can.
  //
  // So this reports which situation the host is in rather than prescribing a
  // value. Where the public URL is not self-reachable, prefer peer calls that
  // poll a session stream over ones that wait for a callback.
  const callbackBase = process.env.WORKFLOW_LOCAL_BASE_URL?.trim();
  if (callbackBase) {
    const self = await probe(`${callbackBase.replace(/\/$/, "")}/eve/v1/health`);
    checks.push({
      name: "workflow callback base is self-reachable",
      ok: Boolean(self?.ok),
      detail: self?.ok
        ? `${callbackBase} answers from this host, so workflow callbacks can land`
        : `WORKFLOW_LOCAL_BASE_URL=${callbackBase} does NOT answer from this host. Every ` +
          `workflow queue delivery uses this base, so the agent will stop processing work. Unset it.`,
    });
  }

  /**
   * Whether this host can hand a file back to a person.
   *
   * @remarks
   * The delivery tool needs somewhere to put a file: either object storage, or
   * a directory this host serves. On the platform that ships it, the storage
   * credential is injected into the runtime automatically, so the requirement
   * is invisible — nothing is written down because nothing has to be.
   *
   * Self-hosting is where that bites. The environment file comes across, the
   * agent starts, every eval passes, and the capability is simply gone: the
   * tool only fails when someone finally asks for a file, weeks later, with an
   * error about configuration that reads like a bug. An agent that could
   * produce reports last month and cannot today, with nothing in between that
   * looks related, is an expensive thing to debug.
   *
   * So it is checked at preflight, where a missing capability is a line of
   * output rather than an incident.
   */
  const delivery =
    Boolean(process.env.BLOB_READ_WRITE_TOKEN) ||
    Boolean(process.env.DELIVER_DIR && process.env.DELIVER_BASE_URL);
  checks.push({
    name: "file delivery configured",
    ok: delivery,
    detail: delivery
      ? process.env.BLOB_READ_WRITE_TOKEN
        ? "object storage token present — the agent can hand a file back as a link"
        : `serving ${process.env.DELIVER_DIR} at ${process.env.DELIVER_BASE_URL}`
      : "no delivery target. The agent can WRITE a file and still have no way to give it " +
        "to anyone: set BLOB_READ_WRITE_TOKEN, or DELIVER_DIR with DELIVER_BASE_URL. " +
        "This is usually what a platform supplied for free before the agent moved here.",
  });

  const health = await probe(`${eve}/eve/v1/health`);
  checks.push({
    name: "eve server responding",
    ok: Boolean(health?.ok),
    detail: health?.ok
      ? eve
      : `no healthy eve at ${eve} — check the server log; a Vercel-Connect channel or vercel() sandbox fails to boot off-Vercel`,
  });

  for (const name of options.requiredEnv ?? []) {
    checks.push({
      name: `env ${name}`,
      ok: Boolean(process.env[name]),
      detail: process.env[name]
        ? "set"
        : `missing — note that \`eve start\` does not read .env.local; export it into the process`,
    });
  }

  if (options.slackGateway) {
    const gw = options.slackGateway.replace(/\/$/, "");
    const auth = await probe(`${gw}/auth.test`, { method: "POST" });
    const authBody = (await auth?.json().catch(() => null)) as
      | { ok?: boolean; user?: string }
      | null;
    checks.push({
      name: "slack integration auth",
      ok: Boolean(authBody?.ok),
      detail: authBody?.ok
        ? `authenticated as ${authBody.user}`
        : "auth.test failed — check the Slack Bot integration is attached to this VM",
    });

    // Scope drift: a token minted before scopes were added stays valid for
    // chat.postMessage but stops receiving events. Any scoped call reports the
    // token's ACTUAL scopes in `provided`.
    const scoped = await probe(`${gw}/conversations.members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "C000000000000" }),
    });
    const scopedBody = (await scoped?.json().catch(() => null)) as
      | { provided?: string }
      | null;
    const provided = scopedBody?.provided ?? "";
    checks.push({
      name: "slack token scopes",
      ok: provided.includes("app_mentions:read"),
      detail: provided
        ? provided.includes("app_mentions:read")
          ? `provided: ${provided}`
          : `token is MISSING app_mentions:read (provided: ${provided}) — reinstall the app to the workspace; mentions will never arrive`
        : "could not read token scopes",
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
