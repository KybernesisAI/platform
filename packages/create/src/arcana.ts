import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ask, bold, dim, green, red, yellow } from "./util.js";

/**
 * Collect the memory workspaces and their keys, and check them before moving on.
 *
 * This exists because the registry item's `envVars` only APPENDS blank names to
 * .env.local — nothing ever asked for a value. So a scaffold finished looking
 * complete, with an agent whose memory could not work, and the first sign of it
 * was an agent that had lost its mind at runtime.
 *
 * It also stops guessing the workspace names. `<agent>-company` is a
 * convention, not a fact: a workspace with that name may already exist for
 * something else, or the client may have named theirs differently years ago.
 * The scaffolder proposes; the person deploying decides.
 */

const API = "https://api.arcana.kybernesis.ai";

/** Read a key/workspace pair the way the agent will: read-only, one call. */
async function check(workspace: string, key: string): Promise<"ok" | "forbidden" | "unreachable"> {
  try {
    const res = await fetch(`${API}/brain/${encodeURIComponent(workspace)}/timeline?limit=1`, {
      headers: { authorization: `Bearer ${key}`, "X-Kyberagent-Agent": workspace },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return "ok";
    // 403 is the one that matters: keys are workspace-scoped, and a key for the
    // wrong brain is the single most common way this is set up wrong.
    return res.status === 401 || res.status === 403 ? "forbidden" : "unreachable";
  } catch {
    return "unreachable";
  }
}

function upsertEnv(dir: string, values: Record<string, string>): void {
  const p = join(dir, ".env.local");
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    const line = `${k}="${v}"`;
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  }
  if (existsSync(p)) writeFileSync(p, text);
  else appendFileSync(p, text);
}

export interface ArcanaSetup {
  dir: string;
  /** Proposed workspace prefix — the agent's name. Only a suggestion. */
  suggest: string;
  /** Department subagents, each of which gets its own brain. */
  depts?: string[];
}

export async function configureArcana({ dir, suggest, depts = [] }: ArcanaSetup): Promise<void> {
  console.log(bold("\n     Memory (Arcana) — workspaces and keys"));
  console.log(
    dim(
      "     Create these at https://arcana.kybernesis.ai and mint a scoped kb_ key\n" +
        "     for each. Names are yours — the suggestions are only a convention.",
    ),
  );

  const values: Record<string, string> = {};
  let anyBad = false;

  const pair = async (label: string, workspaceVar: string, keyVar: string, proposed: string) => {
    const workspace = await ask(`     ${label} workspace?`, proposed);
    const key = await ask(`     ${label} key (kb_…, empty to skip)?`, "");
    if (!key) {
      console.log(yellow(`       skipped — ${keyVar} left unset`));
      values[workspaceVar] = workspace;
      return;
    }
    const state = await check(workspace, key);
    if (state === "ok") console.log(green(`       ✓ ${workspace} reachable`));
    else if (state === "forbidden") {
      anyBad = true;
      console.log(red(`       ✗ that key is not valid for "${workspace}" (keys are workspace-scoped)`));
    } else {
      console.log(yellow(`       ! could not reach Arcana to check — saved anyway`));
    }
    values[workspaceVar] = workspace;
    values[keyVar] = key;
  };

  await pair("Company", "ARCANA_COMPANY_WORKSPACE", "ARCANA_API_KEY", `${suggest}-company`);
  // The eval script the scaffolder writes REQUIRES this one; leaving it to a
  // template comment is how `npm run eval` fails on a fresh, correct install.
  await pair("Eval", "ARCANA_EVAL_API_KEY_WORKSPACE", "ARCANA_EVAL_API_KEY", `${suggest}-eval`);
  // The eval workspace name itself is derived by the npm script, so only the
  // key is stored; drop the placeholder we used to prompt with.
  delete values.ARCANA_EVAL_API_KEY_WORKSPACE;

  for (const dept of depts) {
    await pair(
      `Subagent "${dept}"`,
      `ARCANA_${dept.toUpperCase()}_WORKSPACE`,
      `ARCANA_${dept.toUpperCase()}_API_KEY`,
      `${suggest}-${dept}`,
    );
  }

  // DM sessions default to the company brain unless the deployment splits them.
  if (values.ARCANA_COMPANY_WORKSPACE) {
    values.ARCANA_DM_WORKSPACE ??= values.ARCANA_COMPANY_WORKSPACE;
  }

  upsertEnv(dir, values);
  console.log(dim("     written to .env.local"));
  if (anyBad) {
    console.log(
      yellow("     Fix the mismatched pair and re-run `kyb arcana` — `kyb doctor` checks them too."),
    );
  }
}
