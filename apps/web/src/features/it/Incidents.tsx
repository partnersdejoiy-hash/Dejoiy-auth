import { useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, EmptyState, SecurityBadge } from "../../components/ui";

interface Incident {
  event_id: string;
  event_type: string;
  severity: string;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  created_at: string;
}

export function IncidentsPage() {
  const [rows, setRows] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<Incident[]>("/it/incidents?limit=100")
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Load failed"));
  }, []);

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} /></div>;

  return (
    <div className="page">
      <h1 className="page-title">Security incidents</h1>
      <p className="page-sub">High and critical security events surfaced for IT response</p>
      {rows.length === 0 ? <EmptyState title="No incidents" /> : (
        <div className="panel">
          <table className="data">
            <thead><tr><th>Event</th><th>Severity</th><th>IP</th><th>Correlation</th><th>Time</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.event_id}>
                  <td>
                    <div className="mono">{i.event_type}</div>
                    <div className="dim" style={{ fontSize: 11 }}>{i.event_id}</div>
                  </td>
                  <td><SecurityBadge severity={i.severity} /></td>
                  <td className="mono muted">{i.ip ?? "—"}</td>
                  <td className="mono dim">{i.correlation_id ?? "—"}</td>
                  <td className="muted">{formatDate(i.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
