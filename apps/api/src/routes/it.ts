import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { listSecurityEvents } from "../services/security-events.js";
import { errors } from "../errors.js";

/**
 * IT panel — operations surface governed by RBAC. IT does NOT inherit Super
 * Admin privileges; every route requires explicit permissions.
 */
export async function itRoutes(app: FastifyInstance): Promise<void> {
  // Email delivery status
  app.get(
    "/it/notifications",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["notification.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      const { rows } = await query(
        `SELECT event_type, recipients, status, error, created_at, sent_at, correlation_id
           FROM notification_events
          ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [Math.min(Number(q.limit ?? 50), 200), Number(q.offset ?? 0)]
      );
      return rows;
    }
  );

  // Authentication + API health
  app.get(
    "/it/health",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["system.config.read"] })] },
    async () => {
      const dbOk = await query("SELECT 1").then(() => true).catch(() => false);
      const redis = (await import("../redis.js")).getRedis();
      const redisOk = await redis.ping().then(() => true).catch(() => false);
      const cfg = (await import("../config.js")).getConfig();
      return {
        authentication: dbOk && redisOk ? "operational" : "degraded",
        api: "operational",
        database: dbOk ? "operational" : "down",
        redis: redisOk ? "operational" : "down",
        mailProvider: cfg.MAIL_PROVIDER,
        mailConfigured:
          cfg.MAIL_PROVIDER === "console" ? false :
          cfg.MAIL_PROVIDER === "smtp" ? Boolean(cfg.SMTP_HOST) :
          cfg.MAIL_PROVIDER === "dejoiy-swiss" ? Boolean(cfg.DEJOIY_MAIL_API_URL) :
          Boolean(cfg.AWS_SES_REGION),
        zohoConfigured: Boolean(cfg.ZOHO_CLIENT_ID),
        timestamp: new Date().toISOString()
      };
    }
  );

  // Security incidents (high/critical events)
  app.get(
    "/it/incidents",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["security.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return listSecurityEvents({
        severity: q.severity as never,
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
    }
  );

  // System logs (structured, sanitized, never secrets)
  app.get(
    "/it/logs",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["system.config.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      const { rows } = await query(
        `SELECT id, event_id, event_type, severity, ip, created_at, correlation_id
           FROM security_events
          ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [Math.min(Number(q.limit ?? 50), 200), Number(q.offset ?? 0)]
      );
      return rows;
    }
  );

  // Sync jobs visibility
  app.get(
    "/it/sync-jobs",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.read"] })] },
    async () => {
      const { rows } = await query(
        `SELECT * FROM sheet_sync_jobs ORDER BY created_at DESC LIMIT 20`
      );
      return rows;
    }
  );

  // Force logout (IT capability)
  app.post(
    "/it/users/:id/force-logout",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.force_logout"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { revokeAllUserSessions } = await import("../services/session.js");
      const count = await revokeAllUserSessions(id, "it_force_logout", {
        actor: { id: request.auth!.userId, correlationId: request.correlationId }
      });
      return { ok: true, revokedSessions: count };
    }
  );
}
