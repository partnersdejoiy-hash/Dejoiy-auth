import { useState, useEffect, useCallback } from "react";
import { api, ApiError } from "../../lib/api";
import { AuthCard, LoadingScreen, ErrorScreen, SecurityBadge, MiniButton, StatCard, useToasts } from "../../components/ui";
import { useAuth } from "../../lib/auth";

interface SyncJob {
  id: string;
  status: string;
  trigger_type: string;
  rows_synced: number;
  rows_added?: number;
  rows_updated?: number;
  rows_deleted?: number;
  conflicts?: number;
  failed_records?: number;
  started_at: string;
  finished_at?: string;
  error?: string;
  error_message?: string;
  summary?: string;
}

interface SyncStats {
  configured: boolean;
  lastJob: SyncJob | null;
  totals: { added: number; updated: number; deleted: number; conflicts: number; failed: number };
  pendingConflicts: number;
  trackedRecords: number;
  settings: {
    mode: "scheduled" | "near-real-time";
    deletionPolicy: "mark" | "keep" | "delete";
    pollIntervalSeconds: number;
  };
  worksheet: string;
}

interface FieldMapping {
  field: string;
  direction: string;
  description: string | null;
}

interface SyncConfig {
  fields: FieldMapping[];
  mode: "scheduled" | "near-real-time";
  deletionPolicy: "mark" | "keep" | "delete";
  pollIntervalSeconds: number;
  intervalSeconds: number;
  batchSize: number;
  worksheet: string;
}

interface ConflictRow {
  id: string;
  user_number: string;
  field: string;
  db_value: string | null;
  sheet_value: string | null;
  source: string;
  status: string;
  created_at: string;
}

interface DemoJob {
  id: string;
  status: string;
  requested: number;
  inserted: number;
  updated: number;
  failed: number;
  error: string | null;
  finished_at: string | null;
}

const DIRECTIONS = ["never", "db_to_sheet", "sheet_to_db", "bidirectional"];

export function ZohoSyncPage(_props: { base?: string }) {
  const { hasPermission } = useAuth();
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [direction, setDirection] = useState<"push" | "pull" | "bidirectional">("bidirectional");
  const [dirs, setDirs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<SyncConfig["mode"]>("scheduled");
  const [deletionPolicy, setDeletionPolicy] = useState<SyncConfig["deletionPolicy"]>("mark");
  const [saving, setSaving] = useState(false);
  const [demoCount, setDemoCount] = useState(10000);
  const [demoJob, setDemoJob] = useState<DemoJob | null>(null);
  const [generating, setGenerating] = useState(false);
  const toasts = useToasts();

  const canConfigure = hasPermission("sync.zoho.update");
  const canResolve = hasPermission("sync.zoho.resolve");
  const canGenerate = hasPermission("sync.zoho.generate");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [statsRes, configRes, jobsRes, conflictsRes] = await Promise.all([
        api.get<SyncStats>("/sync/zoho-sheet/stats"),
        api.get<SyncConfig>("/sync/zoho-sheet/config"),
        api.get<SyncJob[]>("/sync/zoho-sheet?limit=10"),
        api.get<ConflictRow[]>("/sync/zoho-sheet/conflicts?status=pending&limit=50")
      ]);
      setStats(statsRes);
      setConfig(configRes);
      setJobs(Array.isArray(jobsRes) ? jobsRes : []);
      setConflicts(Array.isArray(conflictsRes) ? conflictsRes : []);
      setDirs(Object.fromEntries(configRes.fields.map((f) => [f.field, f.direction])));
      setMode(configRes.mode);
      setDeletionPolicy(configRes.deletionPolicy);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load sync status");
      toasts.push("error", "Failed to load sync status");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runSync = async () => {
    setSyncing(true);
    try {
      const data = await api.post<{ rowsSynced: number; configured: boolean; direction: string }>("/sync/zoho-sheet", { direction });
      toasts.push("success", `Sync complete: ${data.rowsSynced} rows (${data.direction})`);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await api.post<{ ok: boolean; latencyMs?: number; workbook?: string; worksheet?: string; error?: string }>("/sync/zoho-sheet/test");
      if (res.ok) {
        toasts.push("success", `Zoho connection OK (${res.latencyMs}ms)${res.workbook ? ` — ${res.workbook}` : ""}`);
      } else {
        toasts.push("error", res.error ?? "Connection test failed");
      }
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.put("/sync/zoho-sheet/config", {
        fields: config.fields.map((f) => ({ field: f.field, direction: dirs[f.field] ?? f.direction })),
        mode,
        deletionPolicy
      });
      toasts.push("success", "Sync configuration saved");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  const resolveConflict = async (id: string, resolution: "keep_db" | "keep_sheet" | "skip") => {
    try {
      await api.post(`/sync/zoho-sheet/conflicts/${id}/resolve`, { resolution });
      toasts.push("success", `Conflict ${resolution.replace("_", " ")}`);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Failed to resolve conflict");
    }
  };

  const generateDemo = async () => {
    setGenerating(true);
    setDemoJob(null);
    try {
      const { jobId } = await api.post<{ jobId: string }>("/sync/zoho-sheet/generate-demo", { count: demoCount });
      toasts.push("info", `Demo generation queued (${demoCount} records)`);
      const poll = async (id: string) => {
        const job = await api.get<DemoJob>(`/sync/zoho-sheet/generate-demo/${id}`);
        setDemoJob(job);
        if (job.status === "queued" || job.status === "running") {
          setTimeout(() => void poll(id), 2000);
        } else {
          setGenerating(false);
          if (job.status === "success") {
            toasts.push("success", `Demo dataset ready: ${job.inserted} inserted, ${job.updated} updated`);
            await load();
          } else {
            toasts.push("error", job.error ?? "Demo generation failed");
          }
        }
      };
      void poll(jobId);
    } catch (err) {
      setGenerating(false);
      toasts.push("error", err instanceof ApiError ? err.message : "Failed to queue demo generation");
    }
  };

  if (loadError) {
    return (
      <ErrorScreen
        title="COULD NOT LOAD ZOHO SYNC"
        message={loadError}
        onRetry={() => void load()}
      />
    );
  }

  if (!stats || !config) return <LoadingScreen />;

  const lastJob = stats.lastJob;
  const modeLabel = stats.settings.mode === "near-real-time" ? "NEAR REAL-TIME" : "SCHEDULED";

  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <h1 className="admin-title">ZOHO SHEET INTEGRATION</h1>
        <span className="admin-subtitle">
          Incremental upsert sync · {modeLabel} · {stats.worksheet}
        </span>
      </div>

      {/* Health cards */}
      <div className="admin-cards">
        <StatCard
          label="CONNECTION"
          value={stats.configured ? "🟢 CONNECTED" : "🔴 NOT CONFIGURED"}
          accent={stats.configured ? "cyan" : "danger"}
        />
        <StatCard label="SYNC MODE" value={modeLabel} accent="violet" />
        <StatCard label="PENDING CONFLICTS" value={stats.pendingConflicts} accent={stats.pendingConflicts > 0 ? "warning" : "cyan"} />
        <StatCard
          label="LAST SYNC"
          value={lastJob ? new Date(lastJob.finished_at ?? lastJob.started_at).toLocaleString() : "Never"}
        />
        <StatCard label="TRACKED RECORDS" value={stats.trackedRecords} />
      </div>

      {/* Totals */}
      <div className="admin-cards">
        <StatCard label="ROWS ADDED" value={stats.totals.added} accent="cyan" />
        <StatCard label="ROWS UPDATED" value={stats.totals.updated} accent="cyan" />
        <StatCard label="ROWS DELETED" value={stats.totals.deleted} accent="low" />
        <StatCard label="FAILED RECORDS" value={stats.totals.failed} accent={stats.totals.failed > 0 ? "danger" : "low"} />
      </div>

      {/* Controls */}
      <AuthCard wide>
        <h2 className="section-title">Sync Controls</h2>
        <p className="section-desc">
          Incremental upsert by stable User ID — existing rows are updated, new users are added,
          removed users follow the deletion policy. Unrelated sheet data is never touched.
        </p>
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
          <MiniButton onClick={runSync} disabled={syncing || !stats.configured}>
            {syncing ? "⏳ Syncing..." : "🔄 Run Sync Now"}
          </MiniButton>
          <MiniButton onClick={testConnection} disabled={testing || !stats.configured}>
            {testing ? "⏳ Testing..." : "🔌 Test Connection"}
          </MiniButton>
        </div>
        {!stats.configured && (
          <p style={{ color: "var(--danger, #ef4444)", marginTop: 8, fontSize: 13 }}>
            Zoho credentials not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, and ZOHO_SHEET_URL in .env
          </p>
        )}
        <p style={{ color: "var(--text-secondary, #94a3b8)", fontSize: 12, marginTop: 8 }}>
          Zoho Sheet has no native outbound events — "near-real-time" means incremental polling, never claimed as real-time.
        </p>
      </AuthCard>

      {/* Field mapping + policy */}
      <AuthCard wide>
        <h2 className="section-title">Field Mapping & Sync Policy</h2>
        <p className="section-desc">
          Direction per field: DB → Sheet (read-only in sheet), Sheet → DB, bidirectional, or never.
          Passwords, hashes, MFA secrets, recovery codes, session tokens and API keys are never columns.
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Direction</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {config.fields.map((f) => (
                <tr key={f.field}>
                  <td style={{ fontWeight: 600 }}>{f.field}</td>
                  <td>
                    {canConfigure ? (
                      <select
                        value={dirs[f.field] ?? f.direction}
                        onChange={(e) => setDirs((d) => ({ ...d, [f.field]: e.target.value }))}
                        className="admin-select"
                        style={{ minWidth: 140 }}
                      >
                        {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    ) : (
                      <span className="stat-label">{f.direction}</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-secondary, #94a3b8)" }}>{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canConfigure && (
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13 }}>
              Sync mode:&nbsp;
              <select value={mode} onChange={(e) => setMode(e.target.value as SyncConfig["mode"])} className="admin-select">
                <option value="scheduled">Scheduled</option>
                <option value="near-real-time">Near real-time (polling)</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>
              Deletion policy:&nbsp;
              <select value={deletionPolicy} onChange={(e) => setDeletionPolicy(e.target.value as SyncConfig["deletionPolicy"])} className="admin-select">
                <option value="mark">Mark (Status = TERMINATED)</option>
                <option value="keep">Keep (leave row)</option>
                <option value="delete">Delete row (matched by User ID)</option>
              </select>
            </label>
            <MiniButton onClick={saveConfig} disabled={saving}>
              {saving ? "⏳ Saving..." : "💾 Save Configuration"}
            </MiniButton>
          </div>
        )}
      </AuthCard>

      {/* Conflicts */}
      <AuthCard wide>
        <h2 className="section-title" style={{ color: "var(--warning, #f59e0b)" }}>
          ⚠️ Conflicts ({stats.pendingConflicts})
        </h2>
        <p className="section-desc">
          Both the DB and the sheet changed the same field since the last sync. Choose the source of truth;
          decisions are recorded in the audit log.
        </p>
        {conflicts.length === 0 ? (
          <p className="empty-state">No pending conflicts 🎉</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Field</th>
                  <th>DB value</th>
                  <th>Sheet value</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.user_number}</td>
                    <td>{c.field}</td>
                    <td style={{ fontSize: 12 }}>{c.db_value ?? "—"}</td>
                    <td style={{ fontSize: 12 }}>{c.sheet_value ?? "—"}</td>
                    <td>
                      {canResolve ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <MiniButton onClick={() => void resolveConflict(c.id, "keep_db")}>Keep DB</MiniButton>
                          <MiniButton onClick={() => void resolveConflict(c.id, "keep_sheet")}>Keep Sheet</MiniButton>
                          <MiniButton onClick={() => void resolveConflict(c.id, "skip")}>Skip</MiniButton>
                        </div>
                      ) : (
                        <span className="stat-label">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AuthCard>

      {/* Demo generator */}
      {canGenerate && (
        <AuthCard wide>
          <h2 className="section-title">Generate Demo Dataset</h2>
          <p className="section-desc">
            Create realistic synthetic employees (marked synthetic, dejoiy.local emails) to demonstrate
            large-scale sync. Processed in the background within safe Zoho Sheet limits.
          </p>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
            <select value={demoCount} onChange={(e) => setDemoCount(Number(e.target.value))} className="admin-select">
              <option value={1000}>1,000 records</option>
              <option value={10000}>10,000 records</option>
              <option value={25000}>25,000 records</option>
              <option value={50000}>50,000 records (max safe)</option>
            </select>
            <MiniButton onClick={generateDemo} disabled={generating}>
              {generating ? "⏳ Generating..." : "🧪 Generate Demo Dataset"}
            </MiniButton>
          </div>
          {demoJob && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-secondary, #94a3b8)" }}>
              <SecurityBadge severity={demoJob.status === "success" ? "info" : demoJob.status === "failed" ? "critical" : "warning"} />
              {" "}Requested: {demoJob.requested} · Inserted: {demoJob.inserted} · Updated: {demoJob.updated} · Failed: {demoJob.failed}
              {demoJob.error && <span style={{ color: "var(--danger, #ef4444)" }}> — {demoJob.error}</span>}
            </div>
          )}
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
                  <th>Added</th>
                  <th>Updated</th>
                  <th>Deleted</th>
                  <th>Conflicts</th>
                  <th>Failed</th>
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
                          job.status === "error" || job.status === "failed" ? "critical" :
                          job.status === "running" ? "warning" : "low"
                        }
                      />
                    </td>
                    <td>{job.trigger_type}</td>
                    <td>{job.rows_added ?? 0}</td>
                    <td>{job.rows_updated ?? 0}</td>
                    <td>{job.rows_deleted ?? 0}</td>
                    <td style={{ color: (job.conflicts ?? 0) > 0 ? "var(--warning, #f59e0b)" : undefined }}>{job.conflicts ?? 0}</td>
                    <td style={{ color: (job.failed_records ?? 0) > 0 ? "var(--danger, #ef4444)" : undefined }}>{job.failed_records ?? 0}</td>
                    <td>{new Date(job.started_at).toLocaleString()}</td>
                    <td>{job.finished_at ? new Date(job.finished_at).toLocaleString() : "—"}</td>
                    <td style={{ color: "var(--danger, #ef4444)", fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {job.error ?? job.error_message ?? ""}
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
