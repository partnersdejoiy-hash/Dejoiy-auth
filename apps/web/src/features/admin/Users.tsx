import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, formatDate, timeAgo } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  StatusBadge, Modal, SecureInput, AuthButton, ErrorScreen, EmptyState,
  ConfirmDialog, MiniButton, useToasts
} from "../../components/ui";

interface UserRow {
  id: string;
  user_number: string;
  email: string | null;
  full_name: string | null;
  user_type: string;
  account_state: string;
  roles: string[] | null;
  employee_id: string | null;
  last_login_at: string | null;
  created_at: string;
}

const STATES = ["ACTIVE", "PENDING", "SUSPENDED", "BLOCKED", "LOCKED", "DISABLED", "TERMINATED", "PASSWORD_RESET_REQUIRED"];

export function UsersPage({ base = "/admin" }: { base?: string }) {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<UserRow | null>(null);
  const [action, setAction] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (search) params.set("search", search);
      if (stateFilter) params.set("state", stateFilter);
      const res = await api.get<{ rows: UserRow[]; total: number }>(`/users?${params}`);
      setRows(res.rows);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load users");
    }
  };

  useEffect(() => { void load(); }, [stateFilter, limit]);

  const doLifecycle = async (user: UserRow, act: string) => {
    setBusy(true);
    try {
      await api.post(`/users/${user.id}/${act}`, {});
      toasts.push("success", `${act} applied to ${user.email ?? user.user_number}`);
      setTarget(null);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (e: FormEvent) => { e.preventDefault(); void load(); };

  const can = (p: string) => hasPermission(p);

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Identity — Users</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>{total} identities · database is the source of truth</p>
        </div>
        {can("user.create") && <MiniButton onClick={() => setCreateOpen(true)}>+ Create user</MiniButton>}
      </div>

      <form onSubmit={submitSearch} className="flex wrap mb-16">
        <input
          style={{ maxWidth: 320 }}
          placeholder="Search email, ID, name, employee ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
        />
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} aria-label="Filter by state">
          <option value="">All states</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <MiniButton type="submit">Search</MiniButton>
      </form>

      {error ? (
        <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No users match" hint="Adjust filters or create a user" />
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>User</th><th>Type</th><th>Roles</th><th>State</th><th>Last login</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link to={`${base}/users/${u.id}`} className="user-cell">
                      <strong>{u.full_name ?? u.email}</strong>
                      <span className="mono dim">{u.user_number}</span>
                      {u.employee_id && <span className="dim">· {u.employee_id}</span>}
                    </Link>
                  </td>
                  <td className="muted">{u.user_type}</td>
                  <td className="mono muted">{(u.roles ?? []).slice(0, 2).join(", ")}{(u.roles ?? []).length > 2 ? ` +${(u.roles ?? []).length - 2}` : ""}</td>
                  <td><StatusBadge status={u.account_state} /></td>
                  <td className="muted">{timeAgo(u.last_login_at)}</td>
                  <td className="muted">{formatDate(u.created_at)}</td>
                  <td>
                    <div className="flex">
                      <Link to={`${base}/users/${u.id}`} className="btn-mini">Open</Link>
                      {can("user.block") && u.account_state !== "BLOCKED" && (
                        <MiniButton className="danger" onClick={() => { setTarget(u); setAction("block"); }}>Block</MiniButton>
                      )}
                      {can("user.force_logout") && (
                        <MiniButton onClick={() => { setTarget(u); setAction("force-logout"); }}>Logout</MiniButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => { setCreateOpen(false); await load(); }}
        />
      )}

      {target && action && (
        <ConfirmDialog
          title={`${action === "block" ? "Block" : "Force logout"} ${target.email ?? target.user_number}?`}
          message={
            action === "block"
              ? "The user will be unable to sign in. Access can be restored with unblock."
              : "All sessions for this user will be revoked immediately."
          }
          confirmLabel={action === "block" ? "Block account" : "Force logout"}
          danger={action === "block"}
          onConfirm={() => void doLifecycle(target, action === "force-logout" ? "force-logout" : "block")}
          onCancel={() => setTarget(null)}
          busy={busy}
        />
      )}
      {toasts.node}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [form, setForm] = useState({ userType: "employee", email: "", fullName: "", roles: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const roles = form.roles.split(",").map((r) => r.trim()).filter(Boolean);
      await api.post("/users", { ...form, roles });
      toasts.push("success", "User created");
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Creation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create identity" onClose={onClose}>
      <form onSubmit={submit}>
        <SecureInput label="User type" name="type" value={form.userType} readOnly />
        <SecureInput label="Email" name="email" type="email" required placeholder="user@dejoiy.com"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <SecureInput label="Full name" name="fullName" placeholder="Asha K"
          value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        <SecureInput label="Roles (comma separated)" name="roles" placeholder="EMPLOYEE, WFM_AGENT"
          value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} />
        {error && <div className="auth-error mb-16"><div className="auth-error-msg">{error}</div></div>}
        <div className="flex" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" type="button" onClick={onClose}>Cancel</AuthButton>
          <AuthButton loading={loading} type="submit" style={{ maxWidth: 160 }}>Create</AuthButton>
        </div>
      </form>
    </Modal>
  );
}
