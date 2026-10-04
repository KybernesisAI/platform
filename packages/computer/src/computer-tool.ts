import { computer_use } from "eve/computer-use/tools";
import { defineTool, toolOutput, toolOutputPart, type ToolContext } from "eve/tools";
import { never } from "eve/tools/approval";

type Exec = NonNullable<typeof computer_use.execute>;
type ComputerUseInput = Parameters<Exec>[0];
type ComputerUseResult = Exclude<Awaited<ReturnType<Exec>>, AsyncIterable<unknown>>;
/** The StandardSchema member of eve's input-schema union (the zod object eve authored). */
type ComputerUseSchema = Extract<typeof computer_use.inputSchema, { "~standard": unknown }>;

export interface ComputerToolOptions {
  /**
   * Attach the screenshot to every result so the model SEES the screen.
   * Default true. Off, the tool behaves like eve's: a path and the
   * accessibility text only.
   */
  vision?: boolean;
}

type Output = ComputerUseResult & { screenshotBase64: string | null };

/**
 * eve's `computer_use`, with eyes.
 *
 * eve's tool returns the screenshot as a PATH inside the sandbox plus the
 * window title, pointer and a few accessibility elements as text. Nothing
 * hands the pixels to the model, and eve's `read_file` reads PNGs as text,
 * so an agent on eve's tool alone is blind: it works from window titles and
 * clipboard tricks and says "the screenshot came back without an image".
 * This wrapper runs the same action, then reads the PNG the driver wrote and
 * returns it as an image part in the tool result — the way the engineer
 * layer's `screenshot` tool does — so every click, type and screenshot comes
 * back with the screen it produced.
 */
export function computerTool(options: ComputerToolOptions = {}) {
  const vision = options.vision !== false;
  const run = computer_use.execute as (input: ComputerUseInput, ctx: ToolContext) => Promise<ComputerUseResult>;
  return defineTool({
    description:
      computer_use.description +
      " Every result includes the screenshot itself as an image: look at it before the next action. Do not read the PNG with a file tool.",
    inputSchema: computer_use.inputSchema as ComputerUseSchema,
    approval: never(),
    async execute(input, ctx): Promise<Output> {
      const result = await run(input, ctx);
      if (!vision) return { ...result, screenshotBase64: null };
      const sandbox = await ctx.getSandbox();
      const bytes = await sandbox.readBinaryFile({ path: result.screenshot });
      return { ...result, screenshotBase64: bytes ? Buffer.from(bytes).toString("base64") : null };
    },
    toModelOutput(output) {
      const { screenshotBase64, ...rest } = output as Output;
      const parts = [toolOutputPart.text(JSON.stringify(rest))];
      if (screenshotBase64) parts.push(toolOutputPart.file(screenshotBase64, { mediaType: "image/png", filename: "screen.png" }));
      return toolOutput.content(parts);
    },
  });
}
