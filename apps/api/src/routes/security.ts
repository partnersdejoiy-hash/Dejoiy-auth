import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSecurityEvents } from "../services/security-events.js";
import { listAuditLogs } from "../services/audit.js";
import { query } from "../db/pool.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/security/events",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["security.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return listSecurityEvents({
        userId: q.userId,
        eventType: q.eventType,
        severity: q.severity as never,
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
    }
  );

  app.get(
    "/audit/logs",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["audit.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return listAuditLogs({
        actorUserId: q.actorUserId,
        action: q.action,
        targetType: q.targetType,
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
    }
  );

  app.get(
    "/security/dashboard",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { anyOf: ["security.read", "audit.read"] })] },
    async () => {
      const [activeUsers, lockedUsers, failedLogins, suspiciousLogins, activeSessions, securityAlerts, recentAdminActions] =
        await Promise.all([
          query(`SELECT count(*)::int AS n FROM users WHERE account_state = 'ACTIVE' AND deleted_at IS NULL`),
          query(`SELECT count(*)::int AS n FROM users WHERE account_state = 'LOCKED' AND deleted_at IS NULL`),
          query(`SELECT count(*)::int AS n FROM login_attempts WHERE success = false AND created_at > now() - interval '24 hours'`),
          query(`SELECT count(*)::int AS n FROM security_events WHERE severity IN ('high','critical') AND created_at > now() - interval '24 hours'`),
          query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`),
          query(`SELECT * FROM security_events WHERE severity IN ('high','critical') ORDER BY created_at DESC LIMIT 10`),
          query(`SELECT action, actor_role, target_label, created_at, result FROM audit_logs ORDER BY created_at DESC LIMIT 10`)
        ]);
      return {
        metrics: {
          activeUsers: activeUsers.rows[0]?.n ?? 0,
          lockedUsers: lockedUsers.rows[0]?.n ?? 0,
          failedLogins24h: failedLogins.rows[0]?.n ?? 0,
          suspiciousLogins24h: suspiciousLogins.rows[0]?.n ?? 0,
          activeSessions: activeSessions.rows[0]?.n ?? 0
        },
        securityAlerts: securityAlerts.rows,
        recentAdminActions: recentAdminActions.rows
      };
    }
  );

  // System health surface for IT panel
  app.get(
    "/security/system-health",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["system.config.read"] })] },
    async () => {
      const dbOk = await query("SELECT 1").then(() => true).catch(() => false);
      const redis = (await import("../redis.js")).getRedis();
      const redisOk = await redis.ping().then(() => true).catch(() => false);
      return {
        database: dbOk ? "healthy" : "degraded",
        redis: redisOk ? "healthy" : "degraded",
        mailProvider: (await import("../config.js")).getConfig().MAIL_PROVIDER,
        zohoConfigured: Boolean((await import("../config.js")).getConfig().ZOHO_CLIENT_ID),
        timestamp: new Date().toISOString()
      };
    }
  );
}
