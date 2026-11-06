import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

/**
 * The engineer's eyes: render a page in a real browser inside the sandbox and
 * hand the PIXELS to the model via a content-part tool output, so the agent
 * can visually verify its own work (proven pattern: hidden-stamp vision test,
 * 3/3 correct reads, ~6s warm turns).
 *
 * Requires the workshop sandbox template (Playwright + Chromium baked into
 * the template bootstrap — written by the registry item / kyb init --engineer).
 *
 * Operational notes baked into the design:
 * - Screenshots are "look at this NOW": eve re-sends image parts on every
 *   later model call and DROPS them on compaction. The tool also saves every
 *   capture under /workspace/.screenshots/ so an artifact can be re-taken or
 *   re-read later.
 * - Keep viewports modest; eve warns above 3 MiB per image part, and no side
 *   may pass MAX_SCREENSHOT_SIDE (see below).
 */

/**
 * The tallest or widest screenshot this tool returns, in pixels.
 *
 * eve inlines images up to 8000 px a side, but Anthropic refuses any image
 * over 3000 px a side once a request carries many images, and eve re-sends
 * every screenshot on every later call until history compacts. A full-page
 * capture of a long phone-width page (390x11923 in the case that found this)
 * is small in bytes, passes the size check, and then fails every later model
 * call in the session once a few more screenshots pile up. 2000 leaves margin
 * under that limit. Taller pages come back one slice at a time.
 */
const MAX_SCREENSHOT_SIDE = 2000;

const SHOT_RUNNER = `
const { chromium } = require('playwright');
const [, , target, outPath, width, height, fullPage, offsetY, maxSide] = process.argv;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
  await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });
  const pageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
  const max = Number(maxSide);
  let y = 0;
  let h = Number(height);
  if (fullPage === 'true') {
    y = Math.max(0, Math.min(Number(offsetY), Math.max(0, pageHeight - 1)));
    h = Math.max(1, Math.min(max, pageHeight - y));
    await page.screenshot({ path: outPath, fullPage: true, clip: { x: 0, y, width: Number(width), height: h } });
  } else {
    await page.screenshot({ path: outPath });
  }
  await browser.close();
  console.log(JSON.stringify({ pageHeight, y, h }));
})().catch((error) => { console.error(String(error)); process.exit(1); });
`;

/** Width and height from a PNG's IHDR chunk, or undefined if the bytes are not a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** What the runner printed about the page and the slice it captured. */
function parseLayout(stdout: string): { pageHeight: number; y: number; h: number } | undefined {
  const line = stdout.trim().split("\n").pop();
  try {
    const parsed = JSON.parse(line ?? "") as { pageHeight?: unknown; y?: unknown; h?: unknown };
    if (typeof parsed.pageHeight === "number" && typeof parsed.y === "number" && typeof parsed.h === "number") {
      return { pageHeight: parsed.pageHeight, y: parsed.y, h: parsed.h };
    }
  } catch {
    /* older runner or no output */
  }
  return undefined;
}

export default defineTool({
  description:
    "Render a page in a real browser inside the sandbox and RETURN A SCREENSHOT YOU CAN SEE. Pass `url` for a running server (e.g. http://localhost:3000 started with the sandbox) or `html` for a standalone page. Use this to visually verify work before claiming it is done. `fullPage` captures below the fold, at most 2000 px of the page per call: on a taller page it returns the slice starting at `offsetY` and tells you where the next slice starts.",
  inputSchema: z.object({
    url: z.string().optional(),
    html: z.string().optional(),
    width: z.number().int().min(320).max(1920).default(1024),
    height: z.number().int().min(240).max(1200).default(768),
    fullPage: z.boolean().default(false),
    offsetY: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("With fullPage, where the slice starts, in CSS pixels from the top of the page."),
  }),
  async execute({ url, html, width, height, fullPage, offsetY }, ctx) {
    if (!url && !html) throw new Error("Pass either `url` or `html`.");
    const sandbox = await ctx.getSandbox();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const outPath = `/workspace/.screenshots/${id}.png`;
    await sandbox.run({ command: "mkdir -p /workspace/.screenshots /workspace/.shot" });
    await sandbox.writeTextFile({ path: ".shot/runner.js", content: SHOT_RUNNER });

    let target = url;
    if (!target) {
      await sandbox.writeTextFile({ path: `.shot/${id}.html`, content: html! });
      target = `file:///workspace/.shot/${id}.html`;
    }

    const result = await sandbox.run({
      command: `cd /workspace/.shot && node runner.js ${JSON.stringify(target)} ${JSON.stringify(outPath)} ${width} ${height} ${fullPage} ${offsetY ?? 0} ${MAX_SCREENSHOT_SIDE}`,
    });
    const bytes = await sandbox.readBinaryFile({ path: outPath });
    if (!bytes) {
      throw new Error(
        `Screenshot failed for ${target}: ${(result.stderr || result.stdout || "no output").slice(0, 500)}. ` +
          "If Playwright is missing, the workshop sandbox bootstrap has not run — check agent/sandbox/sandbox.ts.",
      );
    }
    // Belt and braces: never hand the model an image a later call cannot carry,
    // whatever the runner did (an old runner.js, a device scale factor).
    const size = pngSize(bytes);
    if (size && (size.width > MAX_SCREENSHOT_SIDE || size.height > MAX_SCREENSHOT_SIDE)) {
      throw new Error(
        `Screenshot is ${size.width}x${size.height} px, over the ${MAX_SCREENSHOT_SIDE} px limit a model call can carry ` +
          "alongside other images. Use a smaller viewport, or fullPage with offsetY to look at one slice at a time.",
      );
    }
    const pngBase64 = Buffer.from(bytes).toString("base64");
    if (pngBase64.length > 2_800_000) {
      throw new Error("Screenshot exceeds the safe image-part size; reduce the viewport or avoid fullPage.");
    }
    const layout = parseLayout(result.stdout ?? "");
    const shown = fullPage && layout ? { from: layout.y, to: layout.y + layout.h, pageHeight: layout.pageHeight } : undefined;
    const nextOffsetY = shown && shown.to < shown.pageHeight ? shown.to : undefined;
    return {
      savedAt: outPath,
      target,
      byteSize: bytes.byteLength,
      ...(size ? { width: size.width, height: size.height } : {}),
      ...(shown ? { shown } : {}),
      ...(nextOffsetY !== undefined ? { nextOffsetY } : {}),
      pngBase64,
    };
  },
  toModelOutput(output) {
    const slice = output.shown
      ? ` It shows the page from ${output.shown.from} to ${output.shown.to} px of ${output.shown.pageHeight} px.` +
        (output.nextOffsetY !== undefined
          ? ` To see more, call again with fullPage and offsetY ${output.nextOffsetY}.`
          : " That is the bottom of the page.")
      : "";
    return toolOutput.content([
      toolOutputPart.text(
        `Screenshot of ${output.target} (${output.byteSize} bytes, saved at ${output.savedAt}).${slice} Look carefully and verify it matches the intent:`,
      ),
      toolOutputPart.file(output.pngBase64, { mediaType: "image/png" }),
    ]);
  },
});
