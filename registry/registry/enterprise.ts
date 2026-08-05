import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { kybernesisAuth } from "@kybernesis/enterprise";

// Admits only callers holding a Kybernesis control-plane session WITH a grant
// for this agent. Register the agent in the control plane under the same name.
//
// localDev() is deliberate: it accepts ONLY loopback requests (production-inert)
// and is required for local `eve eval` runs — the eval runner sends no
// credentials, so a governed-only walk would 401 every local eval session.
export default eveChannel({
  auth: [
    kybernesisAuth({
      issuer: process.env.KYBERNESIS_ISSUER!,
      agent: process.env.KYBERNESIS_AGENT!,
    }),
    localDev(),
  ],
});
