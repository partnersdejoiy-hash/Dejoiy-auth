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

    // Identity network — stable nodes for the security visualization
    interface NetworkNode {
      x: number; y: number;
      label: string;
      pulsePhase: number;
      active: boolean;
      activateAt: number;
    }
    let networkNodes: NetworkNode[] = [];
    let dataPackets: { fromIdx: number; toIdx: number; progress: number; speed: number }[] = [];

    function initNetwork() {
      const cx = width / 2;
      const cy = height / 2;
      const labels = ["ID", "AUTH", "SEC", "MFA", "RBC", "SES"];
      const angleStep = (Math.PI * 2) / labels.length;
      const radius = Math.min(width, height) * 0.28;
      networkNodes = labels.map((label, i) => ({
        x: cx + Math.cos(angleStep * i - Math.PI / 2) * radius,
        y: cy + Math.sin(angleStep * i - Math.PI / 2) * radius,
        label,
        pulsePhase: i * 0.8,
        active: false,
        activateAt: 0
      }));
    }

    function spawnDataPacket() {
      if (networkNodes.length < 2) return;
      const fromIdx = Math.floor(Math.random() * networkNodes.length);
      let toIdx = fromIdx;
      while (toIdx === fromIdx) toIdx = Math.floor(Math.random() * networkNodes.length);
      dataPackets.push({ fromIdx, toIdx, progress: 0, speed: 0.004 + Math.random() * 0.003 });
    }

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
        // Assign stable targets once — prevents per-frame jitter
        assignStableTargets();
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

    /**
     * Assign stable target positions from the loaded logo mask.
     * Each particle gets one fixed target — no re-randomization per frame.
     */
    function assignStableTargets() {
      if (logoMask.length === 0) return;
      for (let i = 0; i < particles.length; i++) {
        const target = logoMask[i % logoMask.length]!;
        particles[i]!.tx = target.x + ((i % 7) - 3) * 0.4; // tiny unique offset per particle
        particles[i]!.ty = target.y + ((i % 5) - 2) * 0.4;
      }
    }

    let packetTimer = 0;

    function draw(t: number) {
      ctx.clearRect(0, 0, width, height);
      const now = performance.now();
      const cur = phaseRef.current;

      // Subtle grid backdrop
      ctx.strokeStyle = "rgba(0, 229, 255, 0.04)";
      ctx.lineWidth = 1;
      const gs = 54;
      ctx.beginPath();
      for (let x = 0; x < width; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y < height; y += gs) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();

      // Radial glow from center (depth layer)
      const cx = width / 2;
      const cy = height / 2;
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.4);
      rg.addColorStop(0, cur === "established" ? "rgba(0, 229, 255, 0.06)" : "rgba(0, 229, 255, 0.03)");
      rg.addColorStop(0.5, "rgba(106, 91, 255, 0.015)");
      rg.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, width, height);

      // Particle behavior
      for (const p of particles) {
        const hasMask = logoMask.length > 0;
        if (hasMask) {
          const ease = cur === "established" ? 0.06 : 0.028;
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

        // Brighter particles — more visible
        const glow = hasMask;
        ctx.fillStyle = glow
          ? `hsla(${p.hue}, 100%, 68%, 0.9)`  // brighter when forming logo
          : `hsla(${p.hue}, 100%, 60%, 0.45)`; // more visible during drift
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (glow ? 1.1 : 1), 0, Math.PI * 2);
        ctx.fill();

        // Subtle glow ring on formed particles
        if (glow && p.size > 1.5) {
          ctx.strokeStyle = `hsla(${p.hue}, 100%, 68%, 0.25)`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ── IDENTITY NETWORK ──
      if (networkNodes.length > 0 && (cur === "scan" || cur === "established")) {
        // Activate nodes sequentially
        const nodeInterval = 200;
        for (let i = 0; i < networkNodes.length; i++) {
          const node = networkNodes[i]!;
          if (!node.active && now - establishedAt > node.pulsePhase * 300) {
            node.active = true;
            node.activateAt = now;
          }
          if (!node.active) continue;

          const nodeAge = (now - node.activateAt) * 0.001;
          const pulse = 0.5 + 0.5 * Math.sin(t * 0.002 + node.pulsePhase);
          const nodeAlpha = Math.min(1, nodeAge * 2) * (0.4 + pulse * 0.6);

          // Connection lines to center
          ctx.strokeStyle = `rgba(0, 229, 255, ${nodeAlpha * 0.15})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(node.x, node.y);
          ctx.stroke();

          // Connection lines between adjacent nodes
          const nextNode = networkNodes[(i + 1) % networkNodes.length]!;
          if (nextNode.active) {
            ctx.strokeStyle = `rgba(106, 91, 255, ${nodeAlpha * 0.08})`;
            ctx.lineWidth = 0.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(nextNode.x, nextNode.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // Node glow
          const nodeGlow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, 12);
          nodeGlow.addColorStop(0, `rgba(0, 229, 255, ${nodeAlpha * 0.4})`);
          nodeGlow.addColorStop(1, "rgba(0, 229, 255, 0)");
          ctx.fillStyle = nodeGlow;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 12, 0, Math.PI * 2);
          ctx.fill();

          // Node dot
          ctx.fillStyle = `rgba(0, 229, 255, ${nodeAlpha})`;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 2.5 + pulse, 0, Math.PI * 2);
          ctx.fill();

          // Node label
          ctx.fillStyle = `rgba(0, 229, 255, ${nodeAlpha * 0.6})`;
          ctx.font = "600 8px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(node.label, node.x, node.y - 10);
        }

        // Data packets
        packetTimer += 16;
        if (packetTimer > 800 && dataPackets.length < 4) {
          spawnDataPacket();
          packetTimer = 0;
        }
        for (let i = dataPackets.length - 1; i >= 0; i--) {
          const pkt = dataPackets[i]!;
          pkt.progress += pkt.speed;
          if (pkt.progress >= 1) { dataPackets.splice(i, 1); continue; }
          const from = networkNodes[pkt.fromIdx]!;
          const to = networkNodes[pkt.toIdx]!;
          const px = from.x + (to.x - from.x) * pkt.progress;
          const py = from.y + (to.y - from.y) * pkt.progress;
          const pktAlpha = pkt.progress < 0.5 ? pkt.progress * 2 : (1 - pkt.progress) * 2;
          ctx.fillStyle = `rgba(0, 229, 255, ${pktAlpha * 0.8})`;
          ctx.beginPath();
          ctx.arc(px, py, 2, 0, Math.PI * 2);
          ctx.fill();
          // Packet trail
          ctx.strokeStyle = `rgba(0, 229, 255, ${pktAlpha * 0.3})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          const trailProgress = Math.max(0, pkt.progress - 0.06);
          ctx.lineTo(
            from.x + (to.x - from.x) * trailProgress,
            from.y + (to.y - from.y) * trailProgress
          );
          ctx.stroke();
        }
      }

      // Electric rotating ring around the emblem
      if (cur !== "intro") {
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

        // Second ring (subtle)
        const r2 = r * 1.35;
        ctx.strokeStyle = `rgba(212, 175, 55, ${cur === "established" ? 0.15 : 0.08})`;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.arc(cx, cy, r2, t * 0.0003, t * 0.0003 + Math.PI * 1.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // Scanning arc (visible, premium effect)
        if (cur === "scan" || cur === "established") {
          scanY = cy - r + ((t * 0.08) % (r * 2));
          const sg = ctx.createLinearGradient(0, scanY - 30, 0, scanY);
          sg.addColorStop(0, "rgba(0,229,255,0)");
          sg.addColorStop(1, "rgba(0,229,255,0.6)");
          ctx.fillStyle = sg;
          ctx.fillRect(cx - r - 12, scanY - 30, r * 2 + 24, 30);
          ctx.fillStyle = "rgba(0,229,255,0.95)";
          ctx.fillRect(cx - r - 12, scanY - 1, r * 2 + 24, 2);

          // Scan glow
          const scanGlow = ctx.createRadialGradient(cx, scanY, 0, cx, scanY, r);
          scanGlow.addColorStop(0, "rgba(0, 229, 255, 0.08)");
          scanGlow.addColorStop(1, "rgba(0, 229, 255, 0)");
          ctx.fillStyle = scanGlow;
          ctx.beginPath();
          ctx.arc(cx, scanY, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // "SECURE CHANNEL ESTABLISHED" flash
      if (cur === "established" && now - establishedAt < 1800) {
        const flashAlpha = 0.08 * Math.max(0, 1 - (now - establishedAt) / 1800);
        ctx.fillStyle = `rgba(0, 229, 255, ${flashAlpha})`;
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
      timers.push(setTimeout(() => {
        initNetwork();
        networkNodes.forEach(n => { n.active = true; n.activateAt = performance.now(); });
        advance("established", true);
      }, 300));
    } else {
      resize();
      initParticles();
      raf = requestAnimationFrame(draw);
      window.addEventListener("resize", resize);
      // Timeline: forming(0.9s) → scan(2.5s) → established(4.5s) + settle(0.9s)
      timers.push(setTimeout(() => advance("forming"), 900));
      timers.push(setTimeout(() => {
        initNetwork();
        advance("scan");
      }, 900 + 1600));
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
