import type { Server as HttpServer } from "node:http";
import { jwtVerify, SignJWT } from "jose";
import { Server, type Socket } from "socket.io";
import { isAdminRole, ROLES, type Role } from "../core";
import { prisma } from "../db";
import { env } from "../env";

/*
 * Real-time channel (DESIGN.md §5.22): one Socket.IO connection per open tab.
 *
 * Rooms: `user:<id>` for each signed-in person (their notifications, cart and
 * order changes) and `admins` for staff (live admin pages). Guests connect too,
 * with no room, for app-wide events (a new version of the web app).
 *
 * The browser never sees the API's access token: the web server swaps it for a
 * two-minute socket ticket (POST /realtime/ticket), and the socket proves who
 * it is with that.
 *
 * New-version detection: the web server tells the API which build it runs
 * (announceVersion, trusted via the internal secret); each tab says which
 * build it is ("hello"). Build versions start with their build time, so they
 * sort. When a newer build goes live, every older tab is told at once; an older
 * tab that connects later is told on arrival. No polling.
 */

const secret = new TextEncoder().encode(env.API_JWT_SECRET);
const TICKET_AUDIENCE = "diau-socket";

export async function signSocketTicket(userId: string, role: Role): Promise<string> {
  return new SignJWT({ role }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setAudience(TICKET_AUDIENCE).setIssuedAt().setExpirationTime("2m").sign(secret);
}

async function verifyTicket(ticket: unknown): Promise<{ userId: string; role: Role } | null> {
  if (typeof ticket !== "string" || ticket.length > 2000) return null;
  try {
    const { payload } = await jwtVerify(ticket, secret, { audience: TICKET_AUDIENCE, algorithms: ["HS256"] });
    const role = payload.role;
    if (typeof payload.sub !== "string" || typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return null;
    return { userId: payload.sub, role: role as Role };
  } catch {
    return null;
  }
}

type SocketData = { userId: string | null; isAdmin: boolean; version: string | null };

let io: Server | null = null;
/** The newest web-app build seen since this server started. */
let newestVersion: string | null = null;

/** Build versions are `<build time ms>-<id>`; compare by the time. */
const builtAt = (v: string) => Number(v.split("-")[0]) || 0;

function tellIfOutdated(socket: Socket) {
  const v = (socket.data as SocketData).version;
  if (v && newestVersion && builtAt(v) < builtAt(newestVersion)) socket.emit("app:update", { version: newestVersion });
}

export function attachRealtime(server: HttpServer) {
  io = new Server(server, {
    path: "/socket.io",
    cors: { origin: env.CORS_ORIGINS, methods: ["GET", "POST"] },
    // Brief drops (a phone switching networks) resume without losing missed events.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  io.use(async (socket, next) => {
    const data: SocketData = { userId: null, isAdmin: false, version: null };
    const claims = await verifyTicket(socket.handshake.auth?.ticket);
    if (claims) {
      // Blocked accounts don't get a live channel.
      const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { isActive: true, role: true } });
      if (user?.isActive) {
        data.userId = claims.userId;
        data.isAdmin = isAdminRole(user.role);
      }
    }
    socket.data = data;
    next();
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    if (data.userId) void socket.join(`user:${data.userId}`);
    if (data.isAdmin) void socket.join("admins");

    // A tab says which build it runs. It can't announce a newer one: only the web
    // server can (announceVersion), so no visitor can trigger the prompt for others.
    socket.on("hello", (payload: unknown) => {
      const version = typeof (payload as { version?: unknown })?.version === "string" ? (payload as { version: string }).version.slice(0, 120) : null;
      if (!version || !builtAt(version)) return;
      data.version = version;
      tellIfOutdated(socket);
    });
  });

  return io;
}

/**
 * The web server reports the build it runs (POST /realtime/version, with the
 * internal secret). When it's newer than any seen, every open tab on an older
 * build is told right away.
 */
export function announceVersion(version: string) {
  if (!builtAt(version)) return;
  if (newestVersion && builtAt(version) <= builtAt(newestVersion)) return;
  newestVersion = version;
  if (io) for (const s of io.sockets.sockets.values()) tellIfOutdated(s);
}

export async function closeRealtime() {
  await io?.close();
  io = null;
}

/** Sends an event to every open tab of one person. */
export function emitToUser(userId: string, event: string, payload: unknown = {}) {
  io?.to(`user:${userId}`).emit(event, payload);
}

/** Sends an event to every open admin tab (live admin pages). */
export function emitToAdmins(event: string, payload: unknown = {}) {
  io?.to("admins").emit(event, payload);
}
