import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { homeFor } from "../App";
import "./notfound.css";

/**
 * 404 — Animated caveman character
 * idle → spark → shock → fall → sit (loops)
 * Based on the Hyper Process 404 reference.
 */
export function NotFoundPage() {
  const { user } = useAuth();
  const [scene, setScene] = useState<"idle" | "spark" | "shock" | "fall" | "sit">("idle");
  const [zap, setZap] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const stages: { cls: typeof scene; dur: number }[] = [
      { cls: "idle", dur: 2200 },
      { cls: "spark", dur: 180 },
      { cls: "shock", dur: 1500 },
      { cls: "fall", dur: 500 },
      { cls: "sit", dur: 2800 },
    ];

    let idx = 0;

    function next() {
      const s = stages[idx]!;
      setScene(s.cls);
      setZap(s.cls === "shock" || s.cls === "spark");
      idx = (idx + 1) % stages.length;
      timerRef.current.push(setTimeout(next, s.dur));
    }

    timerRef.current.push(setTimeout(next, 100));

    return () => {
      timerRef.current.forEach(clearTimeout);
      timerRef.current = [];
    };
  }, []);

  return (
    <div className="notfound">
      <div className="notfound-card">
        <h1 className={`nf-title ${zap ? "zap" : ""}`}>404</h1>

        <div className="scene-wrap">
          <svg className={`scene ${scene}`} viewBox="0 0 400 240" xmlns="http://www.w3.org/2000/svg">

            {/* ground line */}
            <line x1="15" y1="207" x2="385" y2="207" stroke="#e7e7e4" strokeWidth="2" />

            {/* left inukshuk */}
            <g>
              <path d="M45 207 L52 158 L74 158 L81 207 Z" fill="#dcdcda" />
              <rect x="40" y="140" width="46" height="15" rx="7" fill="#dcdcda" />
              <circle cx="63" cy="122" r="13" fill="#dcdcda" />
            </g>

            {/* right rock */}
            <path d="M305 207 C303 150 312 95 340 88 C368 95 377 150 375 207 Z" fill="#cfcfcd" />

            {/* bushes */}
            <g fill="#37ab3a">
              <ellipse cx="30" cy="203" rx="17" ry="11" />
              <ellipse cx="15" cy="207" rx="12" ry="8" fill="#2c8f2f" />
              <ellipse cx="103" cy="204" rx="14" ry="9" />
              <ellipse cx="290" cy="204" rx="13" ry="9" />
              <ellipse cx="386" cy="203" rx="16" ry="10" />
            </g>

            {/* ===== WIRES ===== */}
            <path
              className="wire wire-idle"
              d="M63 207 Q120 207 150 207 Q170 207 172 190 Q174 172 197 152 Q186 175 200 200 Q216 178 205 152 Q222 172 228 190 Q234 207 260 207 Q300 207 340 207"
              fill="none" stroke="#2b2b2b" strokeWidth="3" strokeLinecap="round"
            />
            <path
              className="wire wire-loose"
              d="M63 207 Q110 207 140 207 Q160 207 175 195 Q192 183 197 172 Q170 176 165 195 Q178 210 205 200 Q224 192 240 175 Q248 165 250 155"
              fill="none" stroke="#2b2b2b" strokeWidth="3" strokeLinecap="round"
            />
            <path
              className="wire wire-taut"
              d="M63 207 L340 207" fill="none" stroke="#2b2b2b" strokeWidth="3" strokeLinecap="round"
            />

            {/* ===== IDLE POSE ===== */}
            <g className="pose idle-pose">
              {/* legs */}
              <line x1="196" y1="176" x2="188" y2="207" stroke="#f6b990" strokeWidth="10" strokeLinecap="round" />
              <line x1="204" y1="176" x2="213" y2="207" stroke="#f6b990" strokeWidth="10" strokeLinecap="round" />
              {/* back arm */}
              <line x1="212" y1="148" x2="226" y2="170" stroke="#f6b990" strokeWidth="8" strokeLinecap="round" />
              {/* torso / loincloth */}
              <path d="M186 138 Q200 128 214 138 L219 178 Q200 190 181 178 Z" fill="#eb9421" />
              <circle cx="193" cy="155" r="2.4" fill="#d97f0d" />
              <circle cx="205" cy="165" r="2.4" fill="#d97f0d" />
              <circle cx="197" cy="172" r="2" fill="#d97f0d" />
              {/* front arm holding wire */}
              <path d="M188 145 Q178 132 192 122" fill="none" stroke="#f6b990" strokeWidth="8" strokeLinecap="round" />
              {/* head */}
              <circle cx="199" cy="115" r="17" fill="#f6b990" />
              {/* ears */}
              <circle cx="183" cy="116" r="4" fill="#f6b990" />
              <circle cx="215" cy="116" r="4" fill="#f6b990" />
              {/* hair */}
              <path d="M181 108 Q184 90 199 89 Q214 90 217 108 Q210 100 199 100 Q188 100 181 108 Z" fill="#4a2a12" />
              {/* beard */}
              <path d="M184 113 Q182 134 199 138 Q216 134 214 113 Q214 128 199 130 Q184 128 184 113 Z" fill="#4a2a12" />
              {/* cheek */}
              <circle cx="188" cy="118" r="3.2" fill="#f29a8e" opacity=".8" />
              {/* eye */}
              <path d="M191 110 q3 -2 6 0" stroke="#33251a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              {/* mouth holding wire end */}
              <circle cx="205" cy="118" r="2.3" fill="#33251a" />
            </g>

            {/* ===== SHOCK / FALL POSE ===== */}
            <g className="pose shock-pose">
              <g className="glow-burst">
                <circle cx="200" cy="175" r="46" fill="#ffe27a" opacity=".45" />
                <circle cx="200" cy="175" r="30" fill="#fff3b0" opacity=".55" />
                <g stroke="#ffce3a" strokeWidth="2.5" strokeLinecap="round" opacity=".9">
                  <line x1="200" y1="120" x2="200" y2="105" />
                  <line x1="160" y1="140" x2="148" y2="128" />
                  <line x1="240" y1="140" x2="252" y2="128" />
                  <line x1="150" y1="180" x2="134" y2="180" />
                  <line x1="250" y1="180" x2="266" y2="180" />
                  <line x1="165" y1="215" x2="155" y2="228" />
                  <line x1="235" y1="215" x2="245" y2="228" />
                </g>
              </g>

              {/* legs splayed */}
              <line x1="200" y1="170" x2="168" y2="205" stroke="#f6b990" strokeWidth="10" strokeLinecap="round" />
              <line x1="200" y1="170" x2="232" y2="205" stroke="#f6b990" strokeWidth="10" strokeLinecap="round" />
              {/* arms splayed */}
              <line x1="200" y1="150" x2="160" y2="130" stroke="#f6b990" strokeWidth="8" strokeLinecap="round" />
              <line x1="200" y1="150" x2="240" y2="130" stroke="#f6b990" strokeWidth="8" strokeLinecap="round" />
              {/* torso */}
              <path d="M184 140 Q200 130 216 140 L214 172 Q200 180 186 172 Z" fill="#eb9421" />

              {/* x-ray skeleton overlay */}
              <g className="skeleton" stroke="#7a4a2e" strokeWidth="1.6" fill="none">
                <line x1="200" y1="140" x2="200" y2="172" />
                <path d="M191 148 Q200 152 209 148" />
                <path d="M190 156 Q200 160 210 156" />
                <path d="M191 164 Q200 168 209 164" />
              </g>

              {/* head */}
              <circle cx="200" cy="118" r="17" fill="#f6b990" />
              <circle cx="184" cy="119" r="4" fill="#f6b990" />
              <circle cx="216" cy="119" r="4" fill="#f6b990" />
              {/* hair standing up */}
              <path d="M182 110 Q178 88 190 82 Q186 96 191 100 M199 108 Q199 82 199 78 Q199 92 202 100 M217 110 Q222 88 210 82 Q214 96 209 100"
                stroke="#4a2a12" strokeWidth="4" fill="none" strokeLinecap="round" />
              <path d="M185 116 Q183 137 200 141 Q217 137 215 116 Q215 131 200 133 Q185 131 185 116 Z" fill="#4a2a12" />
              {/* shocked eyes */}
              <path d="M189 112 L195 116 M195 112 L189 116" stroke="#33251a" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M205 112 L211 116 M211 112 L205 116" stroke="#33251a" strokeWidth="1.6" strokeLinecap="round" />
              <ellipse cx="200" cy="124" rx="3" ry="4" fill="#33251a" />
            </g>

            {/* ===== SIT / DAZED POSE ===== */}
            <g className="pose sit-pose">
              {/* legs crossed sitting */}
              <path d="M182 207 Q182 188 200 188 Q218 188 218 207" fill="none" stroke="#f6b990" strokeWidth="10" strokeLinecap="round" />
              {/* arms resting */}
              <path d="M183 175 Q176 190 186 200" fill="none" stroke="#f6b990" strokeWidth="7" strokeLinecap="round" />
              <path d="M217 175 Q224 190 214 200" fill="none" stroke="#f6b990" strokeWidth="7" strokeLinecap="round" />
              {/* torso */}
              <path d="M186 152 Q200 143 214 152 L217 182 Q200 191 183 182 Z" fill="#eb9421" />
              <circle cx="193" cy="163" r="2.2" fill="#d97f0d" />
              <circle cx="206" cy="170" r="2.2" fill="#d97f0d" />
              {/* head */}
              <circle cx="200" cy="128" r="17" fill="#f6b990" />
              <circle cx="184" cy="129" r="4" fill="#f6b990" />
              <circle cx="216" cy="129" r="4" fill="#f6b990" />
              <path d="M182 121 Q185 103 200 102 Q215 103 218 121 Q211 113 200 113 Q189 113 182 121 Z" fill="#4a2a12" />
              <path d="M185 126 Q183 147 200 151 Q217 147 215 126 Q215 141 200 143 Q185 141 185 126 Z" fill="#4a2a12" />
              {/* flushed cheeks */}
              <circle cx="186" cy="131" r="4.2" fill="#f29a8e" opacity=".85" />
              <circle cx="214" cy="131" r="4.2" fill="#f29a8e" opacity=".85" />
              {/* dazed eyes */}
              <path d="M192 124 q2.5 2 5 0" stroke="#33251a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              <path d="M203 124 q2.5 2 5 0" stroke="#33251a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            </g>

            {/* spark burst at wire bite point */}
            <g className="spark-mark">
              <path d="M205 112 l6 -4 -3 6 6 -1 -8 8 2 -7 -6 2 z" fill="#ffd23c" />
            </g>

          </svg>
        </div>

        <h2 className="nf-subtitle">Look like you're lost</h2>
        <p className="nf-desc">The page you are looking for is not available or has been moved.</p>

        <div className="nf-actions">
          {user ? (
            <Link to={homeFor(user)} className="nf-btn-primary">Go back home</Link>
          ) : (
            <Link to="/login" className="nf-btn-primary">Go back home</Link>
          )}
          <button className="nf-btn-ghost" onClick={() => window.history.back()}>Go back</button>
        </div>
      </div>
    </div>
  );
}
