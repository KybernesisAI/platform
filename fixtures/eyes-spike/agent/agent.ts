import { defineAgent } from "eve";

export default defineAgent({
  // Vision-capable and cheap — the spike's whole point is the model SEEING pixels.
  model: "anthropic/claude-haiku-4.5",
});
