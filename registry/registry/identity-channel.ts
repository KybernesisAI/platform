import { identityChannel } from "@kybernesis/identity";

// Your agent's .agent identity documents: the verification document ARP Cloud
// checks when you attach this runtime to a name, plus a health probe.
//
// Attach in the ARP console (cloud.arp.run/names/<name> → Runtime) with the URL
// https://<this-agent-host>/eve/v1/arp, then set the four variables it shows:
// ARP_ISSUER, ARP_AGENT_DID, ARP_AGENT_CREDENTIAL, AGENTID_CHALLENGE.
//
// Deliveries from paired agents arrive on your eve channel — add arpAuth() to
// its auth walk (agent/channels/eve.ts):
//   import { arpAuth } from "@kybernesis/identity";
//   export default eveChannel({ auth: [arpAuth(), localDev()] });
export default identityChannel();
