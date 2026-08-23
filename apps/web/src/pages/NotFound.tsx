import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { homeFor } from "../App";
import "./notfound.css";

/**
 * 404 — "LOST IN THE IDENTITY GRID"
 * Floating identity nodes, a broken route path, a scanning grid and a lost
 * session marker, consistent with the DEJOIY AUTH security language.
 */
export function NotFoundPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { user } = useAuth();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let width = 0;
    let height = 0;

    interface Node {
      x: number; y: number; vx: number; vy: number; r: number; hue: number; dead: boolean;
    }
    let nodes: Node[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = Array.from({ length: 34 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: 2 + Math.random() * 3,
        hue: 175 + Math.random() * 80,
        dead: false
      }));
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = "rgba(0, 229, 255, 0.05)";
      const gs = 46;
      ctx.beginPath();
      for (let x = 0; x < width; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y < height; y += gs) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();

      // Connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130 && !a.dead && !b.dead) {
            ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 100%, 60%, ${0.16 * (1 - d / 130)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Nodes
      for (const n of nodes) {
        n.x += n.vx + Math.sin(t * 0.0005 + n.y * 0.01) * 0.2;
        n.y += n.vy + Math.cos(t * 0.0004 + n.x * 0.01) * 0.2;
        if (n.x < -20) n.x = width + 20;
        if (n.x > width + 20) n.x = -20;
        if (n.y < -20) n.y = height + 20;
        if (n.y > height + 20) n.y = -20;
        ctx.fillStyle = n.dead ? "rgba(255, 92, 122, 0.7)" : `hsla(${n.hue}, 100%, 62%, 0.6)`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.dead ? n.r + 1.5 : n.r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    if (reduced) return;
    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="notfound">
      <canvas ref={canvasRef} />
      <div className="notfound-core">
        <div className="notfound-code">404</div>
        <div className="notfound-divider" />
        <div className="notfound-msg">
          <span className="lost-marker">✕</span> Identity route not found.
        </div>
        <p className="notfound-hint">
          Your request was scanned by the identity grid and could not be routed to a known identity node.
        </p>
        <div className="reroute">
          <span className="reroute-dot" /> Re-routing…
        </div>
        <div className="notfound-actions">
          {user && (
            <Link to={homeFor(user)} className="notfound-btn">
              <span className="btn-sweep" aria-hidden /> Go to Dashboard
            </Link>
          )}
          <Link to="/login" className="notfound-btn ghost">
            <span className="btn-sweep" aria-hidden /> Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
}
