import {
  useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type ReactNode
} from "react";
import "./ui.css";

/* ---------- Spinner ---------- */
export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="dj-spinner" style={{ width: size, height: size }} aria-hidden />;
}

/* ---------- AuthCard ---------- */
export function AuthCard({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`auth-card ${wide ? "auth-card-wide" : ""}`}>
      {children}
    </div>
  );
}

/* ---------- SecureInput ---------- */
interface SecureInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  toggle?: boolean; // password visibility toggle
}

export function SecureInput({ label, toggle, id, ...rest }: SecureInputProps) {
  const [visible, setVisible] = useState(false);
  const inputId = id ?? rest.name ?? "field";
  const type = rest.type === "password" && visible ? "text" : rest.type;
  return (
    <div className="secure-input">
      <label htmlFor={inputId}>{label}</label>
      <div className="secure-input-wrap">
        <input id={inputId} {...rest} type={type} aria-label={label} />
        {toggle && (
          <button
            type="button"
            className="pw-toggle"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
          >
            {visible ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- PasswordStrength ---------- */
export function PasswordStrength({ password }: { password: string }) {
  const score = useMemoScore(password);
  const labels = ["Weak", "Weak", "Fair", "Good", "Strong"];
  return (
    <div className="pw-strength" aria-live="polite">
      <div className="pw-strength-bars">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < score ? `bar bar-${score}` : "bar"} />
        ))}
      </div>
      {password.length > 0 && (
        <span className="pw-strength-label">{labels[score]}</span>
      )}
    </div>
  );
}

function useMemoScore(password: string): number {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(4, score);
}

/* ---------- AuthButton ---------- */
interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
}

export function AuthButton({ loading, children, variant = "primary", ...rest }: AuthButtonProps) {
  return (
    <button className={`auth-btn ${variant}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner /> : <span className="btn-sweep" aria-hidden />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

/* ---------- StatusBadge ---------- */
export function StatusBadge({ status }: { status: string }) {
  const cls = status.toLowerCase().replace(/\s+/g, "-");
  return <span className={`status-badge st-${cls}`}>{status}</span>;
}

/* ---------- SecurityBadge ---------- */
export function SecurityBadge({ severity }: { severity: string }) {
  const cls = severity.toLowerCase();
  return <span className={`security-badge sev-${cls}`}>{severity.toUpperCase()}</span>;
}

/* ---------- Loading / Error screens ---------- */
export function LoadingScreen({ label = "Establishing secure channel" }: { label?: string }) {
  return (
    <div className="loading-screen" role="status">
      <div className="loading-core">
        <span className="ring" />
        <span className="ring ring-2" />
        <Spinner size={26} />
      </div>
      <p className="loading-label">{label}…</p>
    </div>
  );
}

export function ErrorScreen({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="error-screen" role="alert">
      <span className="error-code">{title}</span>
      <p>{message}</p>
      {onRetry && <AuthButton onClick={onRetry}>Retry</AuthButton>}
    </div>
  );
}

/* ---------- Toast ---------- */
export interface ToastData {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
}

let toastId = 0;
export function useToasts() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const push = (kind: ToastData["kind"], message: string) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const node = (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
  return { push, node };
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------- StatCard ---------- */
export function StatCard({ label, value, accent = "cyan" }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className={`stat-card accent-${accent}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/* ---------- EmptyState ---------- */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-glyph">◌</span>
      <p>{title}</p>
      {hint && <p className="dim">{hint}</p>}
    </div>
  );
}

/* ---------- PageHeader ---------- */
export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="flex-between wrap mb-16">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub" style={{ marginBottom: 0 }}>{sub}</p>}
      </div>
      {actions && <div className="flex">{actions}</div>}
    </div>
  );
}

/* ---------- CopyField ---------- */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span className="dim">{label}</span>
      <div className="flex">
        <code className="mono">{value}</code>
        <button
          className="btn-mini"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/* ---------- ConfirmDialog ---------- */
export function ConfirmDialog({
  title, message, confirmLabel = "Confirm", danger, busy, onConfirm, onCancel
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="mb-16">{message}</p>
      <div className="flex" style={{ justifyContent: "flex-end" }}>
        <AuthButton variant="ghost" onClick={onCancel}>Cancel</AuthButton>
        <AuthButton variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{confirmLabel}</AuthButton>
      </div>
    </Modal>
  );
}

/* ---------- Mini action button ---------- */
export function MiniButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="btn-mini" {...rest}>{children}</button>;
}
