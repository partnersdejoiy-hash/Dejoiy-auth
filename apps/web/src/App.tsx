import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth, type AuthUser } from "./lib/auth";
import { LoadingScreen, ErrorScreen } from "./components/ui";
import { LoginPage } from "./features/auth/Login";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./features/auth/recovery";
import { NotFoundPage } from "./pages/NotFound";
import { AdminRoutes } from "./features/admin/routes";
import { ItRoutes } from "./features/it/routes";
import { WfmRoutes } from "./features/wfm/routes";

/** Role → primary console. Falls back to /admin for privileged roles. */
export function homeFor(user: AuthUser | null): string {
  if (!user) return "/login";
  if (user.roles.includes("IT_ADMIN")) return "/it";
  if (user.roles.includes("WFM_MANAGER") || user.roles.includes("WFM_AGENT")) return "/wfm";
  return "/admin";
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Protected panel route: authenticated + at least one matching role. */
function RequirePanel({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.roles.some((r) => roles.includes(r))) {
    return (
      <ErrorScreen
        title="ACCESS DENIED"
        message="Your role does not permit access to this console. Contact DEJOIY IT if you believe this is a mistake."
      />
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      <Route
        path="/admin/*"
        element={
          <RequirePanel roles={["SUPER_ADMIN", "IT_ADMIN", "ADMIN", "MANAGEMENT", "SECURITY_ADMIN", "AUDITOR"]}>
            <AdminRoutes base="/admin" />
          </RequirePanel>
        }
      />
      <Route
        path="/app/*"
        element={
          <RequireAuth>
            <AdminRoutes base="/app" />
          </RequireAuth>
        }
      />
      <Route
        path="/it/*"
        element={
          <RequirePanel roles={["IT_ADMIN", "SUPER_ADMIN", "SECURITY_ADMIN"]}>
            <ItRoutes />
          </RequirePanel>
        }
      />
      <Route
        path="/wfm/*"
        element={
          <RequirePanel roles={["WFM_MANAGER", "WFM_AGENT", "SUPER_ADMIN", "IT_ADMIN", "MANAGEMENT"]}>
            <WfmRoutes />
          </RequirePanel>
        }
      />

      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  return <Navigate to={homeFor(user)} replace />;
}
