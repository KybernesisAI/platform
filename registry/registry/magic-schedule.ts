import { defineSchedule } from "eve/schedules";
import { noteDeliveryFailure, tick } from "@kybernesis/magic/steps";
import { deliver } from "../lib/magic-surfaces.js";

// Every five minutes, code looks at each opted-in person's calendar, mail and
// reminders. The model only runs when that finds something worth saying, and
// then as the person, in the conversation they already have with this agent.
export default defineSchedule({
  cron: "*/5 * * * *",
  async run({ to, waitUntil }) {
    for (const dispatch of await tick()) {
      waitUntil(deliver(to, dispatch).catch((error) => noteDeliveryFailure(dispatch.principalId, error)));
    }
  },
});
