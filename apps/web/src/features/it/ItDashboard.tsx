import { useEffect, useState } from "react";
import { api, ApiError, formatDate } from "../../lib/api";
import { ErrorScreen, StatCard, StatusBadge, SecurityBadge } from "../../components/ui";

interface Health {
  authentication: string;
  api: string;
  database: string;
  redis: string;
  mailProvider: string;
  mailConfigured: boolean;
  zohoConfigured: boolean;
  timestamp: string;
}
interface Incident {
  event_id: string;
  event_type: string;
  severity: string;
  created_at: string;
  ip: string | null;
}

export function ItDashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [h, i] = await Promise.all([
        api.get<Health>("/it/health"),
        api.get<Incident[]>("/it/incidents?limit=8")
      ]);
      setHealth(h);
      setIncidents(i);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load IT health");
    }
  };

  useEffect(() => { void load(); }, []);

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;
  if (!health) return <div className="page"><div className="muted">Checking infrastructure…</div></div>;

  const ok = (v: string) => v === "operational";

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">IT Operations</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Authentication health · last check {formatDate(health.timestamp)}</p>
        </div>
        <div className="flex">
          <StatusBadge status={ok(health.authentication) ? "ACTIVE" : "DEGRADED"} />
        </div>
      </div>

      <div className="grid grid-4 mb-16">
        <StatCard label="Authentication" value={health.authentication} accent={ok(health.authentication) ? "cyan" : "magenta"} />
        <StatCard label="API" value={health.api} />
        <StatCard label="Database" value={health.database} accent={ok(health.database) ? "cyan" : "magenta"} />
        <StatCard label="Redis" value={health.redis} accent={ok(health.redis) ? "cyan" : "magenta"} />
      </div>

      <div className="grid grid-2">
        <section className="panel">
          <h2 className="panel-title">Providers</h2>
          <table className="data">
            <tbody>
              <tr><td>Mail provider</td><td className="mono">{health.mailProvider}</td></tr>
              <tr><td>Mail configured</td><td>{health.mailConfigured ? <StatusBadge status="ACTIVE" /> : <span className="muted">pending configuration</span>}</td></tr>
              <tr><td>Zoho Sheet</td><td>{health.zohoConfigured ? <StatusBadge status="ACTIVE" /> : <span className="muted">credentials not set</span>}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2 className="panel-title">Recent incidents</h2>
          {incidents.length === 0 ? (
            <div className="muted">No high-severity incidents.</div>
          ) : (
            <table className="data">
              <thead><tr><th>Event</th><th>Severity</th><th>Time</th></tr></thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.event_id}>
                    <td className="mono">{i.event_type}</td>
                    <td><SecurityBadge severity={i.severity} /></td>
                    <td className="muted">{formatDate(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
