import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
// The driver body may only import pure modules (eve bundles it without Node);
// the Link calls come from the steps entry and are reached only inside "use step".
import { APPROVE_SPEND_REQUEST_DESCRIPTION, spendRequestAsk, type SpendRequestSnapshot } from "@kybernesis/payments/ask";
import { cancelSpendRequest, spendRequestApprovalLink, spendRequestSettledStatus, spendRequestSnapshot } from "@kybernesis/payments/steps";

// The approval moment as one durable call: shows the purchase (merchant, total,
// Approve-in-Link button), waits for the person, returns Link's real status.
// Authored here because eve compiles "use workflow" / "use step" from source.
export default defineWorkflowTool({
  description: APPROVE_SPEND_REQUEST_DESCRIPTION,
  inputSchema: z.object({ spend_request_id: z.string().min(1).max(200) }),
  async execute(input, ctx) {
    "use workflow";
    const current = await snapshot(input.spend_request_id);
    if (!current) return { status: "not_found", note: "That spend request does not exist." };
    if (current.status === "approved") return { status: "approved", note: "Already approved. Proceed to pay_on_computer." };
    if (current.status !== "pending_approval" && current.status !== "created") {
      return { status: current.status, note: `This request is ${current.status}; create a new one if the purchase should still happen.` };
    }
    const approval_url = current.approval_url ?? (await approvalLink(current.id));
    const answer = await ctx.ask(spendRequestAsk({ ...current, approval_url }));
    if (answer.status !== "answered" || answer.optionId === "cancel") {
      await cancel(current.id);
      return { status: "canceled", note: "The person cancelled. Do not buy this." };
    }
    const status = await settled(current.id);
    if (status === "approved") return { status, note: "Approved in Link. Call pay_on_computer with this spend request id." };
    return { status, note: `Link reports ${status}. If it is still pending, the person may not have finished in the Link app; ask once, do not create another request.` };
  },
});

async function snapshot(id: string): Promise<SpendRequestSnapshot | null> {
  "use step";
  return spendRequestSnapshot(id);
}
async function approvalLink(id: string): Promise<string | undefined> {
  "use step";
  return spendRequestApprovalLink(id);
}
async function settled(id: string): Promise<string> {
  "use step";
  return spendRequestSettledStatus(id);
}
async function cancel(id: string): Promise<void> {
  "use step";
  await cancelSpendRequest(id);
}
