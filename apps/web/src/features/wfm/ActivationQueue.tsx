import { useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, EmptyState, MiniButton, useToasts } from "../../components/ui";

interface QueueItem {
  id: string;
  user_number: string;
  email: string | null;
  full_name: string | null;
  employee_id: string | null;
  department: string | null;
  created_at: string;
}

export function ActivationQueuePage() {
  const [rows, setRows] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toasts = useToasts();

  const load = async () => {
    try {
      setRows(await api.get<QueueItem[]>("/wfm/activation-queue?limit=100"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load queue");
    }
  };

  useEffect(() => { void load(); }, []);

  const activate = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/users/${id}/activate`, {});
      toasts.push("success", "Employee activated — identity is now active");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Activation failed");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;

  return (
    <div className="page">
      <h1 className="page-title">Activation queue</h1>
      <p className="page-sub">Pending identities awaiting authorized activation</p>
      {rows.length === 0 ? <EmptyState title="Queue is clear" hint="No pending identities" /> : (
        <div className="panel">
          <table className="data">
            <thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Onboarded</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="user-cell">
                      <strong>{r.full_name ?? r.email}</strong>
                      <span className="dim" style={{ fontSize: 12 }}>{r.email}</span>
                    </div>
                  </td>
                  <td className="mono muted">{r.employee_id ?? r.user_number}</td>
                  <td className="muted">{r.department ?? "—"}</td>
                  <td className="muted">{formatDate(r.created_at)}</td>
                  <td><MiniButton disabled={busy === r.id} onClick={() => void activate(r.id)}>
                    {busy === r.id ? "Activating…" : "Activate"}
                  </MiniButton></td>
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
