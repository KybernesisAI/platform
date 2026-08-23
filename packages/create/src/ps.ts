import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

import { bold, dim, green, red, yellow } from "./util.js";
import { signIn } from "./register.js";

/**
 * `kyb ps` — what is REGISTERED, against what is actually LISTENING.
 *
 * Why this exists: nothing else in the stack makes that comparison, and its
 * absence is the single most expensive failure mode we have.
 *
 * Every surface lists registrations, not processes. The admin UI probes an eve
 * deployment from the cloud, so a `127.0.0.1` agent reads "unreachable" while
 * running perfectly — the badge is not wrong, it is answering a different
 * question, and it can never answer this one. `kyb doctor` reads the local repo
 * and reports what *would* ship. KYBER Studio dials a URL and shows one word.
 *
 * So a registered agent with nothing behind it is indistinguishable from a
 * healthy one until someone probes it from where the person sits. That is
 * exactly what this does, and why the check belongs in the CLI rather than in
 * anyone's notes: an agent registered on one port while its process listens on
 * another cost five days once, and the evidence was two numbers nobody had put
 * side by side.
 */

const DEFAULT_ISSUER = "https://agent.kybernesis.ai";
/** Ports worth probing when an agent is missing, so drift names itself. */
const COMMON_PORTS = [2000, 2100, 2200, 2300, 3000];

interface Agent {
  name: string;
  runtime?: string;
  url?: string | null;
}

/** The TUI/desktop device-flow session, reused so `kyb ps` needs no second sign-in. */
function cachedSession(): { token?: string; refreshToken?: string } | null {
  const p = join(homedir(), ".kybernesis", "tui-session.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Identity tokens live an hour. An expired one comes back as
 * `{"error":"unauthorized"}`, which reads like a permissions problem and is
 * not — so refresh first rather than trusting what is on disk.
 */
async function token(issuer: string): Promise<string | null> {
  const s = cachedSession();
  if (s?.refreshToken) {
    const res = await fetch(`${issuer}/api/oauth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    }).catch(() => null);
    if (res?.ok) {
      const body = (await res.json().catch(() => ({}))) as { token?: string };
      if (body.token) return body.token;
    }
  }
  if (s?.token) return s.token;
  return signIn(issuer);
}

function localPort(url: string): number | null {
  if (!/127\.0\.0\.1|localhost/.test(url)) return null;
  const m = /:(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(600);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Health is the only honest signal, and it must be taken from HERE. */
async function healthy(url: string): Promise<boolean> {
  const res = await fetch(`${url.replace(/\/$/, "")}/eve/v1/health`, {
    signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  return Boolean(res?.ok);
}

export async function ps(): Promise<void> {
  const issuer = (process.env.KYBERNESIS_ISSUER || DEFAULT_ISSUER).replace(/\/$/, "");
  console.log(bold("kyb ps"));
  console.log(dim(`  issuer: ${issuer}\n`));

  const tok = await token(issuer);
  if (!tok) {
    console.log(red("  Could not obtain an identity token."));
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${issuer}/api/me/agents`, {
    headers: { authorization: `Bearer ${tok}` },
  }).catch(() => null);
  if (!res?.ok) {
    console.log(red(`  Could not list agents (${res ? res.status : "unreachable"}).`));
    process.exitCode = 1;
    return;
  }

  const agents = ((await res.json()) as { agents?: Agent[] }).agents ?? [];
  if (agents.length === 0) {
    console.log("  No agents registered.");
    return;
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`  ${pad("AGENT", 20)} ${pad("REGISTERED", 30)} STATE`);
  console.log(dim(`  ${"-".repeat(74)}`));

  const problems: string[] = [];
  for (const a of agents) {
    const url = a.url ?? "";
    if (!url) {
      console.log(`  ${pad(a.name, 20)} ${pad("(none)", 30)} ${yellow("no URL registered")}`);
      problems.push(`${a.name}: registered with no URL — kyb register --url=…`);
      continue;
    }
    const port = localPort(url);
    if (port === null) {
      const up = await healthy(url);
      console.log(`  ${pad(a.name, 20)} ${pad(url, 30)} ${up ? green("up (remote)") : red("not answering")}`);
      if (!up) problems.push(`${a.name}: remote host is not answering`);
      continue;
    }
    if (await healthy(url)) {
      console.log(`  ${pad(a.name, 20)} ${pad(url, 30)} ${green("up")}`);
      continue;
    }
    if (await listening(port)) {
      console.log(`  ${pad(a.name, 20)} ${pad(url, 30)} ${yellow("port open, health failing")}`);
      problems.push(`${a.name}: something holds ${port} but /eve/v1/health does not answer`);
      continue;
    }
    // The money check. A registered port with nothing on it, while a
    // NEIGHBOURING port is live, is drift — and saying so turns a silent
    // "fetch failed" into a one-line fix.
    const elsewhere: number[] = [];
    for (const q of COMMON_PORTS) if (q !== port && (await listening(q))) elsewhere.push(q);
    if (elsewhere.length) {
      console.log(`  ${pad(a.name, 20)} ${pad(url, 30)} ${red("down")} ${dim(`— something is live on ${elsewhere.join(", ")}`)}`);
      problems.push(`${a.name}: PORT DRIFT — registered ${port}, something live on ${elsewhere.join(", ")}`);
    } else {
      console.log(`  ${pad(a.name, 20)} ${pad(url, 30)} ${red("down")} ${dim(`— nothing on ${port}`)}`);
      problems.push(`${a.name}: not running on ${port} — kyb start`);
    }
  }

  if (problems.length === 0) {
    console.log(green("\n  All registered agents are answering."));
    return;
  }
  console.log(bold("\n  Problems"));
  for (const p of problems) console.log(`    - ${p}`);
  console.log(
    dim(
      "\n  Reading the symptom before touching anything:\n" +
        "    fetch failed  transport — nothing is listening. Do not hunt keys or grants.\n" +
        "    403           it IS up; you lack a grant.\n" +
        "    unreachable   in the admin UI, for a 127.0.0.1 agent, only ever means the\n" +
        "                  cloud cannot reach your machine. It is always true.",
    ),
  );
}
