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
 * - Keep viewports modest; eve warns above 3 MiB per image part.
 */

const SHOT_RUNNER = `
const { chromium } = require('playwright');
const [, , target, outPath, width, height, fullPage] = process.argv;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
  await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: outPath, fullPage: fullPage === 'true' });
  await browser.close();
})().catch((error) => { console.error(String(error)); process.exit(1); });
`;

export default defineTool({
  description:
    "Render a page in a real browser inside the sandbox and RETURN A SCREENSHOT YOU CAN SEE. Pass `url` for a running server (e.g. http://localhost:3000 started with the sandbox) or `html` for a standalone page. Use this to visually verify work before claiming it is done.",
  inputSchema: z.object({
    url: z.string().optional(),
    html: z.string().optional(),
    width: z.number().int().min(320).max(1920).default(1024),
    height: z.number().int().min(240).max(1200).default(768),
    fullPage: z.boolean().default(false),
  }),
  async execute({ url, html, width, height, fullPage }, ctx) {
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
      command: `cd /workspace/.shot && node runner.js ${JSON.stringify(target)} ${JSON.stringify(outPath)} ${width} ${height} ${fullPage}`,
    });
    const bytes = await sandbox.readBinaryFile({ path: outPath });
    if (!bytes) {
      throw new Error(
        `Screenshot failed for ${target}: ${(result.stderr || result.stdout || "no output").slice(0, 500)}. ` +
          "If Playwright is missing, the workshop sandbox bootstrap has not run — check agent/sandbox/sandbox.ts.",
      );
    }
    const pngBase64 = Buffer.from(bytes).toString("base64");
    if (pngBase64.length > 2_800_000) {
      throw new Error("Screenshot exceeds the safe image-part size; reduce the viewport or avoid fullPage.");
    }
    return { savedAt: outPath, target, byteSize: bytes.byteLength, pngBase64 };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(
        `Screenshot of ${output.target} (${output.byteSize} bytes, saved at ${output.savedAt}). Look carefully and verify it matches the intent:`,
      ),
      toolOutputPart.file(output.pngBase64, { mediaType: "image/png" }),
    ]);
  },
});
