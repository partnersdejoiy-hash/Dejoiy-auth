import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  ErrorScreen, EmptyState, AuthButton, MiniButton, Modal, SecureInput,
  useToasts, StatusBadge
} from "../../components/ui";

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
}
interface PermissionRow {
  id: string;
  name: string;
  resource: string;
  description: string | null;
}

export function RolesPage() {
  const { hasPermission } = useAuth();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [perms, setPerms] = useState<PermissionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoleRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const toasts = useToasts();

  const load = async () => {
    try {
      const [r, p] = await Promise.all([
        api.get<RoleRow[]>("/roles"),
        api.get<PermissionRow[]>("/permissions")
      ]);
      setRoles(r);
      setPerms(p);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load roles");
    }
  };

  useEffect(() => { void load(); }, []);

  const canEdit = hasPermission("role.update") || hasPermission("permission.assign");

  const grouped = perms.reduce<Record<string, PermissionRow[]>>((acc, p) => {
    (acc[p.resource] ??= []).push(p);
    return acc;
  }, {});

  if (error) return <div className="page"><ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} /></div>;

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Roles &amp; Permissions</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Role ≠ permission. RBAC enforced server-side.</p>
        </div>
        {hasPermission("role.create") && <MiniButton onClick={() => setCreateOpen(true)}>+ New role</MiniButton>}
      </div>

      <div className="grid grid-3">
        {roles.map((role) => (
          <button key={role.id} className="role-card" onClick={() => setSelected(role)}>
            <div className="flex-between">
              <strong className="mono">{role.name}</strong>
              {role.is_system && <StatusBadge status="SYSTEM" />}
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "8px 0" }}>{role.description ?? "—"}</p>
            <div className="role-perms">
              {(role.permissions ?? []).slice(0, 5).map((p) => (
                <span key={p} className="perm-chip">{p}</span>
              ))}
              {(role.permissions ?? []).length > 5 && (
                <span className="perm-chip">+{(role.permissions ?? []).length - 5}</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <RoleEditor
          role={selected}
          grouped={grouped}
          canEdit={canEdit && !selected.is_system}
          onClose={() => setSelected(null)}
          onSaved={async () => { setSelected(null); await load(); }}
        />
      )}

      {createOpen && (
        <CreateRoleModal
          grouped={grouped}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => { setCreateOpen(false); await load(); }}
        />
      )}
      {toasts.node}
    </div>
  );
}

function RoleEditor({ role, grouped, canEdit, onClose, onSaved }: {
  role: RoleRow;
  grouped: Record<string, PermissionRow[]>;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(role.permissions));
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const toggle = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/roles/${role.id}`, { permissions: [...checked] });
      toasts.push("success", `Permissions updated for ${role.name}`);
      await onSaved();
    } catch (err) {
      toasts.push("error", err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${role.name} — permissions`} onClose={onClose}>
      <div className="perm-matrix">
        {Object.entries(grouped).map(([resource, perms]) => (
          <div key={resource} className="perm-group">
            <div className="perm-resource">{resource}</div>
            <div className="flex wrap">
              {perms.map((p) => (
                <label key={p.id} className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={checked.has(p.name)}
                    disabled={!canEdit}
                    onChange={() => toggle(p.name)}
                  />
                  <span className={checked.has(p.name) ? "on" : ""}>{p.name}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="flex mt-16" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" onClick={onClose}>Close</AuthButton>
          <AuthButton loading={busy} onClick={() => void save()} style={{ maxWidth: 160 }}>Save changes</AuthButton>
        </div>
      )}
    </Modal>
  );
}

function CreateRoleModal({ grouped, onClose, onCreated }: {
  grouped: Record<string, PermissionRow[]>;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/roles", { name, description, permissions: [...checked] });
      toasts.push("success", "Role created");
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Creation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create role" onClose={onClose}>
      <form onSubmit={submit}>
        <SecureInput label="Role name" name="name" placeholder="OPERATIONS_MANAGER" value={name} required
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
        <SecureInput label="Description" name="desc" value={description}
          onChange={(e) => setDescription(e.target.value)} />
        <div className="perm-matrix" style={{ maxHeight: 260 }}>
          {Object.entries(grouped).map(([resource, perms]) => (
            <div key={resource} className="perm-group">
              <div className="perm-resource">{resource}</div>
              <div className="flex wrap">
                {perms.map((p) => (
                  <label key={p.id} className="perm-toggle">
                    <input type="checkbox" checked={checked.has(p.name)}
                      onChange={() => {
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.name)) next.delete(p.name); else next.add(p.name);
                          return next;
                        });
                      }} />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        {error && <div className="auth-error mb-16"><div className="auth-error-msg">{error}</div></div>}
        <div className="flex mt-16" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" type="button" onClick={onClose}>Cancel</AuthButton>
          <AuthButton loading={busy} type="submit" style={{ maxWidth: 160 }}>Create role</AuthButton>
        </div>
      </form>
    </Modal>
  );
}
