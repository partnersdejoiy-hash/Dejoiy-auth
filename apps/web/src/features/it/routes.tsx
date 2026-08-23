import { Route, Routes } from "react-router-dom";
import { AppShell, type NavItem } from "../../components/AppShell";
import { ItDashboard } from "./ItDashboard";
import { IncidentsPage } from "./Incidents";
import { NotificationsPage } from "./Notifications";

const NAV: NavItem[] = [
  { to: "/it", label: "Operations", end: true, permission: "system.config.read" },
  { to: "/it/incidents", label: "Security incidents", permission: "security.read" },
  { to: "/it/notifications", label: "Email delivery", permission: "notification.read" }
];

export function ItRoutes() {
  return (
    <AppShell panel="IT" title="DEJOIY AUTH IT" nav={NAV}>
      <Routes>
        <Route index element={<ItDashboard />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
      </Routes>
    </AppShell>
  );
}
