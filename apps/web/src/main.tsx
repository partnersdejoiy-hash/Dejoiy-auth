import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import "./styles/theme.css";
import "./styles/base.css";
import "./components/ui.css";
import "./components/panels.css";
import "./components/AppShell.css";
import "./features/auth/login.css";
import "./features/auth/recovery.css";
import "./pages/notfound.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
