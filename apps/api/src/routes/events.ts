import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { listEvents } from "../services/events.js";
import { WEBHOOK_EVENTS } from "../services/webhook.js";

/** Event log viewer — who/what/when across the identity ecosystem (Phase 23). */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/events",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["audit.read"] })] },
    async (request) => {
      const q = z.object({
        eventType: z.enum(WEBHOOK_EVENTS as unknown as [string, ...string[]]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0)
      }).parse(request.query);
      return listEvents({ eventType: q.eventType, limit: q.limit, offset: q.offset });
    }
  );

  app.get(
    "/events/types",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["audit.read"] })] },
    async () => ({ events: WEBHOOK_EVENTS })
  );
}
