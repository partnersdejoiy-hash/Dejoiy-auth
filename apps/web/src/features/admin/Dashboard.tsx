import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate } from "../../lib/api";
import { StatCard, SecurityBadge, ErrorScreen, EmptyState } from "../../components/ui";
import { useToasts } from "../../components/ui";

interface DashboardData {
  metrics: {
    activeUsers: number;
    lockedUsers: number;
    failedLogins24h: number;
    suspiciousLogins24h: number;
    activeSessions: number;
  };
  securityAlerts: Array<{ event_id: string; event_type: string; severity: string; created_at: string; metadata: Record<string, unknown> }>;
  recentAdminActions: Array<{ action: string; actor_role: string | null; target_label: string | null; created_at: string; result: string }>;
}

export function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const load = async () => {
    try {
      setData(await api.get<DashboardData>("/security/dashboard"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  };

  useEffect(() => { void load(); }, []);

  if (error) return <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} />;
  if (!data) return <div className="page"><div className="muted">Loading security posture…</div></div>;

  const m = data.metrics;

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Security Dashboard</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Identity posture across DEJOIY</p>
        </div>
        <Link to="/app/security" className="btn-mini">View all events</Link>
      </div>

      <div className="grid grid-4 mb-16">
        <StatCard label="Active users" value={m.activeUsers} />
        <StatCard label="Locked users" value={m.lockedUsers} accent="magenta" />
        <StatCard label="Failed logins · 24h" value={m.failedLogins24h} accent="violet" />
        <StatCard label="Suspicious · 24h" value={m.suspiciousLogins24h} accent="magenta" />
      </div>
      <div className="grid grid-4">
        <StatCard label="Active sessions" value={m.activeSessions} />
        <StatCard label="Protected endpoints" value="38+" />
        <StatCard label="MFA coverage" value="Enforced" />
        <StatCard label="Sync" value="DB → Sheet" />
      </div>

      <div className="grid grid-2 mt-24">
        <section className="panel">
          <h2 className="panel-title">Security alerts</h2>
          {data.securityAlerts.length === 0 ? (
            <EmptyState title="No high-severity events" hint="Posture nominal" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>Event</th><th>Severity</th><th>Time</th></tr>
              </thead>
              <tbody>
                {data.securityAlerts.map((e) => (
                  <tr key={e.event_id}>
                    <td className="mono">{e.event_type}</td>
                    <td><SecurityBadge severity={e.severity} /></td>
                    <td className="muted">{formatDate(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Recent admin actions</h2>
          {data.recentAdminActions.length === 0 ? (
            <EmptyState title="No admin actions yet" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>Action</th><th>Actor role</th><th>Target</th><th>Time</th></tr>
              </thead>
              <tbody>
                {data.recentAdminActions.map((a, i) => (
                  <tr key={i}>
                    <td className="mono">{a.action}</td>
                    <td>{a.actor_role ?? "—"}</td>
                    <td className="muted">{a.target_label ?? "—"}</td>
                    <td className="muted">{formatDate(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {toasts.node}
    </div>
  );
}
