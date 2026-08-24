import type { FastifyInstance } from "fastify";
import { runZohoSync, listSyncJobs, SYNC_FIELDS } from "../services/zoho-sync.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { AppError } from "../errors.js";

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // Some clients (older web bundles, scripts) POST with Content-Type:
  // application/json but an empty body. Fastify's default JSON parser rejects
  // that with FST_ERR_CTP_EMPTY_JSON_BODY (400) before the route runs.
  // Treat an empty body as {} instead so sync runs default to bidirectional.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const raw = typeof body === "string" ? body : body.toString();
      done(null, raw ? JSON.parse(raw) : {});
    } catch (err) {
      const e = err as Error & { statusCode?: number; code?: string };
      e.statusCode = 400;
      e.code = "FST_ERR_CTP_INVALID_JSON_BODY";
      done(e, undefined);
    }
  });

  app.post(
    "/sync/zoho-sheet",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["sync.zoho.run"] })] },
    async (request) => {
      const body = (request.body ?? {}) as { direction?: string };
      const direction = ["push", "pull", "bidirectional"].includes(body.direction ?? "")
        ? (body.direction as "push" | "pull" | "bidirectional")
        : "bidirectional";

      try {
        return await runZohoSync({
          triggeredBy: request.auth!.userId,
          triggerType: "manual",
          direction
        });
      } catch (err) {
        // AppErrors (e.g. "sync already running") pass through with their status.
        if (err instanceof AppError) throw err;
        // Zoho API / sheet failures are plain errors — surface the reason to
        // the admin instead of a masked 500.
        throw new AppError(
          502,
          "ZOHO_SYNC_FAILED",
          err instanceof Error ? err.message : "Zoho sync failed",
          { direction }
        );
      }
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
