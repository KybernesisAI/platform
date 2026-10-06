import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolAuthProvider } from "eve/tools";

/**
 * The owner's Link sign-in, as the agent's wallet credential.
 *
 * `link-cli auth login` on the agent's host is a device-code flow the owner
 * approves in the Link app; the CLI keeps the resulting tokens in its config
 * file and refreshes them itself. This provider reads that file for the live
 * access token and, when it is about to expire, asks the CLI to refresh by
 * running one harmless command. No token is ever copied into env or source.
 *
 * Single-owner by design: every tool call through this mount spends from the
 * wallet signed in on this host. That is what Sid is — Ian's agent paying from
 * Ian's wallet, with Ian approving each purchase in Link. A shared agent needs
 * per-person OAuth through the control plane instead.
 */
export interface LinkCliAuthOptions {
  /** The CLI's config file. Defaults to LINK_AUTH_FILE, else the CLI's own default location. */
  authFile?: string;
  /** How close to expiry triggers a refresh. Default 2 minutes. */
  refreshSkewMs?: number;
  /** The CLI binary. Defaults to the one this package depends on. */
  cliPath?: string;
}

interface StoredAuth {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export function linkCliAuthFile(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LINK_AUTH_FILE) return process.env.LINK_AUTH_FILE;
  // `conf` with projectName "link-cli": ~/.config/link-cli-nodejs/config.json on Linux and macOS.
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "link-cli-nodejs", "config.json");
}

export function readStoredAuth(file: string): StoredAuth | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { auth?: StoredAuth | null };
    return parsed.auth ?? null;
  } catch {
    return null;
  }
}

export const NOT_SIGNED_IN =
  "Link is not signed in on this host. The owner runs `npx link-cli auth login --client-name <agent>` here and approves it in the Link app; the agent cannot do this step.";

function runCli(cliPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, { stdio: ["ignore", "ignore", "ignore"], env });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** An eve tool auth provider: the owner's current Link access token, refreshed through the CLI when near expiry. */
export function linkCliAuth(options: LinkCliAuthOptions = {}): ToolAuthProvider {
  const file = linkCliAuthFile(options.authFile);
  const skew = options.refreshSkewMs ?? 120_000;
  const cli = options.cliPath ?? "link-cli";
  return {
    principalType: "app",
    displayName: "Link wallet (owner's link-cli sign-in)",
    async getToken() {
      let auth = readStoredAuth(file);
      if (!auth?.access_token) throw new Error(NOT_SIGNED_IN);
      if (auth.expires_at !== undefined && auth.expires_at - Date.now() < skew) {
        // Any authenticated command makes the CLI refresh and persist. user-info is read-only.
        await runCli(cli, ["user-info", "retrieve", "--format", "json"], { ...process.env, LINK_AUTH_FILE: file, NO_UPDATE_NOTIFIER: "1" });
        auth = readStoredAuth(file);
        if (!auth?.access_token) throw new Error(NOT_SIGNED_IN);
      }
      return { token: auth.access_token, ...(auth.expires_at ? { expiresAt: auth.expires_at } : {}) };
    },
  } as ToolAuthProvider;
}
