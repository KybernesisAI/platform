/**
 * The channel thread id inside a recorded conversation address.
 *
 * eve records a conversation as `<channel name>:<thread id>`, and a Chat SDK
 * thread id carries its own adapter prefix, so a text through a channel file
 * named `linq` is recorded as `linq:linq:<chatId>`. Sending to that whole
 * string as a thread id fails inside the adapter, where the error is
 * swallowed: the heads-up is logged as sent and never arrives. Pass the
 * channel's name (its file name) and get the thread id back, or undefined
 * when the address belongs to another channel.
 */
export function threadIdFor(token: string | undefined, channel: string): string | undefined {
  const prefix = `${channel}:`;
  if (!token?.startsWith(prefix)) return undefined;
  const threadId = token.slice(prefix.length);
  return threadId.includes(":") ? threadId : undefined;
}
