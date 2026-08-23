import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode
} from "react";
import { api, setTokens } from "./api";

export interface AuthUser {
  id: string;
  userNumber: string;
  email: string | null;
  fullName: string | null;
  roles: string[];
  permissions: string[];
  mfaRequired: boolean;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  mfaChallenge?: { factorId: string; challenge: string; expiresIn: number };
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<LoginResult>;
  verifyMfa: (identifier: string, code: string, challenge: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  isSuperAdmin: () => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(async () => {
    try {
      const me = await api.get<AuthUser>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const login = useCallback(async (identifier: string, password: string) => {
    const result = await api.post<LoginResult>("/auth/login", { identifier, password });
    if (result.accessToken) {
      setTokens(result.accessToken, result.refreshToken);
      setUser(result.user);
    }
    return result;
  }, []);

  const verifyMfa = useCallback(async (identifier: string, code: string, challenge: string) => {
    const result = await api.post<LoginResult>("/auth/mfa/verify", { identifier, code, challenge });
    setTokens(result.accessToken, result.refreshToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* session may already be gone */
    }
    setTokens(null, null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    login,
    verifyMfa,
    logout,
    hasPermission: (p) => user?.permissions.includes(p) ?? false,
    isSuperAdmin: () => user?.roles.includes("SUPER_ADMIN") ?? false
  }), [user, loading, login, verifyMfa, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
