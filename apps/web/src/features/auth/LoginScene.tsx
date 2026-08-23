import { useEffect, useRef, useState } from "react";

/**
 * "DEJOIY SECURE HANDSHAKE" — cinematic login backdrop.
 *
 * Sequence: dark screen → particles drift in → DEJOIY mark assembles from
 * particles → rotating electric ring + scan → telemetry labels →
 * "SECURE CHANNEL ESTABLISHED" → scene settles and the glass card rises.
 *
 * Performance: single canvas, ~600 particles, target sampling from an
 * offscreen raster of the logo mark. Respects prefers-reduced-motion.
 */

interface Particle {
  x: number; y: number;
  tx: number; ty: number;
  vx: number; vy: number;
  size: number;
  hue: number;
  phase: number;
}

const TARGET_PARTICLES = 520;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LoginScene({ onEstablished }: { onEstablished?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"intro" | "forming" | "scan" | "established">("intro");
  const phaseRef = useRef<"intro" | "forming" | "scan" | "established">("intro");
  const establishedRef = useRef(false);
  const reduced = prefersReducedMotion();

  // Keep a ref in sync so the rAF loop never reads stale state.
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const ctxEl = canvasEl.getContext("2d");
    if (!ctxEl) return;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = ctxEl;

    let raf = 0;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let logoMask: { x: number; y: number }[] = [];
    let establishedAt = 0;
    let scanY = -80;
    let timers: ReturnType<typeof setTimeout>[] = [];

    // Rasterize the brand mark into target points.
    function buildLogoMask() {
      const size = Math.min(width, height) * 0.34;
      const off = document.createElement("canvas");
      off.width = off.height = Math.max(2, Math.floor(size));
      const octx = off.getContext("2d");
      if (!octx) return;
      const img = new Image();
      img.src = "/brand/dejoiy-auth-mark.svg";
      img.onload = () => {
        octx.drawImage(img, 0, 0, off.width, off.height);
        const data = octx.getImageData(0, 0, off.width, off.height).data;
        const pts: { x: number; y: number }[] = [];
        for (let y = 0; y < off.height; y += 3) {
          for (let x = 0; x < off.width; x += 3) {
            const alpha = data[(y * off.width + x) * 4 + 3] ?? 0;
            if (alpha > 90) pts.push({ x, y });
          }
        }
        // Sample down to target count with jitter.
        logoMask = [];
        const step = Math.max(1, Math.floor(pts.length / TARGET_PARTICLES));
        for (let i = 0; i < pts.length; i += step) {
          const p = pts[i]!;
          logoMask.push({
            x: width / 2 - off.width / 2 + p.x + (Math.random() * 4 - 2),
            y: height / 2 - off.height / 2 + p.y + (Math.random() * 4 - 2)
          });
        }
      };
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildLogoMask();
    }

    function initParticles() {
      particles = [];
      const count = reduced ? 140 : TARGET_PARTICLES;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          tx: width / 2 + (Math.random() - 0.5) * width,
          ty: height / 2 + (Math.random() - 0.5) * height,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          size: 0.8 + Math.random() * 1.8,
          hue: 175 + Math.random() * 60, // cyan→blue
          phase: Math.random() * Math.PI * 2
        });
      }
    }

    function draw(t: number) {
      ctx.clearRect(0, 0, width, height);
      const now = performance.now();

      // Subtle grid backdrop
      ctx.strokeStyle = "rgba(0, 229, 255, 0.05)";
      ctx.lineWidth = 1;
      const gs = 54;
      ctx.beginPath();
      for (let x = 0; x < width; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y < height; y += gs) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();

      // Particle behavior
      for (const p of particles) {
        const hasMask = logoMask.length > 0;
        if (hasMask) {
          const target = logoMask[Math.floor(Math.random() * logoMask.length)]!;
          p.tx = target.x + (Math.random() * 1.6 - 0.8);
          p.ty = target.y + (Math.random() * 1.6 - 0.8);
          const ease = phaseRef.current === "established" ? 0.05 : 0.024;
          p.x += (p.tx - p.x) * ease;
          p.y += (p.ty - p.y) * ease;
        } else {
          p.x += p.vx + Math.sin(t * 0.0006 + p.phase) * 0.14;
          p.y += p.vy + Math.cos(t * 0.0005 + p.phase) * 0.14;
          if (p.x < 0) p.x = width;
          if (p.x > width) p.x = 0;
          if (p.y < 0) p.y = height;
          if (p.y > height) p.y = 0;
        }

        const glow = hasMask;
        ctx.fillStyle = glow
          ? `hsla(${p.hue}, 100%, 62%, 0.85)`
          : `hsla(${p.hue}, 100%, 60%, 0.35)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      const cur = phaseRef.current;
      // Electric rotating ring around the emblem
      if (cur !== "intro") {
        const cx = width / 2;
        const cy = height / 2;
        const r = Math.min(width, height) * 0.24;
        const grad = ctx.createConicGradient(t * 0.0006, cx, cy);
        grad.addColorStop(0, "rgba(0,229,255,0)");
        grad.addColorStop(0.25, "rgba(0,229,255,0.9)");
        grad.addColorStop(0.5, "rgba(106,91,255,0.95)");
        grad.addColorStop(0.75, "rgba(255,45,173,0.55)");
        grad.addColorStop(1, "rgba(0,229,255,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Scan line sweeping down across the emblem
        if (cur === "scan" || cur === "established") {
          scanY = cy - r + ((t * 0.09) % (r * 2));
          const sg = ctx.createLinearGradient(0, scanY - 26, 0, scanY);
          sg.addColorStop(0, "rgba(0,229,255,0)");
          sg.addColorStop(1, "rgba(0,229,255,0.55)");
          ctx.fillStyle = sg;
          ctx.fillRect(cx - r - 8, scanY - 26, r * 2 + 16, 26);
          ctx.fillStyle = "rgba(0,229,255,0.9)";
          ctx.fillRect(cx - r - 8, scanY - 1, r * 2 + 16, 1.5);
        }
      }

      // "SECURE CHANNEL ESTABLISHED" flash
      if (cur === "established" && now - establishedAt < 1600) {
        ctx.fillStyle = "rgba(0, 229, 255, 0.08)";
        ctx.fillRect(0, 0, width, height);
      }

      raf = requestAnimationFrame(draw);
    }

    const advance = (next: "intro" | "forming" | "scan" | "established", settle = false) => {
      setPhase(next);
      phaseRef.current = next;
      if (next === "established") establishedAt = performance.now();
      if (settle && !establishedRef.current) {
        establishedRef.current = true;
        timers.push(setTimeout(() => onEstablished?.(), 900));
      }
    };

    if (reduced) {
      timers.push(setTimeout(() => advance("established", true), 300));
    } else {
      resize();
      initParticles();
      raf = requestAnimationFrame(draw);
      window.addEventListener("resize", resize);
      // Timeline driven by timeouts (independent of the rAF loop).
      // Total ≈ 4.5s + 0.9s settle → form appears ~5.4s after load.
      timers.push(setTimeout(() => advance("forming"), 900));
      timers.push(setTimeout(() => advance("scan"), 900 + 1600));
      timers.push(setTimeout(() => advance("established", true), 900 + 1600 + 2000));
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      timers.forEach((t) => clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-scene" aria-hidden="true">
      <canvas ref={canvasRef} />
      {/* Telemetry labels */}
      <div className={`telemetry telemetry-a ${phase !== "intro" ? "visible" : ""}`}>SECURE CHANNEL</div>
      <div className={`telemetry telemetry-b ${phase === "scan" || phase === "established" ? "visible" : ""}`}>IDENTITY CORE</div>
      <div className={`telemetry telemetry-c ${phase === "scan" || phase === "established" ? "visible" : ""}`}>ENCRYPTED SESSION</div>
      <div className={`established ${phase === "established" ? "show" : ""}`}>
        <span className="est-dot" /> SECURE CHANNEL ESTABLISHED
      </div>
    </div>
  );
}
