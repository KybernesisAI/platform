import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dim, green, run, yellow } from "./util.js";

/**
 * What a person gets from an agent in KYBER Studio and on the phone beyond
 * words: cards under a reply (the `show` tool), pages the agent makes and
 * keeps (artifacts), and heads-ups it sends on its own (magic, off for each
 * person until they turn it on). Core on every agent since 2026-10-23 (Ian:
 * "they ship with every single agent").
 *
 * Keyed on @kybernesis/manage, like notify: manage serves the artifact pages
 * and owns the conversation magic delivers into, so without it neither has
 * anywhere to land. Every agent the provisioner builds has it (--studio).
 *
 * Each one's marker is its own package. An agent that already has it, added
 * by hand or customised (Sid's own delivery map), is never touched.
 */
export const STUDIO_CORE = [
  { item: "cards", pkg: "@kybernesis/cards", what: "cards under its replies" },
  { item: "artifacts", pkg: "@kybernesis/artifacts", what: "pages it makes and keeps" },
  { item: "magic", pkg: "@kybernesis/magic", what: "heads-ups, off until each person turns them on" },
] as const;

export type StudioCoreItem = (typeof STUDIO_CORE)[number];

/** The core items this agent is missing, in install order. None without manage. */
export function missingStudioCore(deps: Record<string, string>): StudioCoreItem[] {
  if (!deps["@kybernesis/manage"]) return [];
  return STUDIO_CORE.filter((core) => !deps[core.pkg]);
}

/**
 * The additions an upgrade would make, for `kyb upgrade --check`.
 *
 * Without them the Update button stays hidden on an agent whose packages are
 * all current, which is exactly the agent these were built after. `resolve`
 * names the build that would install; one that resolves to nothing is left
 * out, because nothing published runs on this eve.
 */
export function planStudioCore(
  deps: Record<string, string>,
  resolve: (pkg: string) => string | undefined,
): Array<{ name: string; from: string; to: string }> {
  return missingStudioCore(deps).flatMap((core) => {
    const version = resolve(core.pkg);
    return version ? [{ name: core.pkg, from: "none", to: version }] : [];
  });
}

/**
 * Where magic delivers on an agent that also answers on iMessage through Linq.
 *
 * The registry's map sends every heads-up into the conversation Studio and the
 * phone share. A person who last texted the agent should get it in that same
 * thread instead (Linq thread ids start with "linq:").
 */
export function magicSurfacesLinqTs(): string {
  return `import type { MagicDispatch } from "@kybernesis/magic";
import type { ScheduleToFn } from "eve/schedules";
import kyb from "../channels/kyb.js";
import linq from "../channels/linq.js";

/**
 * Where a heads-up is delivered: the conversation the person last used.
 *
 * A person who last texted this agent gets it in that same iMessage thread
 * (Linq thread ids start with "linq:"). Everyone else gets it in the
 * conversation Studio and the phone app share, which rings their phone.
 */
export function deliver(to: ScheduleToFn, dispatch: MagicDispatch) {
  const { surface, packet } = dispatch;
  if (surface.token?.startsWith("linq:")) {
    return to(linq, { threadId: surface.token }).send(packet, { auth: surface.auth });
  }
  return to(kyb, { routine: "magic" }).send(packet, { auth: surface.auth });
}
`;
}

/**
 * Point magic at Linq when this agent has a Linq channel. Only ever called
 * right after the registry wrote its default map, so nothing hand-made is lost.
 */
export function wireMagicLinq(cwd: string): boolean {
  if (!existsSync(join(cwd, "agent/channels/linq.ts"))) return false;
  const surfaces = join(cwd, "agent/lib/magic-surfaces.ts");
  if (!existsSync(surfaces)) return false;
  writeFileSync(surfaces, magicSurfacesLinqTs());
  return true;
}

/**
 * Keep magic's per-person state out of git. `.kyb/magic/people/<id>/` holds
 * what each person turned on and what they were told; it belongs to the host.
 */
export function ignoreMagicState(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((line) => /^\/?\.kyb\/?$/.test(line.trim()))) return false;
  appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}.kyb\n`);
  return true;
}

/**
 * Install each missing core item from the agent's own @kybernesis registry,
 * the same way `eve add` would by hand: its package and its files. Returns
 * what was added; a failure is said and skipped, and the eval gate after it
 * judges the agent as it stands.
 */
export function repairStudioCore(cwd: string, deps: Record<string, string>): StudioCoreItem[] {
  const added: StudioCoreItem[] = [];
  for (const core of missingStudioCore(deps)) {
    const ok = run("npx", ["eve", "add", `@kybernesis/${core.item}`, "--yes"], { cwd, allowFail: true, quiet: true });
    if (!ok) {
      console.log(`  ${yellow("!")} could not add ${core.pkg} (${core.what}). Run: npx eve add @kybernesis/${core.item}`);
      continue;
    }
    deps[core.pkg] = "latest";
    added.push(core);
    if (core.item === "magic") {
      ignoreMagicState(cwd);
      if (wireMagicLinq(cwd)) console.log(`    ${dim("magic delivers into iMessage threads too (agent/lib/magic-surfaces.ts)")}`);
    }
  }
  if (added.length > 0) {
    console.log(`  ${green("+")} Added ${added.map((core) => `${core.pkg} ${dim(`(${core.what})`)}`).join(", ")}`);
    console.log(`    ${dim("Takes effect after the next build and restart.")}\n`);
  }
  return added;
}
