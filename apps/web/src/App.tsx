import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { LoadingScreen } from "./components/ui";
import { LoginPage } from "./features/auth/Login";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./features/auth/recovery";
import { NotFoundPage } from "./pages/NotFound";
import { AdminRoutes } from "./features/admin/routes";
import { ItRoutes } from "./features/it/routes";
import { WfmRoutes } from "./features/wfm/routes";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      <Route path="/app/*" element={<RequireAuth><AdminRoutes /></RequireAuth>} />
      <Route path="/it/*" element={<RequireAuth><ItRoutes /></RequireAuth>} />
      <Route path="/wfm/*" element={<RequireAuth><WfmRoutes /></RequireAuth>} />

      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
