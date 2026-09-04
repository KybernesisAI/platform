import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const STALE_KYB_FIX = "npm install -g @kybernesis/create@latest";

export type SelfVersionResult =
  | { kind: "stale"; installed: string; latest: string; message: string; fix: typeof STALE_KYB_FIX }
  | { kind: "current"; installed: string; latest: string }
  | { kind: "ahead"; installed: string; latest: string }
  | { kind: "unknown"; installed?: string; latest?: string };

function usableVersion(value: string | undefined): value is string {
  return Boolean(value && /^\d+\.\d+\.\d+$/.test(value));
}

/** Compare the three numeric version components exactly as upgrade historically has. */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

/** Look up this CLI's published version. Unknown lookup state is deliberately non-blocking. */
export function checkSelfVersion(): SelfVersionResult {
  let installed: string | undefined;
  try {
    installed = (JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown }).version as string | undefined;
  } catch {
    return { kind: "unknown" };
  }

  let latest: string | undefined;
  try {
    const result = spawnSync("npm", ["view", "@kybernesis/create", "version"], {
      encoding: "utf8",
      env: process.env,
    });
    if (result.status === 0) latest = result.stdout.trim();
  } catch {
    return { kind: "unknown", installed };
  }

  if (!usableVersion(installed) || !usableVersion(latest)) {
    return { kind: "unknown", ...(installed ? { installed } : {}), ...(latest ? { latest } : {}) };
  }
  if (installed === latest) return { kind: "current", installed, latest };
  if (versionLt(installed, latest)) {
    return {
      kind: "stale",
      installed,
      latest,
      message:
        `kyb ${installed} is behind ${latest}. The certified eve version is ` +
        "compiled into this tool, so an old kyb reports an old pin as current.",
      fix: STALE_KYB_FIX,
    };
  }
  return { kind: "ahead", installed, latest };
}
