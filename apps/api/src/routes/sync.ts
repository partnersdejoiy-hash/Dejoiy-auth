import type { FastifyInstance } from "fastify";
import { runZohoSync, listSyncJobs, SYNC_FIELDS } from "../services/zoho-sync.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/sync/zoho-sheet",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.run"] })] },
    async (request) => {
      const body = (request.body ?? {}) as { direction?: string };
      const direction = ["push", "pull", "bidirectional"].includes(body.direction ?? "")
        ? (body.direction as "push" | "pull" | "bidirectional")
        : "bidirectional";

      return runZohoSync({
        triggeredBy: request.auth!.userId,
        triggerType: "manual",
        direction
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

  app.get(
    "/sync/zoho-sheet/status",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.read"] })] },
    async () => {
      const cfg = (await import("../config.js")).getConfig();
      return {
        configured: Boolean(cfg.ZOHO_CLIENT_ID && cfg.ZOHO_CLIENT_SECRET && cfg.ZOHO_REFRESH_TOKEN && cfg.ZOHO_SHEET_URL),
        sheetUrl: cfg.ZOHO_SHEET_URL || null,
        syncIntervalSeconds: cfg.ZOHO_SYNC_INTERVAL_SECONDS,
        lastJob: (await listSyncJobs(1, 0))[0] ?? null
      };
    }
  );
}
