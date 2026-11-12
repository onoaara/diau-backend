import { buildApp } from "./app";
import { prisma } from "./db";
import { env } from "./env";
import { startNotificationJobs, stopNotificationJobs } from "./realtime/jobs";
import { attachRealtime, closeRealtime } from "./realtime/socket";

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  stopNotificationJobs();
  await closeRealtime();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  // Socket.IO shares the API's HTTP server and port (DESIGN.md §5.22).
  attachRealtime(app.server);
  if (env.NODE_ENV !== "test") startNotificationJobs();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
