import type { FastifyInstance } from "fastify";
import { query } from "../db/pool.js";
import { getRedis } from "../redis.js";
import { getConfig } from "../config.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health/live", async () => ({
    status: "ok",
    service: "dejoiy-auth-api",
    time: new Date().toISOString()
  }));

  app.get("/health/ready", async (request, reply) => {
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

  app.get("/health", async () => ({
    status: "ok",
    service: "dejoiy-auth-api",
    version: "0.1.0"
  }));
}
