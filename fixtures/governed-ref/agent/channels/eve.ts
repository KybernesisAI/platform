import { eveChannel } from "eve/channels/eve";

import { kybernesisAuth } from "@kybernesis/enterprise";

// Fail-closed on purpose: the ONLY way in is a control-plane session with a grant for this
// agent. No localDev() fallback — an ungoverned loopback door would defeat the demo.
export default eveChannel({
  auth: [
    kybernesisAuth({
      issuer: process.env.KYBERNESIS_ISSUER ?? "http://localhost:3000",
      agent: "governed-ref",
    }),
  ],
});
