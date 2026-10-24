import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { card, forModel, withCards } from "@kybernesis/cards";
import { computer_use } from "eve/computer-use/tools";
import { defineTool, type ToolContext } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { CHROME_DEBUG_PORT } from "./provider.js";

type Exec = NonNullable<typeof computer_use.execute>;
type ComputerUseInput = Parameters<Exec>[0];
type ComputerUseResult = Exclude<Awaited<ReturnType<Exec>>, AsyncIterable<unknown>>;

export interface ShowScreenOptions {
  /**
   * Where screenshots are kept. Defaults to SCREENS_DIR, then
   * ~/.kybernesis/screens: the directory `@kybernesis/manage` serves at
   * `/eve/v1/kyb/screens/<id>`, to the person each one was taken for.
   */
  dir?: string;
}

interface PrincipalContext {
  session?: {
    auth?: {
      current?: {
        principalId?: string;
        principalType?: string;
        authenticator?: string;
      } | null;
    };
  };
}

/**
 * Who a screenshot is for: the person in the conversation when they signed in
 * through the control plane, otherwise nobody (a routine, a background turn),
 * which manage shows only to the people who manage the agent.
 */
function ownerOf(ctx: PrincipalContext): string | null {
  const current = ctx.session?.auth?.current;
  return current?.principalId && current.authenticator === "kybernesis" && current.principalType === "user" ? current.principalId : null;
}

/** Width and height from a PNG's header, when the bytes are one. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Show the person what the agent's computer is showing, as a screenshot card.
 *
 * The image stays on the agent's machine. The card names it by an
 * unguessable id under manage's screens route, which serves it only to the
 * person it was taken for, so a checkout or an inbox on screen is never a
 * public link. Text-only channels get the caption and a line saying a
 * screenshot is in the app.
 */
export function showScreenTool(options: ShowScreenOptions = {}) {
  const run = computer_use.execute as (input: ComputerUseInput, ctx: ToolContext) => Promise<ComputerUseResult>;
  const dir = () => options.dir ?? process.env.SCREENS_DIR ?? join(homedir(), ".kybernesis", "screens");
  return defineTool({
    description:
      "Show the person a screenshot of your computer's screen, as a picture in their app. Use it when seeing the page helps them: a result you found, a form you filled before they approve it, an error you hit. Never while a password, a card number or a one-time code is visible on screen; wait until it is gone. The caption says in one line what they are looking at.",
    inputSchema: z.object({
      caption: z.string().max(200).describe("One line on what the screen shows, e.g. The order summary before checkout"),
    }),
    approval: never(),
    async execute(input, ctx) {
      const shot = await run({ request: { action: "screenshot" } }, ctx);
      const sandbox = await ctx.getSandbox();
      const bytes = await sandbox.readBinaryFile({ path: shot.screenshot });
      if (!bytes || !pngSize(bytes)) throw new Error("The screenshot came back empty. Check the computer is running and try again.");

      // The page on screen, for the card's label: Chrome's newest tab, host only.
      let site: string | undefined;
      try {
        const tabs = await sandbox.run({
          command: `curl -s --max-time 3 http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list || true`,
        });
        const pages = (JSON.parse(tabs.stdout || "[]") as { type?: string; url?: string }[]).filter((t) => t.type === "page");
        const url = pages[0]?.url ? new URL(pages[0].url) : null;
        if (url && (url.protocol === "https:" || url.protocol === "http:")) site = url.host + (url.pathname === "/" ? "" : url.pathname);
      } catch {
        // No Chrome, or no page: the card goes without a site.
      }

      const id = randomBytes(16).toString("hex");
      const size = pngSize(bytes)!;
      const takenAt = new Date().toISOString();
      const caption = input.caption.trim().slice(0, 200);
      mkdirSync(dir(), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir(), `${id}.png`), bytes, { mode: 0o600 });
      writeFileSync(
        join(dir(), `${id}.json`),
        JSON.stringify({ id, owner: ownerOf(ctx as PrincipalContext), takenAt, site, caption, ...size }),
        { mode: 0o600 },
      );

      return withCards(
        { shown: true, caption, site: site ?? null },
        card(
          "screenshot",
          { image: `/eve/v1/kyb/screens/${id}.png`, caption, site: site?.slice(0, 200), takenAt, ...size },
          { source: "Computer", text: `${caption} (a screenshot is in the KYBER Studio app)` },
        ),
      );
    },
    toModelOutput: (output) => forModel(output),
  });
}
