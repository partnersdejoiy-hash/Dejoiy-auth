import { useCallback, useEffect, useState } from "react";
import { api, formatDate, timeAgo } from "../../lib/api";
import { ErrorScreen, EmptyState, MiniButton, SecurityBadge, useToasts } from "../../components/ui";

interface SessionRow {
  id: string;
  user_id: string;
  user_number: string;
  email: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  requires_reauth: boolean;
  device_label: string | null;
}

export function SessionsPage() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toasts = useToasts();

  const load = useCallback(async () => {
    try {
      setRows(await api.get<SessionRow[]>("/sessions?limit=200"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.del(`/sessions/${id}`);
      toasts.push("success", "Session revoked");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;
  if (!rows) return <div className="page"><div className="muted">Loading sessions…</div></div>;

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>{rows.length} active sessions across DEJOIY</p>
        </div>
        <MiniButton onClick={() => void load()}>Refresh</MiniButton>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No active sessions" hint="No sessions are currently active" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>User</th><th>Device</th><th>IP</th><th>Last active</th><th>Created</th><th>Reauth</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="mono">{s.user_number}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{s.email ?? "—"}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{s.device_label ?? "Unknown device"}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.ip ?? "—"}</td>
                  <td title={formatDate(s.last_active_at)}>{timeAgo(s.last_active_at)}</td>
                  <td className="muted">{formatDate(s.created_at)}</td>
                  <td>{s.requires_reauth ? <span className="chip">REAUTH</span> : <span className="muted">—</span>}</td>
                  <td>
                    <MiniButton disabled={busy === s.id} onClick={() => void revoke(s.id)}>
                      {busy === s.id ? "Revoking…" : "Revoke"}
                    </MiniButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toasts.node}
    </div>
  );
}
