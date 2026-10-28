import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KIND_CHANNEL_METADATA, type NostrEvent } from "./relay.js";
import { queryRelay } from "./query.js";

/**
 * Posting into a channel when nobody spoke first.
 *
 * @remarks
 * Everything else the bridge says is a reply: a person writes, the agent answers
 * in the same place. A routine has no one to answer. It runs on the agent's own
 * schedule and its result belongs in a room someone named when they set it up
 * ("post the open PRs in #dev every morning"). `kybernesis-buzz channels` finds
 * that room by name, once, when the routine is made; `kybernesis-buzz post`
 * puts each result there. Both run as the agent's own identity, the same one
 * its `buzz` tool acts as, from the same environment.
 */

/** One room the agent could post in. */
export interface BuzzChannel {
  /** The channel id, as `--channel` and every `h` tag take it. */
  id: string;
  /** Its name without the leading `#`, as people say it. */
  name: string;
  /** The community it lives in (the configured `BUZZ_RELAY` entry). */
  relay: string;
}

/** The communities this agent belongs to, as configured for the bridge. */
export function configuredRelays(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BUZZ_RELAY ?? env.BUZZ_RELAY_HTTP ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Where the agent's identity lives: the same default its `buzz` tool uses. */
function keyFile(env: NodeJS.ProcessEnv): string {
  return env.BUZZ_KEYFILE ?? ".buzz-key.json";
}

function secretKey(file: string): Uint8Array {
  const stored = JSON.parse(readFileSync(file, "utf8")) as { secretKey: number[] };
  return Uint8Array.from(stored.secretKey);
}

const httpOf = (relay: string) => relay.replace(/^ws/, "http").replace(/\/$/, "");

/**
 * The rooms in a set of channel metadata events, without direct messages.
 *
 * NIP-29 as Buzz writes it: `d` is the id, `name` the name, and the FIRST `t`
 * is the channel's type. A DM is a conversation between two people, never a
 * room a routine should post its report into.
 */
export function channelsFrom(events: readonly NostrEvent[], relay: string): BuzzChannel[] {
  const out = new Map<string, BuzzChannel>();
  for (const event of events) {
    if (event.kind !== KIND_CHANNEL_METADATA) continue;
    const id = event.tags.find((t) => t[0] === "d")?.[1];
    if (!id) continue;
    if (event.tags.find((t) => t[0] === "t")?.[1] === "dm") continue;
    const name = event.tags.find((t) => t[0] === "name")?.[1]?.trim().replace(/^#/, "");
    if (!name) continue;
    out.set(id, { id, name, relay });
  }
  return [...out.values()];
}

/** Every room in every community this agent belongs to. A community that cannot be read is skipped, and said. */
export async function listChannels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ channels: BuzzChannel[]; unreadable: { relay: string; error: string }[] }> {
  const file = keyFile(env);
  if (!existsSync(file)) throw new Error(`No Buzz identity at ${file}: this agent is not in a Buzz workspace.`);
  const relays = configuredRelays(env);
  if (relays.length === 0) throw new Error("No Buzz relay configured (BUZZ_RELAY): this agent is not in a Buzz workspace.");
  const key = secretKey(file);
  const channels: BuzzChannel[] = [];
  const unreadable: { relay: string; error: string }[] = [];
  for (const relay of relays) {
    try {
      const { events } = await queryRelay(httpOf(relay), key, [{ kinds: [KIND_CHANNEL_METADATA], limit: 1000 }]);
      channels.push(...channelsFrom(events, relay));
    } catch (error) {
      unreadable.push({ relay, error: (error as Error).message });
    }
  }
  return { channels, unreadable };
}

/**
 * Post one message into a channel, as this agent, through the Buzz CLI.
 *
 * The CLI rather than our own socket: `messages send` is the path the agent's
 * `buzz` tool already takes every day, so a routine's post and an agent's own
 * post are the same thing to the relay. The words go in on stdin (`--content
 * -`), so newlines arrive as newlines and nothing in them is ever an argument.
 */
export async function postMessage(
  input: { channel: string; text: string; relay?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const relays = configuredRelays(env);
  if (relays.length === 0) throw new Error("No Buzz relay configured (BUZZ_RELAY).");
  let relay: string;
  if (input.relay) {
    const matches = relays.filter((entry) => entry === input.relay || entry.includes(input.relay!));
    if (matches.length !== 1) throw new Error(`"${input.relay}" does not pick out exactly one of: ${relays.join(", ")}`);
    relay = matches[0]!;
  } else if (relays.length > 1) {
    throw new Error(`This agent belongs to more than one workspace; say which with --relay: ${relays.join(", ")}`);
  } else {
    relay = relays[0]!;
  }
  const file = keyFile(env);
  if (!existsSync(file)) throw new Error(`No Buzz identity at ${file}.`);
  if (!input.text.trim()) throw new Error("Nothing to post.");

  const local = ".buzz/bin/buzz";
  const binary = env.BUZZ_CLI_PATH ?? (existsSync(local) ? resolve(local) : "buzz");
  return new Promise((done, fail) => {
    const child = spawn(binary, ["messages", "send", "--channel", input.channel, "--content", "-"], {
      env: { ...env, BUZZ_RELAY_URL: httpOf(relay), BUZZ_PRIVATE_KEY: Buffer.from(secretKey(file)).toString("hex") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(error.code === "ENOENT" ? new Error(`The Buzz CLI is not installed (looked for "${binary}"). Run: kybernesis-buzz install-cli`) : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout.trim());
      else fail(new Error(stderr.trim() || stdout.trim() || `buzz exited ${code}`));
    });
    child.stdin.end(input.text);
  });
}
