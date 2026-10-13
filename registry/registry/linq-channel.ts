import { channelIdentity } from "@kybernesis/enterprise";
import { linqEnvCredentials, linqSenderIdentity } from "@kybernesis/exe/linq";
import { linqChannel } from "eve/channels/linq";

// iMessage and SMS via Linq. Inbound is a signed webhook at /eve/v1/linq, so it
// works on any host with a public HTTPS URL and needs no forwarder. The owner
// connects a line from KYBER Studio's setup (or the manage `linq.verify`
// action), which writes LINQ_API_KEY and LINQ_WEBHOOK_SECRET and registers
// https://<this-host>/eve/v1/linq for message.received, reaction.added and
// reaction.removed.
//
// A sender is a control-plane person, never a phone number: each text resolves
// the number through the same link flow every channel uses. An unlinked number
// gets one text with a claim link and nothing else; receiving it is what proves
// they control the number. A linked person whose grant on this agent is revoked
// stops within one token lifetime, with no redeploy.
const issuer = process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";
const credential = process.env.KYBERNESIS_AGENT_CREDENTIAL;
const agentName = process.env.KYBERNESIS_AGENT;

export default linqChannel({
  credentials: linqEnvCredentials(),
  ...(agentName ? { userName: agentName } : {}),
  onMessage: linqSenderIdentity({
    issuer,
    agentName,
    identity: credential ? channelIdentity({ issuer, credential }) : null,
  }),
});
