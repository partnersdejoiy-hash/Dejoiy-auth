import type { FastifyInstance } from "fastify";
import { query } from "../db/pool.js";
import { getRedis } from "../redis.js";
import { getConfig } from "../config.js";
import { getJWKS } from "../services/jwt.js";

const APP_VERSION = "0.2.0";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — always 200 if the process is running
  app.get("/health/live", async () => ({
    status: "ok",
    service: "dejoiy-auth-api",
    version: APP_VERSION,
    time: new Date().toISOString()
  }));

  // Readiness — checks all critical dependencies
  app.get("/health/ready", async (_request, reply) => {
    const dbOk = await query("SELECT 1").then(() => true).catch(() => false);
    let redisOk = false;
    try {
      redisOk = (await getRedis().ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    const ready = dbOk && redisOk;
    reply.status(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      database: dbOk ? "ok" : "error",
      redis: redisOk ? "ok" : "error",
      env: getConfig().NODE_ENV
    };
  });

  // Root — basic service info
  app.get("/health", async () => ({
    status: "ok",
    service: "dejoiy-auth-api",
    version: APP_VERSION
  }));

  // System health — detailed component status
  app.get("/health/system", async (_request, reply) => {
    const cfg = getConfig();

    // Database
    const dbStart = Date.now();
    const dbOk = await query("SELECT 1").then(() => true).catch(() => false);
    const dbLatencyMs = Date.now() - dbStart;

    // Redis
    let redisOk = false;
    let redisLatencyMs = 0;
    try {
      const rStart = Date.now();
      redisOk = (await getRedis().ping()) === "PONG";
      redisLatencyMs = Date.now() - rStart;
    } catch {
      redisOk = false;
    }

    // JWT keys
    let jwtStatus = "unknown";
    let jwtKeyCount = 0;
    try {
      const jwks = getJWKS();
      jwtKeyCount = jwks.keys.length;
      jwtStatus = jwtKeyCount > 0 ? "healthy" : "missing";
    } catch {
      jwtStatus = "error";
    }

    // Mail provider
    const mailStatus = cfg.MAIL_PROVIDER === "console" ? "console" : cfg.MAIL_PROVIDER;
    const mailConfigured =
      cfg.MAIL_PROVIDER !== "console" &&
      (cfg.SMTP_HOST !== "" || cfg.DEJOIY_MAIL_API_URL !== "" || cfg.AWS_SES_REGION !== "");

    // Zoho sync
    const zohoConfigured = cfg.ZOHO_CLIENT_ID !== "" && cfg.ZOHO_REFRESH_TOKEN !== "";

    const overall = dbOk && redisOk && jwtStatus === "healthy";
    reply.status(overall ? 200 : 503);

    return {
      status: overall ? "healthy" : "degraded",
      version: APP_VERSION,
      env: cfg.NODE_ENV,
      components: {
        database: { status: dbOk ? "healthy" : "failed", latencyMs: dbLatencyMs },
        redis: { status: redisOk ? "healthy" : "failed", latencyMs: redisLatencyMs },
        jwt: { status: jwtStatus, algorithm: "EdDSA", keyCount: jwtKeyCount },
        mail: { status: mailConfigured ? "configured" : "console", provider: mailStatus },
        zohoSync: { status: zohoConfigured ? "configured" : "unconfigured" },
        oidc: { status: "healthy", issuer: cfg.OIDC_ISSUER_URL }
      }
    };
  });

  // Version endpoint
  app.get("/version", async () => ({
    service: "dejoiy-auth-api",
    version: APP_VERSION,
    signing: "EdDSA/Ed25519",
    runtime: `Node ${process.version}`
  }));
}
