import { Route, Routes } from "react-router-dom";
import { AppShell, type NavItem } from "../../components/AppShell";
import { AdminDashboard } from "./Dashboard";
import { UsersPage } from "./Users";
import { UserDetailPage } from "./UserDetail";
import { RolesPage } from "./Roles";
import { ApplicationsPage } from "./Applications";
import { SecurityPage } from "./Security";
import { SessionsPage } from "./Sessions";
import { AuditLogsPage } from "./AuditLogs";
import { DevicesPage } from "./Devices";
import { SettingsPage } from "./Settings";

export function AdminRoutes({ base = "/admin" }: { base?: string }) {
  const nav: NavItem[] = [
    { to: base, label: "Dashboard", end: true },
    { to: `${base}/users`, label: "Users", permission: "user.read" },
    { to: `${base}/roles`, label: "Roles & Permissions", permission: "role.read" },
    { to: `${base}/sessions`, label: "Sessions", permission: "session.read" },
    { to: `${base}/devices`, label: "Devices", permission: "device.read" },
    { to: `${base}/security`, label: "Security", permission: "security.read" },
    { to: `${base}/audit-logs`, label: "Audit Logs", permission: "audit.read" },
    { to: `${base}/applications`, label: "Applications", permission: "application.read" },
    { to: `${base}/settings`, label: "System", permission: "system.config.read" }
  ];

  return (
    <AppShell panel="ADMIN" title="DEJOIY AUTH ADMIN" nav={nav}>
      <Routes>
        <Route index element={<AdminDashboard base={base} />} />
        <Route path="users" element={<UsersPage base={base} />} />
        <Route path="users/:id" element={<UserDetailPage base={base} />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}
