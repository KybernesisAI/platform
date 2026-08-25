import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import { KIND_HTTP_AUTH, type NostrEvent } from "./relay.js";

/**
 * Read the whole workspace, not just your own corner of it.
 *
 * @remarks
 * The Buzz CLI's list commands are owner-scoped — `--owner` defaults to the
 * current identity — which is right for "my repos" and wrong for the question
 * people actually ask an agent: *what projects exist here?* Asked that in a
 * workspace holding three, an agent answered "none", because it had listed its
 * own and had none. It was not broken and it was not lying; it had been given a
 * tool that could only see one author and no way to know that mattered.
 *
 * There is no CLI command for the general case, but the relay has the endpoint
 * the CLI itself uses: `POST /query`, NIP-98 signed, taking an array of Nostr
 * filters. That is one request away from every kind the platform stores —
 * projects, repos, issues, patches, notes — across everyone in the workspace.
 */
export async function queryRelay(
  relayHttpUrl: string,
  secretKey: Uint8Array,
  filters: readonly Record<string, unknown>[],
): Promise<{ events: NostrEvent[]; status: number; bytes: number }> {
  const url = `${relayHttpUrl.replace(/\/$/, "")}/query`;
  const body = JSON.stringify(filters);
  // Signed exactly as the socket path signs: the signature binds the body, so a
  // filter cannot be swapped in transit.
  const auth = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
      // A nonce, because the relay rejects a repeated auth event as a replay.
      // Without it two identical requests — the same query twice, the same
      // reaction twice — sign byte-identically and the second is refused. The
      // refusal does not always look like one either: a duplicated read came
      // back as an empty list, so an agent reported an empty workspace instead
      // of a rejected request.
        ["nonce", randomUUID()],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
      content: "",
    },
    secretKey,
  );

  // Bound to this module deliberately: eve's runtime replaces the global fetch
  // in the deployed server, and a request that goes through a different client
  // than the one that signed it can arrive unauthenticated — which this relay
  // answers with an empty list rather than a refusal, so it reads as "nothing
  // here" instead of "you are not who you said you were".
  /**
   * The owner-attestation tag, when the workspace issues one.
   *
   * @remarks
   * NIP-98 proves which key made the request; this proves the workspace agreed
   * that key may act on someone's behalf. Some operations — owner-reviewed
   * agent drafts among them — are refused without it, and the refusal names
   * neither the tag nor the header, so it reads as a permissions problem with
   * no obvious cause. Optional, because most of the surface never asks.
   */
  const authTag = process.env.BUZZ_AUTH_TAG?.trim();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "content-type": "application/json",
      ...(authTag ? { "x-auth-tag": authTag } : {}),
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`relay ${response.status}: ${text.slice(0, 300)}`);
  }
  // The status and size travel with the answer because an empty list and a
  // rejected request look identical to a caller that only sees the events, and
  // this relay answers some refusals with 200 and an empty array.
  return { events: JSON.parse(text) as NostrEvent[], status: response.status, bytes: text.length };
}
