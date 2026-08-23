import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listUserDevices, revokeDevice } from "../services/session.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { query } from "../db/pool.js";
import { errors } from "../errors.js";

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // Own devices
  app.get("/devices/me", { preHandler: [authenticate] }, async (request) => {
    return listUserDevices(request.auth!.userId);
  });

  // Admin: all devices across the platform
  app.get(
    "/devices",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["device.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(Number(q.limit ?? 100), 500);
      const offset = Number(q.offset ?? 0);
      const { rows } = await query(
        `SELECT d.id, d.user_id, u.user_number, u.email, d.label, d.fingerprint,
                d.first_seen_at, d.last_seen_at, d.revoked_at,
                (SELECT count(*)::int FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL) AS active_sessions
           FROM devices d
           JOIN users u ON u.id = d.user_id
          WHERE d.revoked_at IS NULL
          ORDER BY d.last_seen_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows;
    }
  );

  app.delete("/devices/me/:id", { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await revokeDevice(id, request.auth!.userId, {
      id: request.auth!.userId,
      correlationId: request.correlationId
    });
    return { ok: true };
  });

  // Admin: devices of a user
  app.get(
    "/users/:id/devices",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["device.read"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      return listUserDevices(id);
    }
  );

  app.delete(
    "/devices/:id",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["device.revoke"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, string | undefined>;
      const userId = z.string().uuid().parse(query.userId);
      await revokeDevice(id, userId, {
        id: request.auth!.userId,
        correlationId: request.correlationId
      });
      return { ok: true };
    }
  );
}
