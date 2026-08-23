import { useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, EmptyState, StatusBadge } from "../../components/ui";

interface NotificationEvent {
  id: string;
  event_type: string;
  recipients: string[];
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  correlation_id: string | null;
}

export function NotificationsPage() {
  const [rows, setRows] = useState<NotificationEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<NotificationEvent[]>("/it/notifications?limit=100")
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Load failed"));
  }, []);

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} /></div>;

  return (
    <div className="page">
      <h1 className="page-title">Email delivery</h1>
      <p className="page-sub">Notification events and provider delivery status</p>
      {rows.length === 0 ? <EmptyState title="No notification events yet" hint="Emails are sent during sign-up, recovery and security events" /> : (
        <div className="panel">
          <table className="data">
            <thead><tr><th>Event</th><th>Recipients</th><th>Status</th><th>Correlation</th><th>Queued</th><th>Sent</th></tr></thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td className="mono">{n.event_type}</td>
                  <td className="muted">{n.recipients.join(", ")}</td>
                  <td><StatusBadge status={n.status.toUpperCase()} /></td>
                  <td className="mono dim">{n.correlation_id ?? "—"}</td>
                  <td className="muted">{formatDate(n.created_at)}</td>
                  <td className="muted">{formatDate(n.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
