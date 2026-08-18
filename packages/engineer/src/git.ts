/**
 * Git against a real remote, from inside a sandbox, without handing the
 * sandbox a credential.
 *
 * An agent that writes code eventually has to push it, and the obvious way to
 * let it — put a token in the sandbox environment, or in the remote URL — makes
 * that token part of everything the sandbox can do. Anything the model writes
 * can read it, print it, or send it somewhere else, and a token that reaches a
 * model's context has to be treated as disclosed.
 *
 * The alternative is to keep the credential outside and let the sandbox's own
 * network policy attach it on the way out. The model runs ordinary git commands
 * against an ordinary HTTPS URL; the firewall adds the authorization header to
 * egress for that host and nothing else. Nothing inside can read the secret,
 * because it was never in there.
 *
 * The other half is what the push may target. A branch name reaches a command
 * line, and the default branch is exactly what a mistaken agent would push to,
 * so both are decided here rather than asked of the model in prose.
 */

/**
 * A network policy shaped for eve's sandbox `use({ networkPolicy })`.
 *
 * Declared structurally rather than imported so this module stays usable from
 * a plain script — a deploy check, a test — that has no sandbox in hand.
 */
export interface BrokeredGitPolicy {
  allow: Record<string, unknown[]>;
}

export interface BrokeredGitOptions {
  /** The credential, already resolved. Never interpolated into a URL. */
  token: string;
  /** Git host to broker onto. Defaults to github.com. */
  host?: string;
  /**
   * The username half of HTTP basic auth. GitHub installation tokens use
   * `x-access-token`; other hosts differ, and getting it wrong reads as a
   * mysterious 403 on push rather than as a credential problem.
   */
  username?: string;
}

/**
 * Attach a git credential to sandbox egress for one host.
 *
 * `"*": []` leaves general egress open, so package installs and test runs keep
 * working while the policy is active. Narrow that separately if a job should
 * not reach the internet at large — but narrow it deliberately, because a
 * sandbox that cannot install dependencies cannot verify its own work.
 */
export function brokeredGitPolicy(options: BrokeredGitOptions): BrokeredGitPolicy {
  const host = options.host ?? "github.com";
  const username = options.username ?? "x-access-token";
  const authorization = `Basic ${Buffer.from(`${username}:${options.token}`).toString("base64")}`;
  return {
    allow: {
      "*": [],
      [host]: [{ transform: [{ headers: { Authorization: authorization } }] }],
    },
  };
}

/**
 * The URL every clone, fetch and push should name, literally.
 *
 * Not `origin`. Remote configuration inside a sandbox — `pushurl`,
 * `pushDefault`, a per-branch remote — is writable by anything running in
 * there, so a command that pushes to `origin` can be redirected to a host the
 * broker never meant to authorize, taking the header with it.
 */
export function httpsRemote(repo: string, host = "github.com"): string {
  return `https://${host}/${repo}.git`;
}

/**
 * Branch names that may not be pushed to, whatever the agent believes.
 *
 * The default branch is where an agent goes when it is confused about how to
 * deliver work, which is the moment you least want it to succeed.
 */
export const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

/**
 * A conservative subset of valid branch names: alphanumeric segments joined by
 * `.`, `_`, `-` or `/`. Everything interpolated into a git command has to match
 * this, so shell metacharacters never reach a command line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Why this branch may not be used, or null when it may.
 *
 * Returns a sentence rather than a boolean because the caller's job is usually
 * to hand it back to the model, and "that is not a valid branch name" is
 * actionable where `false` is not.
 */
export function refuseBranch(
  branch: string,
  options: { protect?: readonly string[] } = {},
): string | null {
  const protectedBranches = new Set(options.protect ?? DEFAULT_PROTECTED_BRANCHES);
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.includes("//")) {
    return `"${branch}" is not a valid branch name.`;
  }
  // `refs/heads/main` and `HEAD` are the same place under another name, so the
  // protected check below only means anything if plain names are the only ones
  // that get this far.
  if (branch.startsWith("refs/") || branch === "HEAD") {
    return `"${branch}" is not a plain branch name. Pass it without a refs/ prefix.`;
  }
  if (protectedBranches.has(branch)) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  return null;
}
