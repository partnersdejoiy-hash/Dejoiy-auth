import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatDate, timeAgo } from "../../lib/api";
import {
  StatusBadge, ErrorScreen, EmptyState, Modal, SecureInput, AuthButton,
  MiniButton, ConfirmDialog, useToasts
} from "../../components/ui";

interface Employee {
  id: string;
  user_number: string;
  email: string | null;
  full_name: string | null;
  account_state: string;
  employee_id: string | null;
  employment_status: string | null;
  designation: string | null;
  department: string | null;
  manager: string | null;
  agent_status: string | null;
  shift_id: string | null;
  access_eligibility: boolean;
  hire_date: string | null;
  last_login_at: string | null;
}

export function EmployeesPage() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (search) params.set("search", search);
      if (status) params.set("employmentStatus", status);
      const res = await api.get<{ rows: Employee[]; total: number }>(`/wfm/employees?${params}`);
      setRows(res.rows);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load employees");
    }
  };

  useEffect(() => { void load(); }, [status]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const runBulk = async () => {
    if (!bulkAction || selected.length === 0) return;
    setBusy(true);
    try {
      const res = await api.post<{ processed: number }>("/wfm/bulk-lifecycle", {
        userIds: selected,
        action: bulkAction,
        reason: "bulk_action_from_wfm_panel"
      });
      toasts.push("success", `Bulk ${bulkAction}: ${res.processed} processed`);
      setBulkAction(null);
      setSelected([]);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Bulk action failed");
    } finally {
      setBusy(false);
    }
  };

  const single = async (id: string, action: string) => {
    setBusy(true);
    try {
      await api.post(`/users/${id}/${action}`, {});
      toasts.push("success", `${action} applied`);
      await load();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (e: FormEvent) => { e.preventDefault(); void load(); };

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Workforce — Employees</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>{total} employees · employee-centric identity lifecycle</p>
        </div>
        <MiniButton onClick={() => setOnboardOpen(true)}>+ Onboard employee</MiniButton>
      </div>

      <form onSubmit={submitSearch} className="flex wrap mb-16">
        <input style={{ maxWidth: 320 }} placeholder="Search name, email, employee ID…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search employees" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by employment status">
          <option value="">All employment statuses</option>
          <option value="active">active</option>
          <option value="resigned">resigned</option>
          <option value="terminated">terminated</option>
          <option value="absconded">absconded</option>
        </select>
        <MiniButton type="submit">Search</MiniButton>
      </form>

      {selected.length > 0 && (
        <div className="panel mb-16 flex wrap" style={{ borderColor: "var(--dj-border-strong)" }}>
          <strong>{selected.length} selected</strong>
          <MiniButton onClick={() => setBulkAction("activate")}>Activate</MiniButton>
          <MiniButton onClick={() => setBulkAction("suspend")}>Suspend</MiniButton>
          <MiniButton className="danger" onClick={() => setBulkAction("block")}>Block</MiniButton>
          <MiniButton className="danger" onClick={() => setBulkAction("terminate")}>Terminate</MiniButton>
          <button className="btn-mini" style={{ marginLeft: "auto" }} onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {error ? <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /> : rows.length === 0 ? (
        <EmptyState title="No employees" hint="Onboard the first employee to begin the WFM lifecycle" />
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 32 }} />
                <th>Employee</th><th>Dept</th><th>Manager</th><th>State</th>
                <th>Agent</th><th>Eligible</th><th>Shift</th><th>Last login</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggleSelect(e.id)}
                      aria-label={`Select ${e.full_name ?? e.email}`} />
                  </td>
                  <td>
                    <div className="user-cell">
                      <strong>{e.full_name ?? e.email}</strong>
                      <span className="mono dim">{e.employee_id ?? e.user_number}</span>
                    </div>
                  </td>
                  <td className="muted">{e.department ?? "—"}</td>
                  <td className="muted">{e.manager ?? "—"}</td>
                  <td><StatusBadge status={e.account_state} /></td>
                  <td className="mono muted">{e.agent_status ?? "offline"}</td>
                  <td>{e.access_eligibility ? <StatusBadge status="ACTIVE" /> : <span className="dim">—</span>}</td>
                  <td className="mono dim">{e.shift_id ?? "—"}</td>
                  <td className="muted">{timeAgo(e.last_login_at)}</td>
                  <td>
                    <div className="flex">
                      <MiniButton onClick={() => void single(e.id, "activate")}>Activate</MiniButton>
                      <MiniButton className="danger" onClick={() => void single(e.id, "disable")}>Disable</MiniButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onboardOpen && (
        <OnboardModal onClose={() => setOnboardOpen(false)} onDone={async () => { setOnboardOpen(false); await load(); }} />
      )}

      {bulkAction && (
        <ConfirmDialog
          title={`Bulk ${bulkAction}?`}
          message={`This will apply "${bulkAction}" to ${selected.length} selected employees. Every action is audited.`}
          confirmLabel={`${bulkAction} all`}
          danger={bulkAction === "block" || bulkAction === "terminate"}
          busy={busy}
          onConfirm={() => void runBulk()}
          onCancel={() => setBulkAction(null)}
        />
      )}
      {toasts.node}
    </div>
  );
}

function OnboardModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ email: "", fullName: "", employeeId: "", designation: "", roles: "EMPLOYEE" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const roles = form.roles.split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
      await api.post("/wfm/employees", { ...form, roles });
      toasts.push("success", "Employee onboarded — placed in activation queue");
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Onboarding failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Onboard employee" onClose={onClose}>
      <form onSubmit={submit}>
        <SecureInput label="Email" name="email" type="email" required placeholder="employee@dejoiy.com"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <SecureInput label="Full name" name="fullName" required placeholder="Rahul Verma"
          value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        <SecureInput label="Employee ID" name="employeeId" required placeholder="EMP-1001"
          value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} />
        <SecureInput label="Designation" name="designation" placeholder="WFM Agent"
          value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
        <SecureInput label="Roles (comma separated)" name="roles" value={form.roles}
          onChange={(e) => setForm({ ...form, roles: e.target.value })} />
        {error && <div className="auth-error mb-16"><div className="auth-error-msg">{error}</div></div>}
        <div className="flex" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" type="button" onClick={onClose}>Cancel</AuthButton>
          <AuthButton loading={busy} type="submit" style={{ maxWidth: 170 }}>Onboard</AuthButton>
        </div>
      </form>
    </Modal>
  );
}
