import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { runZohoSync } from "../services/zoho-sync.js";
import { logger } from "../logger.js";

/**
 * Background scheduler for Zoho Sheet sync. Safe when unconfigured —
 * jobs record their configured=false state and retry on the next tick.
 */
export function startSyncScheduler(app: FastifyInstance): void {
  const cfg = getConfig();
  const intervalMs = cfg.ZOHO_SYNC_INTERVAL_SECONDS * 1000;

  const tick = async () => {
    try {
      await runZohoSync({ triggerType: "scheduled" });
    } catch (err) {
      logger.warn({ err }, "scheduled zoho sync failed");
    }
  };

  // First run shortly after boot, then on interval.
  const first = setTimeout(tick, 30_000);
  const interval = setInterval(tick, intervalMs);
  first.unref();
  interval.unref();

  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(interval);
  });

  logger.info({ intervalMs }, "zoho sync scheduler started");
}
