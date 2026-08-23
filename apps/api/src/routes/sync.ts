import type { FastifyInstance } from "fastify";
import { runZohoSync, listSyncJobs, SYNC_FIELDS } from "../services/zoho-sync.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/sync/zoho-sheet",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.run"] })] },
    async (request) => {
      return runZohoSync({
        triggeredBy: request.auth!.userId,
        triggerType: "manual"
      });
    }
  );

  app.get(
    "/sync/zoho-sheet",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return listSyncJobs(Math.min(Number(q.limit ?? 20), 100), Number(q.offset ?? 0));
    }
  );

  app.get(
    "/sync/zoho-sheet/fields",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.read"] })] },
    async () => ({ fields: SYNC_FIELDS })
  );
}
