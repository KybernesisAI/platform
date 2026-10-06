import { linkWallet } from "@kybernesis/payments";

// Stripe Link as the agent's wallet, behind the OWNER's link-cli sign-in on
// this host (`npx link-cli auth login --client-name <agent>`; the owner
// approves in the Link app). Tools: link__create_spend_request and friends.
// Every purchase is approved by the person in Link before a card exists.
export default linkWallet();
