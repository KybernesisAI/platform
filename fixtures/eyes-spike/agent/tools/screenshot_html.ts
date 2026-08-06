import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

const SHOT_SCRIPT = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('file:///workspace/shot/page.html');
  await page.screenshot({ path: '/workspace/shot/out.png' });
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
`;

export default defineTool({
  description:
    "Render an HTML page in a real browser inside the sandbox and return a screenshot the model can see. Pass complete HTML.",
  inputSchema: z.object({ html: z.string() }),
  async execute({ html }, ctx) {
    // Vision proof: stamp a code into the PIXELS that the model never sees in
    // text form (toModelOutput exposes only the image; the full return with
    // `stamp` goes to the event stream for the harness to verify against).
    const stamp = `KYB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const stamped = html.replace(
      /<\/body>/i,
      `<div style="position:fixed;top:8px;right:8px;background:#000;color:#fff;font:bold 20px monospace;padding:6px 10px;z-index:9999">${stamp}</div></body>`,
    );
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({
      path: "shot/page.html",
      content: stamped.includes(stamp) ? stamped : `${html}<div style="position:fixed;top:8px;right:8px;background:#000;color:#fff;font:bold 20px monospace;padding:6px 10px">${stamp}</div>`,
    });
    await sandbox.writeTextFile({ path: "shot/shot.js", content: SHOT_SCRIPT });
    const result = await sandbox.run({ command: "cd /workspace/shot && node shot.js" });
    if (result.stderr && result.stderr.includes("Error")) {
      throw new Error(`Screenshot failed: ${result.stderr.slice(0, 500)}`);
    }
    const bytes = await sandbox.readBinaryFile({ path: "shot/out.png" });
    if (!bytes) throw new Error("Screenshot file missing after render.");
    const pngBase64 = Buffer.from(bytes).toString("base64");
    return { byteSize: bytes.byteLength, stamp, pngBase64 };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`Screenshot rendered (800x600, ${output.byteSize} bytes):`),
      toolOutputPart.file(output.pngBase64, { mediaType: "image/png" }),
    ]);
  },
});
