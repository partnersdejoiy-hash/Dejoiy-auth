import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, formatDate, timeAgo } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  StatusBadge, ErrorScreen, AuthButton, MiniButton, ConfirmDialog,
  Modal, SecureInput, CopyField, useToasts
} from "../../components/ui";

interface SessionRow {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  device_label: string | null;
}
interface DeviceRow {
  id: string;
  label: string | null;
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  active_sessions: number;
}

export function UserDetailPage({ base = "/admin" }: { base?: string }) {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const [user, setUser] = useState<any>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "sessions" | "devices" | "roles">("overview");
  const [confirm, setConfirm] = useState<{ action: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const toasts = useToasts();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [u, s, d] = await Promise.all([
        api.get(`/users/${id}`),
        api.get(`/users/${id}/sessions`),
        api.get(`/users/${id}/devices`)
      ]);
      setUser(u);
      setSessions(s as SessionRow[]);
      setDevices(d as DeviceRow[]);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load user");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (action: string) => {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/users/${id}/${action}`, {});
      toasts.push("success", `Action ${action} applied`);
      setConfirm(null);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const changeRoles = async (roles: string[]) => {
    if (!id) return;
    try {
      await api.post(`/users/${id}/roles`, { roles });
      toasts.push("success", "Roles updated");
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Role update failed");
    }
  };

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;
  if (!user) return <div className="page"><div className="muted">Loading identity…</div></div>;

  const can = (p: string) => hasPermission(p);

  return (
    <div className="page">
      <Link to={`${base}/users`} className="muted" style={{ fontSize: 13 }}>← Back to users</Link>
      <div className="flex-between wrap mt-8 mb-16">
        <div className="flex">
          <h1 className="page-title">{user.full_name ?? user.email}</h1>
          <StatusBadge status={user.account_state} />
        </div>
        <div className="flex wrap">
          {can("user.activate") && <MiniButton onClick={() => runAction("activate")}>Activate</MiniButton>}
          {can("user.suspend") && <MiniButton onClick={() => setConfirm({ action: "suspend" })}>Suspend</MiniButton>}
          {can("user.block") && <MiniButton className="danger" onClick={() => setConfirm({ action: "block" })}>Block</MiniButton>}
          {can("user.unlock") && <MiniButton onClick={() => runAction("unlock")}>Unlock</MiniButton>}
          {can("user.force_logout") && <MiniButton onClick={() => setConfirm({ action: "force-logout" })}>Force logout</MiniButton>}
          {can("user.reset_password") && <MiniButton onClick={() => setResetOpen(true)}>Reset password</MiniButton>}
          {can("user.reset_mfa") && <MiniButton onClick={() => setConfirm({ action: "reset-mfa" })}>Reset MFA</MiniButton>}
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`tab ${tab === "sessions" ? "active" : ""}`} onClick={() => setTab("sessions")}>Sessions ({sessions.length})</button>
        <button className={`tab ${tab === "devices" ? "active" : ""}`} onClick={() => setTab("devices")}>Devices ({devices.length})</button>
        <button className={`tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>Roles</button>
      </div>

      {tab === "overview" && (
        <div className="detail-grid">
          <div className="detail-item"><div className="k">Internal ID</div><div className="v mono">{user.user_number}</div></div>
          <div className="detail-item"><div className="k">Email</div><div className="v">{user.email ?? "—"}</div></div>
          <div className="detail-item"><div className="k">Type</div><div className="v">{user.user_type}</div></div>
          <div className="detail-item"><div className="k">State</div><div className="v">{user.account_state}</div></div>
          <div className="detail-item"><div className="k">MFA</div><div className="v">{user.mfa_enabled ? "Enrolled" : "Not enrolled"}{user.mfa_required ? " · required" : ""}</div></div>
          <div className="detail-item"><div className="k">Employee ID</div><div className="v mono">{user.employee?.employee_id ?? "—"}</div></div>
          <div className="detail-item"><div className="k">Department</div><div className="v">{user.employee?.department_id ?? "—"}</div></div>
          <div className="detail-item"><div className="k">Employment</div><div className="v">{user.employee?.employment_status ?? "—"}</div></div>
          <div className="detail-item"><div className="k">Last login</div><div className="v">{formatDate(user.last_login_at)}</div></div>
          <div className="detail-item"><div className="k">Created</div><div className="v">{formatDate(user.created_at)}</div></div>
          <div className="detail-item"><div className="k">Failed logins</div><div className="v">{user.failed_login_count}</div></div>
          <div className="detail-item"><div className="k">Locked until</div><div className="v">{formatDate(user.locked_until)}</div></div>
        </div>
      )}

      {tab === "sessions" && (
        <div className="panel">
          {sessions.length === 0 ? <div className="muted">No sessions.</div> : (
            <table className="data">
              <thead><tr><th>Created</th><th>Last active</th><th>IP</th><th>Device</th><th>State</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDate(s.created_at)}</td>
                    <td>{timeAgo(s.last_active_at)}</td>
                    <td className="mono">{s.ip ?? "—"}</td>
                    <td className="muted">{s.device_label ?? "—"}</td>
                    <td>{s.revoked_at ? <span className="muted">revoked · {s.revoke_reason}</span> : <StatusBadge status="ACTIVE" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "devices" && (
        <div className="panel">
          {devices.length === 0 ? <div className="muted">No devices registered.</div> : (
            <table className="data">
              <thead><tr><th>Label</th><th>Fingerprint</th><th>First seen</th><th>Last seen</th><th>Active sessions</th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>{d.label ?? "—"}</td>
                    <td className="mono dim">{d.fingerprint.slice(0, 16)}…</td>
                    <td>{formatDate(d.first_seen_at)}</td>
                    <td>{timeAgo(d.last_seen_at)}</td>
                    <td>{d.active_sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "roles" && (
        <RolesEditor
          current={user.roles ?? []}
          canEdit={can("role.assign")}
          onChange={changeRoles}
        />
      )}

      {confirm?.action === "force-logout" && (
        <ConfirmDialog
          title="Force logout this user?"
          message="All sessions and refresh tokens will be revoked immediately."
          confirmLabel="Force logout"
          danger
          busy={busy}
          onConfirm={() => void runAction("force-logout")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.action === "reset-mfa" && (
        <ConfirmDialog
          title="Reset MFA for this user?"
          message="Active authenticator factors and recovery codes will be revoked. The user must re-enroll."
          confirmLabel="Reset MFA"
          danger
          busy={busy}
          onConfirm={() => void runAction("reset-mfa")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.action === "block" && (
        <ConfirmDialog
          title="Block this user?"
          message="The account will be unable to sign in until unblocked."
          confirmLabel="Block"
          danger
          busy={busy}
          onConfirm={() => void runAction("block")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.action === "suspend" && (
        <ConfirmDialog
          title="Suspend this user?"
          message="Sign-in will be rejected while suspended."
          confirmLabel="Suspend"
          busy={busy}
          onConfirm={() => void runAction("suspend")}
          onCancel={() => setConfirm(null)}
        />
      )}

      {resetOpen && (
        <ResetPasswordModal
          onClose={() => setResetOpen(false)}
          onDone={async (pw) => {
            setResetOpen(false);
            toasts.push("success", "Password reset applied");
            await load();
          }}
        />
      )}
      {toasts.node}
    </div>
  );
}

function RolesEditor({ current, canEdit, onChange }: {
  current: string[];
  canEdit: boolean;
  onChange: (roles: string[]) => Promise<void>;
}) {
  const [roles, setRoles] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.get<Array<{ name: string }>>("/roles").then((r) => setRoles(r.map((x) => x.name))).catch(() => {}); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = value.split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
    if (next.length === 0) return;
    setBusy(true);
    await onChange(next);
    setValue("");
    setBusy(false);
  };

  return (
    <div className="panel">
      <div className="flex wrap mb-16">
        {current.map((r) => (
          <span key={r} className="status-badge st-active">{r}</span>
        ))}
        {current.length === 0 && <span className="muted">No roles assigned.</span>}
      </div>
      {canEdit && (
        <form onSubmit={submit} className="flex" style={{ maxWidth: 480 }}>
          <input placeholder="Add roles, comma separated (e.g. WFM_AGENT, EMPLOYEE)" value={value}
            onChange={(e) => setValue(e.target.value)} aria-label="Add roles" />
          <AuthButton loading={busy} type="submit" style={{ maxWidth: 140 }}>Assign</AuthButton>
        </form>
      )}
    </div>
  );
}

function ResetPasswordModal({ onClose, onDone }: { onClose: () => void; onDone: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const { id } = useParams<{ id: string }>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords do not match"); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/users/${id}/reset-password`, { newPassword: password, forceChange: true });
      await onDone(password);
      toasts.push("success", "Password reset — user must change it on next sign-in");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Reset password" onClose={onClose}>
      <form onSubmit={submit}>
        <SecureInput label="New password" name="pw" type="password" value={password} toggle required
          onChange={(e) => setPassword(e.target.value)} placeholder="14+ characters" />
        <SecureInput label="Confirm" name="pw2" type="password" value={confirm} required
          onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat" />
        {error && <div className="auth-error mb-16"><div className="auth-error-msg">{error}</div></div>}
        <div className="flex" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" type="button" onClick={onClose}>Cancel</AuthButton>
          <AuthButton loading={busy} type="submit" style={{ maxWidth: 160 }}>Set password</AuthButton>
        </div>
      </form>
    </Modal>
  );
}
