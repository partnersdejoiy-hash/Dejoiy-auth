import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listUserSessions, revokeSession, revokeAllUserSessions
} from "../services/session.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { query } from "../db/pool.js";
import { errors } from "../errors.js";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // Own sessions (any authenticated user)
  app.get("/sessions/me", { preHandler: [authenticate] }, async (request) => {
    return listUserSessions(request.auth!.userId);
  });

  // Admin: all sessions across the platform
  app.get(
    "/sessions",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["session.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(Number(q.limit ?? 100), 500);
      const offset = Number(q.offset ?? 0);
      const { rows } = await query(
        `SELECT s.id, s.user_id, u.user_number, u.email, s.ip, s.user_agent,
                s.created_at, s.last_active_at, s.expires_at, s.revoked_at,
                s.revoke_reason, s.requires_reauth, d.label AS device_label
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.revoked_at IS NULL
          ORDER BY s.last_active_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows;
    }
  );

  app.delete("/sessions/me/:id", { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    if (id === request.auth!.sessionId) {
      throw errors.badRequest("Use /auth/logout to end the current session");
    }
    await revokeSession(id, "user_revoked", {
      id: request.auth!.userId,
      correlationId: request.correlationId
    });
    return { ok: true };
  });

  // Admin: sessions of a user
  app.get(
    "/users/:id/sessions",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["session.read"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      return listUserSessions(id);
    }
  );

  app.delete(
    "/sessions/:id",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["session.revoke"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      await revokeSession(id, "admin_revoked", {
        id: request.auth!.userId,
        correlationId: request.correlationId
      });
      return { ok: true };
    }
  );

  // Global logout (security.admin / super admin)
  app.post(
    "/sessions/global-logout",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["session.global_logout"] })] },
    async (request) => {
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.body);
      const count = await revokeAllUserSessions(userId, "global_logout", {
        actor: { id: request.auth!.userId, correlationId: request.correlationId }
      });
      return { ok: true, revokedSessions: count };
    }
  );
}
