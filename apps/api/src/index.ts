import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import { loadConfig, getConfig } from "./config.js";
import { logger } from "./logger.js";
import { getRedis } from "./redis.js";
import { getPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { authPlugin } from "./plugins/auth.js";
import { securityPlugin } from "./plugins/security.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { roleRoutes } from "./routes/roles.js";
import { sessionRoutes } from "./routes/sessions.js";
import { deviceRoutes } from "./routes/devices.js";
import { securityRoutes } from "./routes/security.js";
import { auditRoutes } from "./routes/audit.js";
import { applicationRoutes } from "./routes/applications.js";
import { oidcRoutes } from "./routes/oidc.js";
import { syncRoutes } from "./routes/sync.js";
import { healthRoutes } from "./routes/health.js";
import { wfmRoutes } from "./routes/wfm.js";
import { itRoutes } from "./routes/it.js";
import { mfaRoutes } from "./routes/mfa.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { startSyncScheduler } from "./workers/sync-scheduler.js";
import { initializeSigningKeys } from "./services/jwt.js";

const APP_VERSION = "0.1.0";

export async function buildServer(opts?: { autoMigrate?: boolean }) {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.password",
          "*.token",
          "*.secret"
        ],
        censor: "[REDACTED]"
      }
    },
    trustProxy: true,
    bodyLimit: 512 * 1024,
    requestTimeout: 30_000
  });

  // Redis decoration
  await app.register(
    fp(async (instance: FastifyInstance) => {
      instance.decorate("redisClient", getRedis());
    })
  );
  await app.register(cookie, {
    secret: cfg.COOKIE_SECRET,
    parseOptions: { httpOnly: true, sameSite: "lax", secure: cfg.NODE_ENV === "production" }
  });

  await app.register(authPlugin);
  await app.register(securityPlugin);
  await app.register(errorHandlerPlugin);

  // Initialize Ed25519 JWT signing keys (generates ephemeral keys or loads from env).
  await initializeSigningKeys();

  // Migrations + seed on boot for self-contained deployments (idempotent).
  if (opts?.autoMigrate !== false && cfg.NODE_ENV !== "test") {
    const applied = await runMigrations();
    if (applied.length > 0 || cfg.NODE_ENV !== "production") {
      await seed();
    }
  }

  // API v1
  await app.register(
    async (v1) => {
      v1.register(authRoutes);
      v1.register(userRoutes);
      v1.register(roleRoutes);
      v1.register(sessionRoutes);
      v1.register(deviceRoutes);
      v1.register(securityRoutes);
      v1.register(auditRoutes);
      v1.register(applicationRoutes);
      v1.register(oidcRoutes);
      v1.register(syncRoutes);
      v1.register(wfmRoutes);
      v1.register(itRoutes);
      v1.register(mfaRoutes);
      v1.register(webhookRoutes);
      v1.register(bootstrapRoutes);
    },
    { prefix: "/api/v1" }
  );

  app.register(healthRoutes);

  app.get("/", async () => ({
    service: "DEJOIY AUTH",
    version: APP_VERSION,
    status: "operational"
  }));

  app.addHook("onClose", async () => {
    await getPool().end();
    getRedis().disconnect();
  });

  return app;
}

async function main() {
  const cfg = getConfig();
  const app = await buildServer();
  // Start the Zoho sync scheduler (best-effort; safe when unconfigured).
  startSyncScheduler(app);

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, env: cfg.NODE_ENV }, `DEJOIY AUTH API listening`);
}

// Direct execution only (tests import buildServer).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\.ts$/, "")}.ts`;
if (isDirectRun || process.argv[1]?.endsWith("dist/index.js")) {
  main().catch((err) => {
    logger.error({ err }, "fatal startup error");
    process.exit(1);
  });
}
