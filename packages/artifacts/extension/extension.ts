import { defineExtension } from "eve/extension";

/**
 * Artifacts: pages this agent makes for a person (a report, a dashboard, a
 * tracker) that KYBER Studio and the phone draw inline as cards. They live on
 * the agent's own machine and belong to the person who asked; the
 * `@kybernesis/manage` routes serve them to that person's apps.
 */
export default defineExtension();
