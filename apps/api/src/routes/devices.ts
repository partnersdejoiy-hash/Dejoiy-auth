import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listUserDevices, revokeDevice } from "../services/session.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { errors } from "../errors.js";

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // Own devices
  app.get("/devices/me", { preHandler: [authenticate] }, async (request) => {
    return listUserDevices(request.auth!.userId);
  });

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
