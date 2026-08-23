import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, SecurityBadge, EmptyState, useToasts, MiniButton } from "../../components/ui";

interface EventRow {
  event_id: string;
  event_type: string;
  severity: string;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}
interface AuditRow {
  action: string;
  actor_role: string | null;
  target_label: string | null;
  result: string;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
}

export function SecurityPage() {
  const [tab, setTab] = useState<"events" | "audit">("events");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [severity, setSeverity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (severity) params.set("severity", severity);
      const [e, a] = await Promise.all([
        api.get<EventRow[]>(`/security/events?${params}`),
        api.get<AuditRow[]>(`/audit/logs?limit=50`)
      ]);
      setEvents(e);
      setAudit(a);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load security data");
    }
  }, [severity]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Security</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Security events and audit trail — tamper-resistant as practical</p>
        </div>
        <MiniButton onClick={() => void load()}>Refresh</MiniButton>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "events" ? "active" : ""}`} onClick={() => setTab("events")}>Security events</button>
        <button className={`tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>Audit log</button>
      </div>

      {error ? <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /> : (
        <>
          {tab === "events" && (
            <>
              <div className="flex mb-16">
                <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Filter severity">
                  <option value="">All severities</option>
                  <option value="info">info</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
              {events.length === 0 ? <EmptyState title="No security events" /> : (
                <div className="panel">
                  <table className="data">
                    <thead><tr><th>Event</th><th>Severity</th><th>IP</th><th>Correlation</th><th>Time</th></tr></thead>
                    <tbody>
                      {events.map((e) => (
                        <tr key={e.event_id}>
                          <td>
                            <div className="mono">{e.event_type}</div>
                            <div className="dim" style={{ fontSize: 11 }}>{e.event_id}</div>
                          </td>
                          <td><SecurityBadge severity={e.severity} /></td>
                          <td className="mono muted">{e.ip ?? "—"}</td>
                          <td className="mono dim">{e.correlation_id ?? "—"}</td>
                          <td className="muted">{formatDate(e.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {tab === "audit" && (
            audit.length === 0 ? <EmptyState title="No audit entries" /> : (
              <div className="panel">
                <table className="data">
                  <thead><tr><th>Action</th><th>Actor role</th><th>Target</th><th>Result</th><th>Time</th></tr></thead>
                  <tbody>
                    {audit.map((a, i) => (
                      <tr key={i}>
                        <td className="mono">{a.action}</td>
                        <td>{a.actor_role ?? "—"}</td>
                        <td className="muted">{a.target_label ?? "—"}</td>
                        <td><span className="muted">{a.result}</span></td>
                        <td className="muted">{formatDate(a.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
      {toasts.node}
    </div>
  );
}
