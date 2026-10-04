import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { GET, POST, WS, type RouteDefinition, type WebSocketPeer } from "eve/channels";

/**
 * The agent's computer, for a client that is already signed in.
 *
 * `@kybernesis/computer` shares the computer's screen as VNC on this host's
 * loopback (noVNC's websockify on :6080). A browser reaches it through exe's
 * signed-in port proxy plus the VNC password. KYBER Studio holds the person's
 * identity for this agent already, so it should not see a VNC login at all:
 * these routes put the same screen behind the same grant check as every
 * management call. The client asks for a ticket, then opens the relay socket
 * with it; the relay pipes bytes to websockify. The VNC password stays on the
 * host and travels to the client inside the authed ticket response, so the
 * client's RFB layer can present it without a person ever typing it.
 */
export interface ComputerOptions {
  /** websockify's port on loopback. Defaults to 6080 (what @kybernesis/computer publishes). */
  novncPort?: number;
  /** The VNC password x11vnc was started with. Defaults to COMPUTER_VNC_PASSWORD. */
  vncPassword?: string;
  /** The computer's name, for the client. Defaults to COMPUTER_NAME. */
  name?: string;
  /** The desktop size the computer runs at. */
  screen?: { width: number; height: number };
}

const TICKET_TTL_MS = 60_000;

interface Ticket {
  expiresAt: number;
  used: boolean;
}

/** Single-use, short-lived tickets: a WebSocket cannot carry the bearer header, so it carries one of these. */
export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = TICKET_TTL_MS) {}

  issue(): { ticket: string; expiresAt: number } {
    this.sweep();
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, { expiresAt, used: false });
    return { ticket, expiresAt };
  }

  /** True once, for a live ticket; false for unknown, expired or already used. */
  consume(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    const entry = this.tickets.get(ticket);
    if (!entry || entry.used || entry.expiresAt <= this.now()) {
      if (entry) this.tickets.delete(ticket);
      return false;
    }
    entry.used = true;
    this.tickets.delete(ticket);
    return true;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= t) this.tickets.delete(key);
  }
}

/** Is anything listening where the computer's screen would be? */
export function probeComputer(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function ticketFromUrl(url: string): string | null {
  try {
    return new URL(url, "http://localhost").searchParams.get("ticket");
  } catch {
    return null;
  }
}

/**
 * The three routes, under the manage prefix. `authorize` is the manage
 * channel's own grant check, so a computer is exactly as reachable as an install.
 */
export function computerRoutes(input: {
  prefix: string;
  options: ComputerOptions;
  authorize: (req: Request) => Promise<Response | null>;
  tickets?: TicketStore;
}): RouteDefinition[] {
  const prefix = `${input.prefix}/computer`;
  const port = input.options.novncPort ?? 6080;
  const tickets = input.tickets ?? new TicketStore();
  const describe = async () => {
    const present = await probeComputer(port);
    return present
      ? {
          name: input.options.name ?? process.env.COMPUTER_NAME ?? "agent-computer",
          screen: input.options.screen ?? { width: 1920, height: 1080 },
        }
      : null;
  };

  return [
    // Is there a computer, and how big is its screen? null when nothing is listening.
    GET(prefix, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      return Response.json({ computer: await describe() });
    }),

    // A ticket for the relay socket, plus what the RFB layer needs to connect
    // without asking the person anything.
    POST(`${prefix}/ticket`, async (req) => {
      const denied = await input.authorize(req);
      if (denied) return denied;
      const computer = await describe();
      if (!computer) return Response.json({ ok: false, error: "This agent has no computer running." }, { status: 404 });
      const issued = tickets.issue();
      const password = input.options.vncPassword ?? process.env.COMPUTER_VNC_PASSWORD ?? "";
      return Response.json({
        ok: true,
        ticket: issued.ticket,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        path: `${prefix}/ws`,
        computer,
        credentials: password ? { password } : null,
      });
    }),

    // The relay: client bytes to websockify, websockify bytes to the client.
    WS(`${prefix}/ws`, async () => {
      let upstream: WebSocket | null = null;
      const pending: Uint8Array[] = [];
      return {
        upgrade(request) {
          if (!tickets.consume(ticketFromUrl(request.url))) {
            return Response.json({ ok: false, error: "A valid computer ticket is required." }, { status: 401 });
          }
        },
        open(peer: WebSocketPeer) {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/websockify`);
          socket.binaryType = "arraybuffer";
          upstream = socket;
          socket.onopen = () => {
            for (const chunk of pending.splice(0)) socket.send(chunk);
          };
          socket.onmessage = (event) => {
            const data = event.data as ArrayBuffer | string;
            peer.send(typeof data === "string" ? data : new Uint8Array(data));
          };
          socket.onclose = (event) => peer.close(event.code === 1005 ? 1000 : event.code, event.reason);
          socket.onerror = () => peer.close(1011, "The computer's screen is not reachable.");
        },
        message(_peer, message) {
          const bytes = message.uint8Array();
          if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
          else pending.push(bytes);
        },
        close() {
          if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
          upstream = null;
        },
        error() {
          if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
          upstream = null;
        },
      };
    }),
  ];
}
