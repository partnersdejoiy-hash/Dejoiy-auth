import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { MiniButton } from "./ui";
import "./AppShell.css";

export interface NavItem {
  to: string;
  label: string;
  permission?: string;
  end?: boolean;
}

export function AppShell({
  panel, title, nav, children
}: {
  panel: "ADMIN" | "IT" | "WFM";
  title: string;
  nav: NavItem[];
  children: ReactNode;
}) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const visibleNav = nav.filter((n) => !n.permission || hasPermission(n.permission));

  const onLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-brand">
          <img src="/brand/dejoiy-auth-mark.svg" alt="DEJOIY AUTH" width="34" height="34" />
          <div>
            <div className="brand-name">DEJOIY</div>
            <div className="brand-panel">{panel}</div>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label={`${panel} navigation`}>
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="flex" style={{ minWidth: 0 }}>
            <div className="avatar">{user?.fullName?.slice(0, 1) ?? "?"}</div>
            <div style={{ minWidth: 0 }}>
              <div className="user-name">{user?.fullName ?? "User"}</div>
              <div className="user-sub mono">{user?.userNumber}</div>
            </div>
          </div>
          <MiniButton onClick={onLogout}>Sign out</MiniButton>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle menu">☰</button>
          <div className="topbar-title">{title}</div>
          <div className="spacer" />
          <span className="security-chip">
            <span className="chip-dot" /> SECURE CHANNEL
          </span>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
