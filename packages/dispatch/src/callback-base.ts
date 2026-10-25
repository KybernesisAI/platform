/**
 * Where a peer posts its answer back, on hosts that are not Vercel.
 *
 * When this agent calls a peer, eve hands the peer a callback URL and parks the
 * calling turn until the peer posts its answer there. eve builds that URL from,
 * in order: a Vercel production URL, `WORKFLOW_LOCAL_BASE_URL`, then the local
 * workflow world's own address, which falls back to `http://localhost:3000`. A
 * self-hosted agent has no Vercel URL, so the peer is told to answer at
 * localhost — its OWN localhost. The answer is refused there, and the calling
 * turn waits forever with no error on either side. The peer did its work; the
 * person just never hears back.
 *
 * Setting `WORKFLOW_LOCAL_BASE_URL` to the public address is the trap: it is
 * also the base for every queue delivery the host makes to itself, held open
 * for the whole turn. Hosts often cannot reach their own public name, and a
 * proxy in that path cuts long turns short. See `hostPreflight()` in
 * `@kybernesis/exe`.
 *
 * So the fix touches only the callback. The caller names its public address in
 * a header on every call to a peer ({@link ownCallbackBase}); the receiver
 * swaps it in for a loopback callback address and nothing else
 * ({@link withCallbackBase}). This gives the caller no new power: it already
 * chooses the whole callback URL, the header only corrects a value eve got
 * wrong on its behalf.
 */

/** The header a caller uses to say where its callbacks can reach it. */
export const CALLBACK_BASE_HEADER = "x-kybernesis-callback-base";

/** True for a hostname that only ever means "this machine". */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * This agent's public origin, for peers to post their answers to.
 *
 * `EVE_PUBLIC_URL` first, then `https://<EXE_VM_NAME>.exe.xyz` — the same
 * address the agent's artifact and file links use. Undefined on Vercel, where
 * eve already builds the right callback URL. A loopback `EVE_PUBLIC_URL` is
 * kept: two agents on one machine reach each other that way.
 */
export function ownCallbackBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.VERCEL === "1") return undefined;
  const vm = env.EXE_VM_NAME?.trim();
  const raw = env.EVE_PUBLIC_URL?.trim() || (vm ? `https://${vm}.exe.xyz` : "");
  const url = raw ? URL.parse(raw) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  return url.origin;
}

/**
 * The callback URL the peer should use: the same path on `base`, when eve
 * pointed it at loopback. Any other callback URL comes back unchanged.
 */
export function correctCallbackUrl(callbackUrl: string, base: string | null | undefined): string {
  if (!base) return callbackUrl;
  const callback = URL.parse(callbackUrl);
  const origin = URL.parse(base);
  if (!callback || !origin) return callbackUrl;
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return callbackUrl;
  if (!isLoopbackHost(callback.hostname)) return callbackUrl;
  return `${origin.origin}${callback.pathname}${callback.search}`;
}

interface SessionBody {
  callback?: { url?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

type Handler = (request: Request, ...rest: never[]) => unknown;
interface Route {
  method?: string;
  path?: string;
  handler?: Handler;
}

// The two routes whose body carries a callback: opening a session, and sending
// a later message to the same one.
const SESSION_ROUTES = new Set(["/eve/v1/session", "/eve/v1/session/:sessionId"]);

function correctingHandler(handler: Handler): Handler {
  return (async (request: Request, ...rest: never[]) => {
    const base = request.headers.get(CALLBACK_BASE_HEADER);
    if (!base) return handler(request, ...rest);

    // Read a copy so the original request reaches eve untouched whenever there
    // is nothing to correct, including a body that is not JSON at all.
    let body: SessionBody | null;
    try {
      body = (await request.clone().json()) as SessionBody | null;
    } catch {
      return handler(request, ...rest);
    }
    const url = body?.callback?.url;
    if (typeof url !== "string") return handler(request, ...rest);
    const corrected = correctCallbackUrl(url, base);
    if (corrected === url) return handler(request, ...rest);

    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const next = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({ ...body, callback: { ...body?.callback, url: corrected } }),
      signal: request.signal,
    });
    console.log(`[dispatch] peer callback pointed at loopback; answering at ${new URL(corrected).origin}`);
    return handler(next, ...rest);
  }) as Handler;
}

/**
 * Wrap an eve channel so a peer's loopback callback address is corrected to the
 * public address the caller named in {@link CALLBACK_BASE_HEADER}.
 */
export function withCallbackBase<T extends { routes?: readonly unknown[] }>(channel: T): T {
  if (!Array.isArray(channel.routes)) return channel;
  const routes = (channel.routes as Route[]).map((route) =>
    route.method === "POST" && route.path && SESSION_ROUTES.has(route.path) && typeof route.handler === "function"
      ? { ...route, handler: correctingHandler(route.handler) }
      : route,
  );
  return { ...channel, routes };
}
