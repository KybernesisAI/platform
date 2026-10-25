/**
 * Whether a peer's answer can find its way back to this agent.
 *
 * Calling a peer parks the asking turn until the peer posts its answer to a
 * callback URL that eve builds. Off Vercel, eve builds it from
 * `WORKFLOW_LOCAL_BASE_URL` or falls back to `http://localhost:3000`, so the
 * peer posts to its OWN localhost, the post is refused, and the person who
 * asked never hears back. Nothing errors on the asking side; the peer's log
 * shows `callback delivery failed` against `http://localhost:3000`. On the
 * reference fleet every agent-to-agent call between exe hosts was lost this
 * way until `@kybernesis/dispatch` 0.8.1, where the caller names its public
 * address (EVE_PUBLIC_URL, else `https://<EXE_VM_NAME>.exe.xyz`) and the
 * receiver uses it.
 *
 * Both ends matter: a caller on an older dispatch sends no address, and a
 * receiver on an older dispatch ignores it.
 */

/** The first dispatch that corrects a loopback callback. */
export const PEER_CALLBACK_DISPATCH = "0.8.1";

export type PeerCallbackCheck = {
  readonly verdict: "pass" | "fail";
  readonly label: string;
  readonly fix?: string;
};

export interface PeerCallbackInput {
  /** Installed `@kybernesis/dispatch` version, if any. */
  readonly dispatchVersion: string | undefined;
  /** This agent calls peers (`remotePeer` files under agent/subagents). */
  readonly callsPeers: boolean;
  /** Other agents call this one (its eve channel is a `dispatchChannel`). */
  readonly answersPeers: boolean;
  /** The agent's env (`.env.local`), for its public address. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function versionAtLeast(version: string, floor: string): boolean {
  const parse = (v: string) => v.replace(/^[^\d]*/, "").split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const a = parse(version), b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function peerCallbackChecks(input: PeerCallbackInput): PeerCallbackCheck[] {
  if (!input.callsPeers && !input.answersPeers) return [];
  // On Vercel eve builds the callback from the production URL itself.
  if (input.env.VERCEL === "1") return [];

  const checks: PeerCallbackCheck[] = [];
  const version = input.dispatchVersion;
  if (version && !versionAtLeast(version, PEER_CALLBACK_DISPATCH)) {
    checks.push({
      verdict: "fail",
      label: `@kybernesis/dispatch ${version} loses peer answers on this host`,
      fix: `npm install @kybernesis/dispatch@^${PEER_CALLBACK_DISPATCH} (peers are told to answer at localhost; upgrade both ends of every edge)`,
    });
  }
  if (input.callsPeers) {
    const known = Boolean(input.env.EVE_PUBLIC_URL?.trim() || input.env.EXE_VM_NAME?.trim());
    checks.push(
      known
        ? { verdict: "pass", label: "peers can post their answers back (public address known)" }
        : {
            verdict: "fail",
            label: "this agent does not know its public address, so peers cannot answer it",
            fix: 'add EXE_VM_NAME="<vm>" (or EVE_PUBLIC_URL) to .env.local',
          },
    );
  }
  return checks;
}
