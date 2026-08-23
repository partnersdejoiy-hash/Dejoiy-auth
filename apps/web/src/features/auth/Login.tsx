import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { ApiError } from "../../lib/api";
import { AuthCard, AuthButton, SecureInput } from "../../components/ui";
import { LoginScene } from "./LoginScene";
import { homeFor } from "../../App";
import "./login.css";

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();

  const [sceneDone, setSceneDone] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  // MFA step
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBlocked(false);
    setLoading(true);
    try {
      const result = await login(identifier, password);
      if (result.mfaChallenge) {
        setMfaChallenge(result.mfaChallenge.challenge);
        setLoading(false);
        return;
      }
      navigate(homeFor(result.user));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sign-in failed";
      setError(message);
      setBlocked(true);
      setTimeout(() => setBlocked(false), 1400);
    } finally {
      setLoading(false);
    }
  };

  const handleMfa = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (!mfaChallenge) throw new Error("Challenge missing");
      const result = await verifyMfa(identifier, mfaCode, mfaChallenge);
      navigate(homeFor(result.user));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "MFA verification failed");
      setBlocked(true);
      setTimeout(() => setBlocked(false), 1400);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <LoginScene onEstablished={() => setSceneDone(true)} />

      <div className={`login-card-wrap ${sceneDone ? "rise" : ""}`}>
        <AuthCard>
          <div className="login-brand">
            <img src="/brand/dejoiy-auth-mark.svg" alt="DEJOIY AUTH" width="52" height="52" className="logo-hover" />
            <div className="login-brand-text">
              <div className="login-title">DEJOIY AUTH</div>
              <div className="login-sub">Centralized Identity &amp; Access</div>
            </div>
          </div>

          {error && (
            <div className={`auth-error ${blocked ? "pulse" : ""}`} role="alert">
              <div className="auth-error-title">AUTHENTICATION BLOCKED</div>
              <div className="auth-error-msg">{error}</div>
            </div>
          )}

          {mfaChallenge ? (
            <form onSubmit={handleMfa}>
              <SecureInput
                label="Authenticator code"
                name="mfaCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                placeholder="6-digit code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                required
              />
              <AuthButton loading={loading} type="submit">Verify identity</AuthButton>
              <button type="button" className="link-btn" onClick={() => setMfaChallenge(null)}>
                ← Back to sign-in
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit}>
              <SecureInput
                label="Email / Employee ID"
                name="identifier"
                type="email"
                autoComplete="username"
                placeholder="you@dejoiy.com"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
              <SecureInput
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                toggle
                required
              />
              <div className="flex-between mt-8 mb-16" style={{ fontSize: 12.5 }}>
                <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
                <span className="dim">Access governed by DEJOIY RBAC</span>
              </div>
              <AuthButton loading={loading} type="submit">
                {loading ? "Authenticating" : "Establish secure session"}
              </AuthButton>
            </form>
          )}
        </AuthCard>
      </div>
    </div>
  );
}
