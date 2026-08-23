import { useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, MiniButton, StatusBadge, useToasts, CopyField } from "../../components/ui";

interface Health {
  database: string;
  redis: string;
  mailProvider: string;
  zohoConfigured: boolean;
  timestamp: string;
}

export function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const toasts = useToasts();

  const load = async () => {
    try {
      const [h, j] = await Promise.all([
        api.get<Health>("/security/system-health"),
        api.get<Array<Record<string, unknown>>>("/sync/zoho-sheet?limit=10")
      ]);
      setHealth(h);
      setJobs(j);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load system data");
    }
  };

  useEffect(() => { void load(); }, []);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await api.post<{ rowsSynced: number; configured: boolean }>("/sync/zoho-sheet");
      toasts.push(res.configured ? "success" : "info",
        res.configured ? `Sync complete — ${res.rowsSynced} rows` : "Sync ran — Zoho credentials not configured yet");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page">
      <h1 className="page-title">System</h1>
      <p className="page-sub">Health, configuration surfaces and Zoho synchronization</p>

      {error ? <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /> : (
        <>
          <div className="grid grid-4 mb-16">
            <div className="detail-item"><div className="k">Database</div><div className="v">{health?.database ?? "…"}</div></div>
            <div className="detail-item"><div className="k">Redis</div><div className="v">{health?.redis ?? "…"}</div></div>
            <div className="detail-item"><div className="k">Mail provider</div><div className="v">{health?.mailProvider ?? "…"}</div></div>
            <div className="detail-item"><div className="k">Zoho sync</div><div className="v">{health?.zohoConfigured ? <StatusBadge status="ACTIVE" /> : "Not configured"}</div></div>
          </div>

          <section className="panel mb-16">
            <div className="flex-between">
              <h2 className="panel-title">Zoho Sheet synchronization</h2>
              <MiniButton onClick={() => void runSync()} disabled={syncing}>
                {syncing ? "Syncing…" : "Run sync now"}
              </MiniButton>
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
              One-way push: database → sync worker → DEJOIY AUTH Zoho Sheet. The sheet never receives secrets.
            </p>
            {jobs.length === 0 ? (
              <div className="muted">No sync jobs yet.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Status</th><th>Trigger</th><th>Rows</th><th>Started</th><th>Finished</th></tr></thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={String(j.id)}>
                      <td><StatusBadge status={String(j.status).toUpperCase()} /></td>
                      <td className="muted">{String(j.trigger_type)}</td>
                      <td>{String(j.rows_synced)}</td>
                      <td className="muted">{formatDate(String(j.started_at ?? ""))}</td>
                      <td className="muted">{formatDate(String(j.finished_at ?? ""))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
      {toasts.node}
    </div>
  );
}
