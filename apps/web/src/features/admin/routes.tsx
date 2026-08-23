import { Route, Routes } from "react-router-dom";
import { AppShell, type NavItem } from "../../components/AppShell";
import { AdminDashboard } from "./Dashboard";
import { UsersPage } from "./Users";
import { UserDetailPage } from "./UserDetail";
import { RolesPage } from "./Roles";
import { ApplicationsPage } from "./Applications";
import { SecurityPage } from "./Security";
import { SettingsPage } from "./Settings";

const NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", end: true },
  { to: "/app/users", label: "Users", permission: "user.read" },
  { to: "/app/roles", label: "Roles & Permissions", permission: "role.read" },
  { to: "/app/applications", label: "Applications", permission: "application.read" },
  { to: "/app/security", label: "Security", permission: "security.read" },
  { to: "/app/settings", label: "System", permission: "system.config.read" }
];

export function AdminRoutes() {
  return (
    <AppShell panel="ADMIN" title="DEJOIY AUTH ADMIN" nav={NAV}>
      <Routes>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:id" element={<UserDetailPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}
