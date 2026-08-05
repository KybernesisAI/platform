import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Deterministic fixture model: this reference deployment proves the GOVERNANCE loop
// (invite → access → revoke), not model quality — and needs no gateway credentials.
export default defineAgent({
  model: mockModel(
    ({ lastUserMessage }) =>
      `governed-ref online. Authenticated request accepted. You said: ${lastUserMessage}`,
  ),
  // Mock models carry no gateway metadata, so declare the window explicitly.
  modelContextWindowTokens: 200_000,
});
