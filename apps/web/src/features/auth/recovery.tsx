import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { AuthCard, AuthButton, SecureInput, PasswordStrength } from "../../components/ui";

function AuthShell({ children, sub }: { children: React.ReactNode; sub: string }) {
  return (
    <div className="recovery-page">
      <div className="recovery-inner">
        <AuthCard>
          <div className="login-brand">
            <img src="/brand/dejoiy-auth-mark.svg" alt="DEJOIY AUTH" width="44" height="44" />
            <div>
              <div className="login-title" style={{ fontSize: 16 }}>DEJOIY AUTH</div>
              <div className="login-sub">{sub}</div>
            </div>
          </div>
          {children}
        </AuthCard>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell sub="Password recovery">
      {sent ? (
        <div className="recovery-ok">
          <p>If an account exists for <strong>{email}</strong>, a secure reset link has been sent.</p>
          <p className="dim">The link expires in 15 minutes and can only be used once.</p>
          <Link to="/login" className="auth-link">← Back to sign-in</Link>
        </div>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="auth-error"><div className="auth-error-msg">{error}</div></div>}
          <SecureInput label="Account email" name="email" type="email" autoComplete="email"
            placeholder="you@dejoiy.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <AuthButton loading={loading} type="submit">Send reset link</AuthButton>
          <button type="button" className="link-btn" onClick={() => window.history.back()}>← Back</button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      setDone(true);
      setTimeout(() => navigate("/login"), 1400);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell sub="Create a new password">
      {done ? (
        <div className="recovery-ok">
          <p>Password updated. All other sessions were revoked for your safety.</p>
          <p className="dim">Redirecting to sign-in…</p>
        </div>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="auth-error"><div className="auth-error-msg">{error}</div></div>}
          <SecureInput label="New password" name="password" type="password" autoComplete="new-password"
            placeholder="14+ characters" value={password} onChange={(e) => setPassword(e.target.value)} toggle required />
          <PasswordStrength password={password} />
          <SecureInput label="Confirm password" name="confirm" type="password" autoComplete="new-password"
            placeholder="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          <AuthButton loading={loading} type="submit">Reset password</AuthButton>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const token = params.get("token") ?? "";

  useEffect(() => {
    void (async () => {
      try {
        await api.post("/auth/verify-email", { token });
        setState("ok");
      } catch {
        setState("error");
      }
    })();
  }, [token]);

  return (
    <AuthShell sub="Email verification">
      <div className="recovery-ok">
        {state === "loading" && <p>Verifying your email address…</p>}
        {state === "ok" && (
          <>
            <p>Your email address is now verified.</p>
            <Link to="/login" className="auth-link">Continue to sign-in →</Link>
          </>
        )}
        {state === "error" && (
          <>
            <p>This verification link is invalid or has expired.</p>
            <Link to="/login" className="auth-link">← Back to sign-in</Link>
          </>
        )}
      </div>
    </AuthShell>
  );
}
