import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "../../lib/api";
import { ErrorScreen, EmptyState, MiniButton, SecurityBadge, useToasts } from "../../components/ui";

interface AuditRow {
  id: string;
  action: string;
  actor_user_id: string | null;
  actor_role: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  result: string | null;
  reason: string | null;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
}

export function AuditLogsPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const load = useCallback(async () => {
    try {
      setRows(await api.get<AuditRow[]>("/audit/logs?limit=200"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;
  if (!rows) return <div className="page"><div className="muted">Loading audit trail…</div></div>;

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Audit Logs</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Tamper-resistant record of privileged actions</p>
        </div>
        <MiniButton onClick={() => void load()}>Refresh</MiniButton>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No audit entries" hint="Privileged actions will appear here" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Action</th><th>Actor</th><th>Target</th><th>Result</th><th>Correlation</th><th>Time</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.action}</td>
                  <td>
                    <div className="mono" style={{ fontSize: 12 }}>{r.actor_role ?? "system"}</div>
                    {r.ip && <div className="muted" style={{ fontSize: 11.5 }}>{r.ip}</div>}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{r.target_label ?? r.target_type ?? "—"}</td>
                  <td>{r.result === "success" ? <SecurityBadge severity="low" /> : <SecurityBadge severity="high" />}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.correlation_id ?? "—"}</td>
                  <td className="muted">{formatDate(r.created_at)}</td>
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
