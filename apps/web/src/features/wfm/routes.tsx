import { Route, Routes } from "react-router-dom";
import { AppShell, type NavItem } from "../../components/AppShell";
import { EmployeesPage } from "./Employees";
import { ActivationQueuePage } from "./ActivationQueue";

const NAV: NavItem[] = [
  { to: "/wfm", label: "Employees", end: true, permission: "wfm.employee.manage" },
  { to: "/wfm/activation-queue", label: "Activation queue", permission: "wfm.employee.manage" }
];

export function WfmRoutes() {
  return (
    <AppShell panel="WFM" title="DEJOIY AUTH WFM" nav={NAV}>
      <Routes>
        <Route index element={<EmployeesPage />} />
        <Route path="activation-queue" element={<ActivationQueuePage />} />
      </Routes>
    </AppShell>
  );
}
