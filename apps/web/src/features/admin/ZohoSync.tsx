import { useState, useEffect } from "react";
import { api } from "../../lib/api";
import { AuthCard, LoadingScreen, SecurityBadge, MiniButton, StatCard, useToasts } from "../../components/ui";


interface SyncJob {
  id: string;
  status: string;
  trigger_type: string;
  rows_synced: number;
  started_at: string;
  finished_at?: string;
  error_message?: string;
  summary?: string;
}

interface SyncStatus {
  configured: boolean;
  sheetUrl: string | null;
  syncIntervalSeconds: number;
  lastJob?: SyncJob;
}

export function ZohoSyncPage({ base }: { base?: string }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [direction, setDirection] = useState<"push" | "pull" | "bidirectional">("bidirectional");
  const toasts = useToasts();

  const load = async () => {
    try {
      const [statusRes, jobsRes] = await Promise.all([
        api.get<SyncStatus>(`${base ?? "/api/v1"}/sync/zoho-sheet/status`),
        api.get<SyncJob[]>(`${base ?? "/api/v1"}/sync/zoho-sheet?limit=10`)
      ]);
      setStatus(statusRes);
      setJobs(Array.isArray(jobsRes) ? jobsRes : []);
    } catch {
      toasts.push("error", "Failed to load sync status");
    }
  };

  useEffect(() => { load(); }, []);

  const runSync = async () => {
    setSyncing(true);
    try {
      const data = await api.post<{ rowsSynced: number; configured: boolean; direction: string }>(`${base ?? "/api/v1"}/sync/zoho-sheet`, { direction });
      toasts.push("success", `Sync complete: ${data.rowsSynced} rows (${data.direction})`);
      await load();
    } catch (err: any) {
      toasts.push("error", err?.response?.data?.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (!status) return <LoadingScreen />;

  const lastJob = status.lastJob;
  let lastSummary: Record<string, unknown> = {};
  try { lastSummary = lastJob?.summary ? JSON.parse(lastJob.summary) : {}; } catch {}

  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <h1 className="admin-title">ZOHO SHEET INTEGRATION</h1>
        <span className="admin-subtitle">Real-time identity data sync with Zoho Sheet</span>
      </div>

      {/* Status Cards */}
      <div className="admin-cards">
        <AuthCard>
          <span className="stat-label">CONNECTION</span>
          <span className="stat-value">
            {status.configured ? "🟢 Connected" : "🔴 Not Configured"}
          </span>
        </AuthCard>
        <AuthCard>
          <span className="stat-label">SYNC INTERVAL</span>
          <span className="stat-value">{status.syncIntervalSeconds}s</span>
        </AuthCard>
        <AuthCard>
          <span className="stat-label">LAST SYNC</span>
          <span className="stat-value">
            {lastJob
              ? `${new Date(lastJob.finished_at ?? lastJob.started_at).toLocaleString()}`
              : "Never"}
          </span>
        </AuthCard>
        <AuthCard>
          <span className="stat-label">LAST ROWS</span>
          <span className="stat-value">{lastJob?.rows_synced ?? 0}</span>
        </AuthCard>
      </div>

      {/* Sync Controls */}
      <AuthCard wide>
        <h2 className="section-title">Manual Sync</h2>
        <p className="section-desc">Push DB users to Zoho Sheet, pull sheet changes back, or both.</p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
            className="admin-select"
          >
            <option value="bidirectional">Bidirectional (Push + Pull)</option>
            <option value="push">Push (DB → Sheet)</option>
            <option value="pull">Pull (Sheet → DB)</option>
          </select>
          <MiniButton
            onClick={runSync}
            disabled={syncing || !status.configured}
          >
            {syncing ? "⏳ Syncing..." : "🔄 Run Sync Now"}
          </MiniButton>
        </div>
        {!status.configured && (
          <p style={{ color: "var(--danger, #ef4444)", marginTop: 8, fontSize: 13 }}>
            Zoho credentials not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, and ZOHO_SHEET_URL in .env
          </p>
        )}
      </AuthCard>

      {/* Sheet Info */}
      {status.sheetUrl && (
        <AuthCard wide>
          <h2 className="section-title">Zoho Sheet</h2>
          <a
            href={status.sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent, #00e5ff)", fontSize: 14 }}
          >
            {status.sheetUrl} ↗
          </a>
        </AuthCard>
      )}

      {/* Conflicts from last sync */}
      {Array.isArray(lastSummary.conflicts) && lastSummary.conflicts.length > 0 && (
        <AuthCard wide>
          <h2 className="section-title" style={{ color: "var(--warning, #f59e0b)" }}>
            ⚠️ Sync Conflicts ({lastSummary.conflicts.length})
          </h2>
          {lastSummary.conflicts.map((c: string, i: number) => (
            <p key={i} style={{ color: "var(--text-secondary)", fontSize: 13, margin: "4px 0" }}>
              {c}
            </p>
          ))}
        </AuthCard>
      )}

      {/* Sync History */}
      <AuthCard wide>
        <h2 className="section-title">Sync History</h2>
        {jobs.length === 0 ? (
          <p className="empty-state">No sync jobs yet</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Rows</th>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <SecurityBadge
                        severity={
                          job.status === "success" ? "info" :
                          job.status === "error" ? "critical" :
                          job.status === "running" ? "warning" : "low"
                        }
                      />
                    </td>
                    <td>{job.trigger_type}</td>
                    <td>{job.rows_synced}</td>
                    <td>{new Date(job.started_at).toLocaleString()}</td>
                    <td>{job.finished_at ? new Date(job.finished_at).toLocaleString() : "—"}</td>
                    <td style={{ color: "var(--danger, #ef4444)", fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {job.error_message ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AuthCard>
    </div>
  );
}
