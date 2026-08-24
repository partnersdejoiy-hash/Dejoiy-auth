import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { runZohoSync, getSyncSettings } from "../services/zoho-sync.js";
import { logger } from "../logger.js";

/**
 * Background scheduler for Zoho Sheet sync.
 *
 * Sync mode (honest labelling — Zoho Sheet has no native outbound event for
 * cell edits, so this is never claimed to be real-time):
 *   - scheduled        → run every ZOHO_SYNC_INTERVAL_SECONDS
 *   - near-real-time   → incremental polling every poll interval (default 60s)
 *
 * Mode and poll interval are re-read from settings on every tick, so admin
 * changes take effect without a restart. Safe when unconfigured — jobs record
 * their configured=false state and retry on the next tick.
 */
export function startSyncScheduler(app: FastifyInstance): void {
  const cfg = getConfig();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const settings = await getSyncSettings();
      const intervalMs =
        (settings.mode === "near-real-time"
          ? settings.pollIntervalSeconds
          : cfg.ZOHO_SYNC_INTERVAL_SECONDS) * 1000;

      await runZohoSync({ triggerType: "scheduled" });

      // Schedule the next tick from settings (allows live mode changes).
      const next = setTimeout(() => void tick(), intervalMs);
      next.unref();
    } catch (err) {
      logger.warn({ err }, "scheduled zoho sync failed — retrying on next interval");
      const retry = setTimeout(() => void tick(), Math.min(cfg.ZOHO_SYNC_INTERVAL_SECONDS, 60) * 1000);
      retry.unref();
    }
  };

  // First run shortly after boot, then a self-scheduling chain.
  const first = setTimeout(() => void tick(), 30_000);
  first.unref();

  app.addHook("onClose", async () => {
    stopped = true;
    clearTimeout(first);
  });

  logger.info({ mode: cfg.ZOHO_SYNC_MODE, intervalSeconds: cfg.ZOHO_SYNC_INTERVAL_SECONDS }, "zoho sync scheduler started");
}
