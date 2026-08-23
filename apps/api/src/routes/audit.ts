import type { FastifyInstance } from "fastify";
import { listAuditLogs } from "../services/audit.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/audit",
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
}
