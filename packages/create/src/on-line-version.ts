/**
 * Picking the right build of a per-eve-line package.
 *
 * `@kybernesis/*` packages ship one build per eve line, and the version numbers
 * are NOT ordered by line: `@kybernesis/voice` 0.1.2 is the eve 0.49 build and
 * was published AFTER 0.1.1, which is the 0.51 build. So `npm view <pkg>
 * version` — npm's `latest` — is routinely the wrong package for a given host,
 * and installing it puts an agent on a build compiled against an eve API it is
 * not running.
 *
 * That failure is silent. The package installs, the agent builds, the service
 * starts, and one code path breaks later at runtime. It is how
 * `@kybernesis/notify` took an agent down and how two agents ran a 0.51 build of
 * `@kybernesis/manage` on eve 0.49 for days without anyone noticing.
 *
 * So an upgrade must never ask for "latest". It must ask for the newest version
 * whose declared eve peer range contains the eve this host actually runs.
 */

/** A published version and the eve range it declares. */
export interface Candidate {
  version: string;
  /** `peerDependencies.eve`, or undefined when the package declares none. */
  peer?: string;
}

/**
 * Compare semver-ish versions numerically.
 *
 * Numerically, because these are picked by sorting and string order puts 0.8.9
 * above 0.8.10 — which would hand a host the wrong build. A prerelease sorts
 * BELOW its release (0.1.2-rc < 0.1.2), so a release candidate is never chosen
 * over the release it precedes.
 */
export function versionCompare(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: boolean } => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash)).split(".").map((p) => Number(p) || 0);
    return { core, pre: dash !== -1 };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  return pa.pre ? -1 : 1;
}

/**
 * Whether an eve version falls inside a declared peer range.
 *
 * Deliberately narrow: it understands the two forms these packages actually
 * publish — `>=X <Y` and a caret — and returns false for anything it does not
 * recognise. Guessing at a range it cannot parse is how a wrong build gets
 * installed, and "I do not know" must not read as "yes".
 */
export function rangeContains(range: string | undefined, eve: string): boolean {
  if (!range) return false;
  const bounded = /^>=\s*([0-9][^\s]*)\s*<\s*([0-9][^\s]*)$/.exec(range.trim());
  if (bounded) {
    return versionCompare(eve, bounded[1]!) >= 0 && versionCompare(eve, bounded[2]!) < 0;
  }
  const caret = /^\^([0-9][^\s]*)$/.exec(range.trim());
  if (caret) {
    const base = caret[1]!.split(".");
    const major = Number(base[0] ?? 0);
    const minor = Number(base[1] ?? 0);
    // ^0.x is minor-locked, as npm treats it.
    const upper = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
    return versionCompare(eve, caret[1]!) >= 0 && versionCompare(eve, upper) < 0;
  }
  const atLeast = /^>=\s*([0-9][^\s]*)$/.exec(range.trim());
  if (atLeast) return versionCompare(eve, atLeast[1]!) >= 0;
  return false;
}

/**
 * The newest published build that supports this host's eve.
 *
 * Returns undefined when no published version declares support — which is a
 * real answer and must be surfaced, not smoothed over by falling back to
 * latest. `@kybernesis/voice` had NO eve 0.49 build for weeks while two agents
 * on 0.49 ran its 0.51 one.
 */
export function newestOnLine(candidates: readonly Candidate[], eve: string): string | undefined {
  const supported = candidates.filter((c) => rangeContains(c.peer, eve));
  if (supported.length === 0) return undefined;
  return supported.sort((a, b) => versionCompare(a.version, b.version)).at(-1)?.version;
}
