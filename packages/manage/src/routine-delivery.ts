import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCards, updateThread, type RunCapture } from "./thread.js";

/**
 * Where a routine's answer goes.
 *
 * By default it is a report in its owner's thread, which KYBER Studio and the
 * phone show and which rings the phone. A person setting one up can name
 * somewhere else instead ("list the open PRs in #dev on Buzz every morning"),
 * and then it goes there and only there: the room sees it, the thread does not,
 * and nobody's phone rings for it.
 *
 * Two ways to get there, because the surfaces differ:
 *
 * - Slack and iMessage are eve channels on this agent. The routine starts its
 *   turn on that channel (`to(slack, …)`, `to(linq, …)`), and the channel posts
 *   the reply the way it posts every reply.
 * - Buzz is a bridge, not an eve channel. The routine runs in the background on
 *   the manage channel like any other, and when it has an answer manage posts it
 *   into the room as the agent (`kybernesis-buzz post`).
 *
 * The destination is resolved once, when the routine is made: a room's name
 * becomes its id, so renaming the room or adding a second one with the same
 * name never moves where an existing routine posts.
 */
export type RoutineDelivery =
  | { surface: "buzz"; channel: string; name: string; relay?: string }
  | { surface: "slack"; channel: string; name?: string }
  | { surface: "imessage"; threadId: string };

/** What a person (or the model, for them) asks for. */
export interface DeliverToInput {
  /** "studio" (the default), "buzz", "slack" or "imessage". */
  surface?: string;
  /** The room: a Buzz or Slack channel name like "#dev", or its id. */
  channel?: string;
}

export const DELIVERY_SURFACES = ["studio", "buzz", "slack", "imessage"] as const;

/** How the destination reads to a person: "Buzz #dev". */
export function deliveryLabel(delivery: RoutineDelivery | undefined): string {
  if (!delivery) return "KYBER Studio";
  if (delivery.surface === "buzz") return `Buzz #${delivery.name}`;
  if (delivery.surface === "slack") return `Slack ${delivery.name ? `#${delivery.name}` : delivery.channel}`;
  return "iMessage";
}

/**
 * The line a routine's instruction carries when it delivers somewhere else, so
 * the answer is written for the room and the agent does not post it twice.
 */
export function deliveryNote(delivery: RoutineDelivery): string {
  return `(Your answer is posted for you as one message in ${deliveryLabel(delivery)}. Write it for whoever reads it there, and do not post it anywhere yourself.)`;
}

/** The eve channel module and target a Slack or iMessage routine starts its turn on. */
export function deliveryDestination(delivery: RoutineDelivery): { channel: string; target: Record<string, unknown> } | undefined {
  if (delivery.surface === "slack") return { channel: "slack", target: { channelId: delivery.channel } };
  if (delivery.surface === "imessage") return { channel: "linq", target: { threadId: delivery.threadId } };
  return undefined;
}

export interface ResolveOptions {
  appRoot: string;
  /** Who the routine runs as: their iMessage thread is the one it texts. */
  principalId?: string;
  /** Runs `kybernesis-buzz`; a test passes its own. */
  buzz?: (args: string[], input?: string) => Promise<string>;
  /** Slack's API; a test passes its own. */
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const norm = (name: string) => name.trim().replace(/^#/, "").toLowerCase();

/**
 * Turn what was asked for into a destination this agent can actually reach, or
 * say plainly why not. Undefined means the default: the owner's thread.
 */
export async function resolveRoutineDelivery(input: DeliverToInput | undefined, options: ResolveOptions): Promise<RoutineDelivery | undefined> {
  const surface = norm(input?.surface ?? "studio").replace(/[\s_-]/g, "");
  const channel = input?.channel?.trim();
  if (surface === "" || surface === "studio" || surface === "kyberstudio" || surface === "phone" || surface === "thread") return undefined;
  if (surface === "buzz") return resolveBuzz(channel, options);
  if (surface === "slack") return resolveSlack(channel, options);
  if (surface === "imessage" || surface === "sms" || surface === "text" || surface === "linq") return resolveIMessage(options);
  throw new Error(`This agent can deliver a routine to ${reachable(options.appRoot).join(", ")}; "${input?.surface}" is not one of them.`);
}

/** The surfaces this agent has, for an honest error. */
export function reachable(appRoot: string): string[] {
  const out = ["Studio (the default)"];
  if (existsSync(buzzBin(appRoot))) out.push("Buzz");
  if (existsSync(join(appRoot, "agent/channels/slack.ts"))) out.push("Slack");
  if (existsSync(join(appRoot, "agent/channels/linq.ts"))) out.push("iMessage");
  return out;
}

function buzzBin(appRoot: string): string {
  return join(appRoot, "node_modules", ".bin", "kybernesis-buzz");
}

/** Run the agent's own `kybernesis-buzz`, in its directory and environment, as the agent's `buzz` tool runs. */
export function runBuzz(appRoot: string, env: NodeJS.ProcessEnv = process.env) {
  return (args: string[], input?: string): Promise<string> =>
    new Promise((done, fail) => {
      const bin = buzzBin(appRoot);
      if (!existsSync(bin)) {
        fail(new Error("This agent is not on Buzz (@kybernesis/buzz is not installed)."));
        return;
      }
      const child = spawn(bin, args, { cwd: appRoot, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done(stdout);
        else fail(new Error((stderr || stdout).trim() || `kybernesis-buzz exited ${code}`));
      });
      child.stdin.end(input ?? "");
    });
}

interface BuzzRoom {
  id: string;
  name: string;
  relay: string;
}

async function resolveBuzz(channel: string | undefined, options: ResolveOptions): Promise<RoutineDelivery> {
  if (!channel) throw new Error('Say which Buzz channel, e.g. "#dev".');
  const buzz = options.buzz ?? runBuzz(options.appRoot, options.env);
  const listed = JSON.parse(await buzz(["channels"])) as { channels?: BuzzRoom[]; unreadable?: { relay: string; error: string }[] };
  const rooms = listed.channels ?? [];
  const byId = rooms.filter((room) => room.id === channel);
  const matches = byId.length ? byId : rooms.filter((room) => room.name.toLowerCase() === norm(channel));
  if (matches.length === 1) {
    const room = matches[0]!;
    // Only named when the agent is in more than one community: the post has to pick one.
    const several = new Set(rooms.map((r) => r.relay)).size > 1;
    return { surface: "buzz", channel: room.id, name: room.name, ...(several ? { relay: room.relay } : {}) };
  }
  if (matches.length > 1) {
    throw new Error(
      `There is more than one Buzz channel called #${norm(channel)}: ${matches.map((m) => `${m.id} (${m.relay})`).join(", ")}. Ask which one and pass its id.`,
    );
  }
  const unread = listed.unreadable?.length ? ` (could not read ${listed.unreadable.map((u) => u.relay).join(", ")})` : "";
  const names = [...new Set(rooms.map((room) => `#${room.name}`))].slice(0, 40).join(", ");
  throw new Error(`No Buzz channel called #${norm(channel)}${unread}. The channels are: ${names || "none"}.`);
}

async function resolveSlack(channel: string | undefined, options: ResolveOptions): Promise<RoutineDelivery> {
  if (!existsSync(join(options.appRoot, "agent/channels/slack.ts"))) throw new Error("This agent is not on Slack.");
  if (!channel) throw new Error('Say which Slack channel, e.g. "#dev".');
  if (/^[CGDU][A-Z0-9]{6,}$/.test(channel)) return { surface: "slack", channel };
  const token = (options.env ?? process.env).SLACK_BOT_TOKEN;
  if (!token) throw new Error("Give the Slack channel's id (it starts with C); I cannot look names up here.");
  const doFetch = options.fetch ?? fetch;
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const url = `https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { ok?: boolean; error?: string; channels?: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } };
    if (!body.ok) throw new Error(`Slack would not list channels (${body.error ?? res.status}); give the channel's id instead.`);
    const hit = body.channels?.find((c) => c.name.toLowerCase() === norm(channel));
    if (hit) return { surface: "slack", channel: hit.id, name: hit.name };
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  throw new Error(`No Slack channel called #${norm(channel)} that I can see. Invite me to it, or give its id.`);
}

/**
 * The person's own iMessage thread with this agent. Read from where heads-ups
 * already look it up (the conversation they last used, recorded per person),
 * so it is known when they ask over iMessage.
 */
function resolveIMessage(options: ResolveOptions): RoutineDelivery {
  if (!existsSync(join(options.appRoot, "agent/channels/linq.ts"))) throw new Error("This agent is not on iMessage.");
  const dir = join(options.appRoot, ".kyb", "magic", "people");
  if (options.principalId && existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      try {
        const surface = JSON.parse(readFileSync(join(dir, entry, "surface.json"), "utf8")) as {
          token?: string;
          auth?: { principalId?: string };
        };
        if (surface.auth?.principalId !== options.principalId) continue;
        // Recorded as `<channel>:<thread id>`; the thread id has its own adapter prefix.
        const threadId = surface.token?.startsWith("linq:") ? surface.token.slice("linq:".length) : undefined;
        if (threadId?.includes(":")) return { surface: "imessage", threadId };
      } catch {
        /* someone else's record, or none */
      }
    }
  }
  throw new Error("I can only find your iMessage thread when you ask from it. Text me there and ask again.");
}

/** Post a finished routine's answer into its Buzz room. */
export async function postToBuzz(
  delivery: Extract<RoutineDelivery, { surface: "buzz" }>,
  text: string,
  buzz: (args: string[], input?: string) => Promise<string>,
): Promise<void> {
  await buzz(["post", "--channel", delivery.channel, ...(delivery.relay ? ["--relay", delivery.relay] : [])], text);
}

/** A delivery read back from a routine file or a run's state; undefined unless it is well formed. */
export function asDelivery(value: unknown): RoutineDelivery | undefined {
  const v = value as Partial<Record<string, unknown>> | null | undefined;
  if (!v || typeof v !== "object") return undefined;
  if (v.surface === "buzz" && typeof v.channel === "string" && typeof v.name === "string") {
    return { surface: "buzz", channel: v.channel, name: v.name, ...(typeof v.relay === "string" ? { relay: v.relay } : {}) };
  }
  if (v.surface === "slack" && typeof v.channel === "string") {
    return { surface: "slack", channel: v.channel, ...(typeof v.name === "string" ? { name: v.name } : {}) };
  }
  if (v.surface === "imessage" && typeof v.threadId === "string") return { surface: "imessage", threadId: v.threadId };
  return undefined;
}

/**
 * A background run's turn ended: deliver what it had to say.
 *
 * Its final answer and cards become a report in its owner's thread, which
 * Studio and the phone show. A run that named a Buzz room posts its answer
 * there instead, and nothing goes to the thread; if the post fails the answer
 * is not lost, it lands in the thread saying why. A run that said nothing
 * (no_reply) delivers nothing anywhere.
 */
export async function settleRun(input: {
  owner: string;
  routine?: string;
  deliver?: RoutineDelivery;
  sessionId: string;
  run?: RunCapture;
  threads: string | null;
  buzz: (args: string[], input?: string) => Promise<string>;
}): Promise<void> {
  const { owner, sessionId, threads, deliver } = input;
  const routine = input.routine ?? "routine";
  let text = input.run?.text ?? "";
  const cards = input.run ? runCards(input.run) : [];
  const settleQuestions = () => {
    if (!threads) return;
    updateThread(threads, owner, (r) => {
      for (const q of r.reports) if (q.runSessionId === sessionId && q.kind === "question") q.settled = true;
    });
  };
  if (deliver?.surface === "buzz") {
    if (!text.trim()) return settleQuestions();
    try {
      await postToBuzz(deliver, text, input.buzz);
      console.log(`[kyb] routine ${routine} posted in ${deliveryLabel(deliver)}`);
      return settleQuestions();
    } catch (error) {
      const why = (error as Error).message.slice(0, 300);
      console.error(`[kyb] routine ${routine} could not post in ${deliveryLabel(deliver)}: ${why}`);
      text = `Could not post this in ${deliveryLabel(deliver)} (${why}):\n\n${text}`;
    }
  }
  if (!threads) return;
  updateThread(threads, owner, (r) => {
    for (const q of r.reports) if (q.runSessionId === sessionId && q.kind === "question") q.settled = true;
    if (!text && cards.length === 0) return;
    r.reports.push({
      id: `${sessionId}:${r.reports.length}`,
      kind: "report",
      routine,
      text,
      ...(cards.length ? { cards } : {}),
      at: new Date().toISOString(),
      runSessionId: sessionId,
    });
  });
}
