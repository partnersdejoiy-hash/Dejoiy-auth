import { useEffect, useRef, useState, useCallback } from "react";
import "./otp-verification.css";

/**
 * DEJOIY OTP Verification
 * 4-digit code input → circular orbit verification → confetti success
 * Adapted from the Hyper Process Circulation Engine reference.
 */
interface OtpVerificationProps {
  onComplete: (code: string) => void;
  onBack: () => void;
}

export function OtpVerification({ onComplete, onBack }: OtpVerificationProps) {
  const [digits, setDigits] = useState(["", "", "", ""]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [phase, setPhase] = useState<"input" | "verifying" | "success">("input");
  const [resendTimer, setResendTimer] = useState(30);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Resend countdown
  useEffect(() => {
    if (resendTimer <= 0) return;
    const t = setInterval(() => setResendTimer((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendTimer]);

  // Focus first input
  useEffect(() => {
    const t = setTimeout(() => {
      inputRefs.current[0]?.focus();
    }, 300);
    return () => clearTimeout(t);
  }, []);

  const checkComplete = useCallback((d: string[]) => {
    if (d.every((x) => x.length === 1)) {
      const code = d.join("");
      setPhase("verifying");
      setTimeout(() => {
        setPhase("success");
        // Fire sound
        playSuccessSound();
        // Launch confetti
        launchConfetti();
        // After success animation, call onComplete
        setTimeout(() => onComplete(code), 2200);
      }, 3200);
    }
  }, [onComplete]);

  const handleChange = (index: number, value: string) => {
    if (phase !== "input") return;
    const clean = value.replace(/\D/g, "").slice(0, 1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);

    if (clean && index < 3) {
      setActiveIndex(index + 1);
      inputRefs.current[index + 1]?.focus();
      inputRefs.current[index + 1]?.removeAttribute("disabled");
    } else if (clean && index === 3) {
      setActiveIndex(index);
    }

    if (!clean && index < 3) {
      for (let i = index + 1; i < 4; i++) {
        next[i] = "";
      }
      setDigits(next);
    }

    checkComplete(next);
  };

  const handleKeyDown = (index: number, key: string) => {
    if (phase !== "input") return;
    if (key === "Backspace" && !digits[index] && index > 0) {
      const prev = index - 1;
      const next = [...digits];
      next[prev] = "";
      setDigits(next);
      setActiveIndex(prev);
      inputRefs.current[prev]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    if (phase !== "input") return;
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4);
    if (!pasted) return;
    const next = [...digits];
    for (let i = 0; i < pasted.length && i < 4; i++) {
      next[i] = pasted[i] ?? "";
    }
    setDigits(next);
    const lastIdx = Math.min(pasted.length, 4) - 1;
    setActiveIndex(lastIdx);
    inputRefs.current[lastIdx]?.focus();
    checkComplete(next);
  };

  const handleResend = () => {
    if (resendTimer > 0) return;
    setResendTimer(30);
    setDigits(["", "", "", ""]);
    setActiveIndex(0);
    setPhase("input");
    inputRefs.current[0]?.focus();
  };

  const displayDigits = phase === "verifying" ? digits : digits;

  return (
    <div className="otp-page">
      <div className="otp-card" style={{ animation: "card-enter 0.7s cubic-bezier(0.22, 1, 0.36, 1) both" }}>
        {/* Header */}
        <div className="otp-header">
          <button className="otp-back-btn" onClick={onBack} aria-label="Go back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="otp-brand">
            <img src="/brand/dejoiy-auth-mark.svg" alt="DEJOIY" width="38" height="38" />
          </div>
          <div className="otp-header-text">
            <h1>Verify your identity</h1>
            <p>We've sent a 4-digit code to your device</p>
          </div>
        </div>

        {/* Stage area */}
        <div className="otp-stage">
          {/* Phase 1: Input cells */}
          <div className={`otp-inputs ${phase !== "input" ? "hidden" : ""}`}>
            {digits.map((d, i) => (
              <div
                key={i}
                className={`otp-cell ${i === activeIndex && !d ? "active" : ""} ${d ? "filled" : ""}`}
                onClick={() => {
                  if (phase === "input" && !inputRefs.current[i]?.disabled) {
                    inputRefs.current[i]?.focus();
                    setActiveIndex(i);
                  }
                }}
              >
                <div className="cell-glow" />
                <input
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={1}
                  autoComplete="one-time-code"
                  value={d}
                  disabled={i > 0 && !digits[i - 1] && phase === "input"}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e.key)}
                  onPaste={handlePaste}
                  aria-label={`Digit ${i + 1}`}
                />
                <div className="cursor-line" />
              </div>
            ))}
          </div>

          {/* Phase 2: Orbit verification */}
          <div className={`otp-orbit ${phase === "verifying" ? "active" : ""} ${phase === "success" ? "active is-success" : ""}`}>
            {/* Track rings */}
            <div className="orbit-track orbit-track-outer" />
            <div className="orbit-track orbit-track-inner" />

            {/* Spinner with digit cards */}
            <div className="orbit-spinner">
              {displayDigits.map((d, i) => (
                <div key={i} className={`orbit-card orbit-pos-${i + 1}`}>
                  <span className="oc-glow" />
                  <span className="oc-shine" />
                  <span className="oc-digit">{d || "·"}</span>
                </div>
              ))}
            </div>

            {/* Center check */}
            <div className="orbit-check">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>

        {/* Status text */}
        <div className="otp-status">
          {phase === "verifying" && (
            <div className="otp-status-row">
              <div className="otp-spinner-sm" />
              <span>Verifying your identity…</span>
            </div>
          )}
          {phase === "success" && (
            <div className="otp-status-row success">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>Verified successfully!</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="otp-footer">
          {phase === "input" && (
            <>
              <p className="otp-resend">
                {resendTimer > 0 ? (
                  <>Resend code in <strong>{resendTimer}s</strong></>
                ) : (
                  <button className="otp-resend-btn" onClick={handleResend}>
                    Resend code
                  </button>
                )}
              </p>
              <div className="otp-secure">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Verified and Secure</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Confetti canvas */}
      <canvas id="otp-confetti-canvas" />
    </div>
  );
}

/* ---- Sound helpers ---- */
function playSuccessSound() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    const notes = [
      { freq: 523.25, start: 0, dur: 0.12, vol: 0.10 },
      { freq: 659.25, start: 0.08, dur: 0.12, vol: 0.12 },
      { freq: 783.99, start: 0.16, dur: 0.15, vol: 0.14 },
      { freq: 1046.50, start: 0.24, dur: 0.8, vol: 0.16 },
    ];
    notes.forEach((n) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(n.freq, t + n.start);
      g.gain.setValueAtTime(n.vol, t + n.start);
      g.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
      o.connect(g).connect(ctx.destination);
      o.start(t + n.start);
      o.stop(t + n.start + n.dur);
    });
  } catch {
    /* ignore */
  }
}

/* ---- Confetti ---- */
function launchConfetti() {
  const canvasEl = document.getElementById("otp-confetti-canvas") as HTMLCanvasElement | null;
  if (!canvasEl) return;
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
  const ctx2d = canvasEl.getContext("2d");
  if (!ctx2d) return;
  // Capture non-null references for the closure
  const cvs = canvasEl;
  const ctx = ctx2d;

  const colors = ["#00e5ff", "#0099ff", "#6a5bff", "#ff2dad", "#22c55e", "#f5b544"];
  const particles: {
    x: number; y: number; vx: number; vy: number;
    life: number; decay: number; size: number; color: string;
    rot: number; rotSpd: number; isRect: boolean;
  }[] = [];

  const cx = cvs.width / 2;
  const cy = cvs.height / 2;
  for (let i = 0; i < 65; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 8;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      life: 1,
      decay: 0.007 + Math.random() * 0.008,
      size: 4 + Math.random() * 5,
      color: colors[Math.floor(Math.random() * colors.length)] ?? "#00e5ff",
      rot: Math.random() * 360,
      rotSpd: (Math.random() - 0.5) * 10,
      isRect: Math.random() > 0.3,
    });
  }

  function animate() {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.rot += p.rotSpd;
      p.life -= p.decay;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.min(p.life, 1);
      ctx.fillStyle = p.color;
      if (p.isRect) {
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillRect(-p.size / 2, -p.size * 0.4, p.size, p.size * 0.7);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (particles.length > 0) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, cvs.width, cvs.height);
  }
  animate();
}
