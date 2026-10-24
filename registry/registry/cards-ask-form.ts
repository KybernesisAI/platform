import { formPrompt, readFormAnswer } from "@kybernesis/cards";
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

// Ask the person for several things at once, as a form: KYBER Studio and the
// phone draw the fields with a Send button, and a text channel shows the
// sentence and numbered questions for the person to answer in their own words.
// Runs as a task, so the question stays open through any other message the
// person sends. Authored here because eve compiles "use workflow" from source.
export default defineWorkflowTool({
  description:
    "Ask the person for several pieces of information at once, as a short form, when you need two or more answers before you can go on (details for a booking, the parts of a request). One question needs no form: ask it in your reply. Never ask for a password, a card number or a one-time code with this. The answers come back to you later in the conversation.",
  inputSchema: z.object({
    title: z.string().max(80).optional().describe("A few words naming the form, e.g. Trip details"),
    sentence: z.string().max(300).describe("One sentence on why you are asking, shown above the fields"),
    fields: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).describe("A short key for the answer, e.g. arrival_date"),
          label: z.string().max(80),
          kind: z.enum(["text", "long", "number", "date", "email", "choice"]),
          options: z.array(z.string().max(80)).max(12).optional().describe("The choices, for kind choice"),
          required: z.boolean().optional(),
          placeholder: z.string().max(80).optional(),
        }),
      )
      .min(1)
      .max(12),
    submit: z.string().max(30).optional().describe("The button's label; defaults to Send"),
  }),
  async task(input, ctx) {
    "use workflow";
    const answer = await ctx.ask({
      prompt: formPrompt(input.fields, input.sentence, { title: input.title, submit: input.submit }),
      allowFreeform: true,
      options: [{ id: "cancel", label: "Never mind" }],
    });
    if (answer.status !== "answered" || answer.optionId === "cancel") {
      return { answered: false, note: "The person did not fill in the form. Do not ask again unless they bring it up." };
    }
    const read = readFormAnswer(answer.text ?? "");
    return "values" in read
      ? { answered: true, values: read.values }
      : { answered: true, reply: read.text, note: "They answered in their own words; read the values from the reply." };
  },
});
