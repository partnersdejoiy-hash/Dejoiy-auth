import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  ErrorScreen, EmptyState, AuthButton, MiniButton, Modal, SecureInput,
  CopyField, useToasts, StatusBadge
} from "../../components/ui";

interface AppRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  redirectUris: string[];
  allowedOrigins: string[];
  defaultScopes: string[];
  status: string;
  clientId: string | null;
  createdAt: string;
}

export function ApplicationsPage() {
  const { hasPermission } = useAuth();
  const [apps, setApps] = useState<AppRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const toasts = useToasts();

  const load = async () => {
    try {
      setApps(await api.get<AppRow[]>("/applications"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load applications");
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <div className="flex-between wrap mb-16">
        <div>
          <h1 className="page-title">Access — Applications</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>OIDC/OAuth2 client registry for DEJOIY applications</p>
        </div>
        {hasPermission("application.create") && <MiniButton onClick={() => setCreateOpen(true)}>+ Register app</MiniButton>}
      </div>

      {error ? (
        <ErrorScreen title="LOAD FAILED" message={error} onRetry={() => void load()} />
      ) : apps.length === 0 ? (
        <EmptyState title="No applications registered" hint="Register the first DEJOIY application to begin integration" />
      ) : (
        <div className="grid">
          {apps.map((a) => (
            <div key={a.id} className="panel">
              <div className="flex-between">
                <div className="flex">
                  <strong>{a.name}</strong>
                  <StatusBadge status={a.status.toUpperCase()} />
                </div>
                <span className="dim mono">{a.type}</span>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 12px" }}>{a.description ?? "—"}</p>
              {a.clientId && <CopyField label="client_id" value={a.clientId} />}
              <div className="dim" style={{ fontSize: 12 }}>
                <div>Redirect URIs: <span className="mono">{a.redirectUris.join(", ") || "none"}</span></div>
                <div>Scopes: <span className="mono">{a.defaultScopes.join(", ")}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateAppModal
          onClose={() => setCreateOpen(false)}
          onCreated={(creds) => {
            setCreateOpen(false);
            setRevealed(creds);
            void load();
          }}
        />
      )}

      {revealed && (
        <Modal title="Application registered" onClose={() => setRevealed(null)}>
          <p className="mb-16" style={{ fontSize: 13 }}>
            Store these credentials server-side. The secret is shown only once.
          </p>
          <CopyField label="client_id" value={revealed.clientId} />
          <CopyField label="client_secret" value={revealed.clientSecret} />
          <div className="flex mt-16" style={{ justifyContent: "flex-end" }}>
            <AuthButton onClick={() => setRevealed(null)} style={{ maxWidth: 140 }}>Done</AuthButton>
          </div>
        </Modal>
      )}
      {toasts.node}
    </div>
  );
}

function CreateAppModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (creds: { clientId: string; clientSecret: string }) => void;
}) {
  const [form, setForm] = useState({ name: "", type: "web", description: "", redirectUris: "", allowedOrigins: "", defaultScopes: "openid profile email" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ clientId: string; clientSecret: string }>("/applications", {
        name: form.name,
        type: form.type,
        description: form.description || undefined,
        redirectUris: form.redirectUris.split("\n").map((s) => s.trim()).filter(Boolean),
        allowedOrigins: form.allowedOrigins.split("\n").map((s) => s.trim()).filter(Boolean),
        defaultScopes: form.defaultScopes.split(" ").filter(Boolean)
      });
      onCreated(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Register application" onClose={onClose}>
      <form onSubmit={submit}>
        <SecureInput label="Name" name="name" required placeholder="DEJOIY Marketplace"
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div className="secure-input">
          <label>Type</label>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="web">web (server-backed)</option>
            <option value="spa">spa</option>
            <option value="native">native</option>
            <option value="service">service</option>
          </select>
        </div>
        <SecureInput label="Description" name="desc" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <SecureInput label="Redirect URIs (one per line)" name="uris" placeholder="https://app.dejoiy.com/callback"
          value={form.redirectUris} onChange={(e) => setForm({ ...form, redirectUris: e.target.value })} />
        <SecureInput label="Allowed origins (one per line)" name="origins" placeholder="https://app.dejoiy.com"
          value={form.allowedOrigins} onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })} />
        <SecureInput label="Default scopes" name="scopes" value={form.defaultScopes}
          onChange={(e) => setForm({ ...form, defaultScopes: e.target.value })} />
        {error && <div className="auth-error mb-16"><div className="auth-error-msg">{error}</div></div>}
        <div className="flex" style={{ justifyContent: "flex-end" }}>
          <AuthButton variant="ghost" type="button" onClick={onClose}>Cancel</AuthButton>
          <AuthButton loading={busy} type="submit" style={{ maxWidth: 160 }}>Register</AuthButton>
        </div>
      </form>
    </Modal>
  );
}
