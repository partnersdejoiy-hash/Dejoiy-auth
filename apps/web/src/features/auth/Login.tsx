import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { ApiError } from "../../lib/api";
import { AuthButton, SecureInput, PasswordStrength } from "../../components/ui";
import { LoginScene } from "./LoginScene";
import { OtpVerification } from "./OtpVerification";
import "./login.css";

type AuthMode = "login" | "register";

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<AuthMode>("login");
  const [sceneReady, setSceneReady] = useState(false);
  const [swapping, setSwapping] = useState(false);

  /* Login */
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  /* Register */
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regSuccess, setRegSuccess] = useState(false);

  /* MFA / OTP */
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [showOtp, setShowOtp] = useState(false);

  const switchMode = (target: AuthMode) => {
    if (target === mode || swapping) return;
    setError(null);
    setRegError(null);
    setSwapping(true);
    // Phase 1: current content fades out (CSS handles via .swapping)
    // Phase 2: after exit completes, switch mode
    setTimeout(() => {
      setMode(target);
      // Phase 3: new content fades in
      setTimeout(() => setSwapping(false), 420);
    }, 320);
  };

  /* ---- Login ---- */
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBlocked(false);
    setLoading(true);
    try {
      const result = await login(identifier, password);
      if (result.mfaChallenge) {
        setMfaChallenge(result.mfaChallenge.challenge);
        setShowOtp(true);
        setLoading(false);
        return;
      }
      navigate("/admin");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sign-in failed";
      setError(message);
      setBlocked(true);
      setTimeout(() => setBlocked(false), 1400);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpVerified = async (code: string) => {
    if (!mfaChallenge) return;
    try {
      await verifyMfa(identifier, code, mfaChallenge);
      navigate("/admin");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "OTP verification failed";
      setError(message);
      setShowOtp(false);
      setMfaChallenge(null);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    setRegError(null);
    if (regPassword !== regConfirm) {
      setRegError("Passwords do not match");
      return;
    }
    setRegLoading(true);
    try {
      await new Promise((r) => setTimeout(r, 1200));
      setRegSuccess(true);
    } catch (err) {
      setRegError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setRegLoading(false);
    }
  };

  /* ---- OTP screen ---- */
  if (showOtp) {
    return (
      <div className="auth-page">
        <LoginScene />
        <OtpVerification
          onComplete={handleOtpVerified}
          onBack={() => { setShowOtp(false); setMfaChallenge(null); }}
        />
      </div>
    );
  }

  return (
    <div className="auth-page">
      {/* Subtle background */}
      <div className="auth-bg">
        <LoginScene onEstablished={() => setSceneReady(true)} />
      </div>

      {/* Centered card */}
      <div className={`auth-wrap ${sceneReady ? "visible" : ""}`}>
        <div className={`auth-card ${swapping ? "swapping" : ""} ${mode}`}>

          {/* ── FORM COLUMN ── */}
          <div className="auth-form-col">
            {/* ── LOGIN FORM ── */}
            <div className={`auth-panel form-panel ${mode === "login" ? "show" : ""}`}>
              <div className="auth-panel-inner">
                <div className="auth-panel-header">
                  <h1>Welcome back</h1>
                  <p>Sign in to access your DEJOIY workspace</p>
                </div>

                {error && (
                  <div className={`auth-error ${blocked ? "pulse" : ""}`} role="alert">
                    <div className="auth-error-title">AUTHENTICATION BLOCKED</div>
                    <div className="auth-error-msg">{error}</div>
                  </div>
                )}

                <form onSubmit={handleLogin}>
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
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    toggle
                    required
                  />
                  <div className="auth-forgot">
                    <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
                  </div>
                  <AuthButton loading={loading} type="submit">
                    {loading ? "Authenticating" : "Sign In"}
                  </AuthButton>
                </form>

                <p className="auth-switch">
                  New here?{" "}
                  <button type="button" onClick={() => switchMode("register")} className="auth-switch-btn">
                    Create account
                  </button>
                </p>
              </div>
            </div>

            {/* ── REGISTER FORM ── */}
            <div className={`auth-panel form-panel ${mode === "register" ? "show" : ""}`}>
              <div className="auth-panel-inner">
                <div className="auth-panel-header">
                  <h1>Create Account</h1>
                  <p>Join DEJOIY today</p>
                </div>

                {regError && (
                  <div className="auth-error pulse" role="alert">
                    <div className="auth-error-msg">{regError}</div>
                  </div>
                )}

                {regSuccess ? (
                  <div className="reg-success">
                    <div className="reg-success-icon">✓</div>
                    <h3>Account created!</h3>
                    <p>Check your email for a verification link.</p>
                    <button className="link-btn" onClick={() => switchMode("login")}>
                      ← Back to sign-in
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleRegister}>
                    <SecureInput
                      label="Full name"
                      name="regName"
                      autoComplete="name"
                      placeholder="John Doe"
                      value={regName}
                      onChange={(e) => setRegName(e.target.value)}
                      required
                    />
                    <SecureInput
                      label="Email address"
                      name="regEmail"
                      type="email"
                      autoComplete="email"
                      placeholder="you@dejoiy.com"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      required
                    />
                    <SecureInput
                      label="Password"
                      name="regPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder="14+ characters"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      toggle
                      required
                    />
                    <PasswordStrength password={regPassword} />
                    <SecureInput
                      label="Confirm password"
                      name="regConfirm"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Repeat password"
                      value={regConfirm}
                      onChange={(e) => setRegConfirm(e.target.value)}
                      required
                    />
                    <AuthButton loading={regLoading} type="submit">
                      {regLoading ? "Creating account" : "Create Account"}
                    </AuthButton>
                  </form>
                )}

                <p className="auth-switch">
                  Already have an account?{" "}
                  <button type="button" onClick={() => switchMode("login")} className="auth-switch-btn">
                    Sign in
                  </button>
                </p>
              </div>
            </div>
          </div>

          {/* ── VISUAL / WELCOME PANEL ── */}
          <div className="auth-visual-col">
            <div className="visual-content">
              {/* Orbital rings */}
              <div className="visual-rings" aria-hidden="true">
                <div className="v-ring v-ring-1" />
                <div className="v-ring v-ring-2" />
                <div className="v-ring v-ring-3" />
              </div>

              {/* DEJOIY full brand logo */}
              <img src="/brand/dejoiy-auth-logo.png" alt="DEJOIY AUTH" className="visual-logo" />

              {/* Identity network nodes */}
              <div className="visual-nodes" aria-hidden="true">
                <span className="v-node v-node-1" />
                <span className="v-node v-node-2" />
                <span className="v-node v-node-3" />
                <span className="v-node v-node-4" />
                <span className="v-node v-node-5" />
                <span className="v-node v-node-6" />
                <svg className="v-lines" viewBox="0 0 260 160" fill="none">
                  <line x1="130" y1="80" x2="40" y2="30" stroke="rgba(0,229,255,0.12)" strokeWidth="0.8"/>
                  <line x1="130" y1="80" x2="220" y2="30" stroke="rgba(0,229,255,0.12)" strokeWidth="0.8"/>
                  <line x1="130" y1="80" x2="20" y2="120" stroke="rgba(212,175,55,0.1)" strokeWidth="0.8"/>
                  <line x1="130" y1="80" x2="240" y2="120" stroke="rgba(212,175,55,0.1)" strokeWidth="0.8"/>
                  <line x1="130" y1="80" x2="130" y2="145" stroke="rgba(0,229,255,0.08)" strokeWidth="0.8"/>
                  <line x1="130" y1="80" x2="60" y2="80" stroke="rgba(0,229,255,0.06)" strokeWidth="0.5" strokeDasharray="3 3"/>
                  <line x1="130" y1="80" x2="200" y2="80" stroke="rgba(0,229,255,0.06)" strokeWidth="0.5" strokeDasharray="3 3"/>
                </svg>
              </div>

              {/* Text — different for login vs register */}
              <div className={`visual-text ${mode === "login" ? "show" : ""}`}>
                <h2>Secure your<br />DEJOIY identity.</h2>
                <p>Enterprise-grade authentication<br />powering the DEJOIY ecosystem.</p>
              </div>
              <div className={`visual-text ${mode === "register" ? "show" : ""}`}>
                <h2>Welcome to<br />DEJOIY.</h2>
                <p>Create your secure identity<br />and join the platform.</p>
                <button type="button" onClick={() => switchMode("login")} className="visual-cta">
                  LOGIN
                </button>
              </div>

              {/* Security status */}
              <div className="visual-status">
                <span className="status-dot" />
                <span>IDENTITY PROTECTED</span>
              </div>

              {/* Decorative elements */}
              <div className="visual-grid" aria-hidden="true" />
              <div className="visual-glow" aria-hidden="true" />
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="auth-footer">
          <span className="auth-footer-dot" />
          <span>Secure &amp; Encrypted</span>
        </div>
      </div>
    </div>
  );
}
