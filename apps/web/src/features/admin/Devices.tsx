import { useCallback, useEffect, useState } from "react";
import { api, formatDate, timeAgo } from "../../lib/api";
import { ErrorScreen, EmptyState, MiniButton, useToasts } from "../../components/ui";

interface DeviceRow {
  id: string;
  user_id: string;
  user_number: string;
  email: string | null;
  label: string | null;
  fingerprint: string | null;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  active_sessions: number;
}

export function DevicesPage() {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toasts = useToasts();

  const load = useCallback(async () => {
    try {
      setRows(await api.get<DeviceRow[]>("/devices?limit=200"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (row: DeviceRow) => {
    setBusy(row.id);
    try {
      await api.del(`/devices/${row.id}?userId=${row.user_id}`);
      toasts.push("success", "Device revoked and its sessions terminated");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;
  if (!rows) return <div className="page"><div className="muted">Loading devices…</div></div>;

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Registered devices with active sessions</p>
        </div>
        <MiniButton onClick={() => void load()}>Refresh</MiniButton>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No registered devices" hint="Devices appear after first sign-in" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>User</th><th>Device</th><th>Sessions</th><th>First seen</th><th>Last seen</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="mono">{d.user_number}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{d.email ?? "—"}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 13 }}>{d.label ?? "Unknown device"}</div>
                    {d.fingerprint && <div className="mono muted" style={{ fontSize: 10.5 }}>{d.fingerprint.slice(0, 24)}…</div>}
                  </td>
                  <td><span className="chip">{d.active_sessions}</span></td>
                  <td className="muted">{formatDate(d.first_seen_at)}</td>
                  <td title={formatDate(d.last_seen_at)}>{timeAgo(d.last_seen_at)}</td>
                  <td>
                    <MiniButton disabled={busy === d.id} onClick={() => void revoke(d)}>
                      {busy === d.id ? "Revoking…" : "Revoke"}
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
