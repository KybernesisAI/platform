/**
 * Who, exactly, is unhappy about the installed eve.
 *
 * @remarks
 * `kyb upgrade` refuses to touch a project whose peer tree is broken (KYB-538),
 * because changing a project on a bad tree is how a half-upgraded host happens.
 * That gate read `npm ls eve`'s exit code and nothing else, so any package
 * anywhere in the tree could veto the whole upgrade.
 *
 * On 2026-09-08 one did. `@github-tools/eve-extension` still declares
 * `>=0.44.0 <0.48.0` while every Kybernesis package declares the 0.49 line the
 * host actually runs. The upgrade aborted before `repairHostArtifacts`, so
 * kyber did not receive the KYB-542 reclaim job it was being upgraded for, and
 * the job had to be installed by hand.
 *
 * A third-party range that trails the framework is not a broken install. A
 * Kybernesis package disagreeing with the framework it is pinned against is.
 * So the verdict distinguishes them, and anything it cannot attribute is
 * treated as fatal rather than waved through.
 */
export interface PeerTreeVerdict {
  /** Nothing in the tree objects to the installed version. */
  readonly ok: boolean;
  /** Packages whose declared range excludes the installed version, deduplicated and sorted. */
  readonly offenders: readonly string[];
  /** An objection from a Kybernesis package, or one that could not be attributed. */
  readonly fatal: boolean;
}

const OWNED_SCOPE = "@kybernesis/";

/** Every `from node_modules/<pkg>` in one npm `invalid` string. */
function requiredBy(invalid: string): string[] {
  const found: string[] = [];
  const pattern = /from node_modules\/((?:@[^/\s,]+\/)?[^/\s,]+)/g;
  let match = pattern.exec(invalid);
  while (match !== null) {
    if (match[1]) found.push(match[1]);
    match = pattern.exec(invalid);
  }
  return found;
}

function collect(node: unknown, offenders: Set<string>, unattributed: { seen: boolean }): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.invalid === "string" && record.invalid.length > 0) {
    const owners = requiredBy(record.invalid);
    // An objection nobody signed is not evidence that the tree is fine.
    if (owners.length === 0) unattributed.seen = true;
    for (const owner of owners) offenders.add(owner);
  }
  const dependencies = record.dependencies;
  if (dependencies && typeof dependencies === "object") {
    for (const child of Object.values(dependencies as Record<string, unknown>)) {
      collect(child, offenders, unattributed);
    }
  }
}

/**
 * Read `npm ls <pkg> --json` and say whether the upgrade may proceed.
 *
 * Unparseable output is fatal: not knowing the shape of the tree is exactly the
 * case the gate exists for.
 */
export function assessPeerTree(stdout: string): PeerTreeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, offenders: [], fatal: true };
  }
  const offenders = new Set<string>();
  const unattributed = { seen: false };
  collect(parsed, offenders, unattributed);

  if (offenders.size === 0 && !unattributed.seen) return { ok: true, offenders: [], fatal: false };
  const sorted = [...offenders].sort();
  const ours = sorted.some((name) => name.startsWith(OWNED_SCOPE));
  return { ok: false, offenders: sorted, fatal: ours || unattributed.seen };
}

/** What to print when a third-party range trails the framework but nothing else does. */
export function staleRangeWarning(offenders: readonly string[], dependency: string): string {
  const names = offenders.join(", ");
  return (
    `${names} declare${offenders.length === 1 ? "s" : ""} a ${dependency} range that excludes the installed version. ` +
    `Every Kybernesis package agrees with it, and the runtime already runs on it, so the upgrade continues. ` +
    `Upgrade or replace ${offenders.length === 1 ? "that package" : "those packages"} when a compatible release exists.`
  );
}
