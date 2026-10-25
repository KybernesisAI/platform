import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Tell the person, now, that a long job has started.
 *
 * A text channel shows nothing between a request and its answer, so a person
 * who asked for a page or a report on Buzz or iMessage could not tell an agent
 * at work from one that had stopped. The model's own words before a tool call
 * never reach them: every surface treats those as narration. This call is the
 * one thing each surface posts mid-turn: the Buzz bridge and Chat SDK channels
 * post the message as a chat message (`@kybernesis/cards` `progressNotes`,
 * `progressEvents`), and KYBER Studio and the phone show it as the turn's live
 * step through the label.
 *
 * The tool does nothing itself, so it is safe anywhere, including a turn with
 * no person on the other end. When to call it is the model's judgement, and
 * the description is where that judgement is taught.
 */
export default defineTool({
  description:
    "Send the person one short message right now saying you have started on a job that will take a while, so they know you are working. Always use it before you make or change an artifact, page or document for someone, even when it seems quick. Also use it for other work that will clearly take more than a minute: writing a report, research across several sources, building or changing code, work on your computer, or handing the job to a teammate. Make it your first step, before you search for tools, look anything up or start writing. Do not use it for a question you can answer straight away, a quick lookup, one or two quick tool calls, small talk, or when you need to ask the person something before you can start. Write one sentence in your own voice that says what you are doing and that the result will follow here, for example: On it. Building your daily calendar page now, I'll send it here in a minute. Call it once, on its own, then do the work. Your final reply is the result: do not repeat this message in it.",
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .max(280)
      .describe("One short sentence, in the conversation's language, naming what you are doing, e.g. On it. Building your daily calendar page now."),
  }),
  label: {
    start: ({ message }) => message,
  },
  async execute({ message }) {
    return { sent: true, message: message.replace(/\s+/g, " ").trim() };
  },
  toModelOutput: () => ({
    type: "text" as const,
    value: "Sent. Now do the work, and make your final reply the result without repeating that message.",
  }),
});
