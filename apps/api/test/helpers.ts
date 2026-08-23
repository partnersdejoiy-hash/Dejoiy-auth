import { beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Test harness: runs against a dedicated test database (dejoiy_auth_test)
 * on the local PostgreSQL instance. Each suite gets a fresh buildServer.
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://dejoiy_auth:dev-db-password-123@localhost:5435/dejoiy_auth_test";

export async function setupTestEnv(): Promise<void> {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6381";
  process.env.ACCESS_TOKEN_SECRET = "test-access-token-secret-0123456789abcdef";
  process.env.REFRESH_TOKEN_SECRET = "test-refresh-token-secret-0123456789abcdef";
  process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-0123456789abcdef";
  process.env.COOKIE_SECRET = "test-cookie-secret";
  process.env.BOOTSTRAP_SECRET = "test-bootstrap-secret";
  process.env.BOOTSTRAP_ADMIN_EMAIL = "test.admin@dejoiy.com";
  process.env.APP_URL = "http://localhost:8096";
  process.env.OIDC_ISSUER_URL = "http://localhost:8096";
  process.env.MAIL_PROVIDER = "console";
  process.env.LOGIN_MAX_ATTEMPTS = "3";
  process.env.LOGIN_LOCKOUT_DURATION_SECONDS = "30";
  process.env.LOGIN_PROGRESSIVE_DELAY_STEP_MS = "0";
}

export let app: FastifyInstance;

export async function startServer(): Promise<void> {
  // Force fresh config + fresh DB pool per suite.
  const { loadConfig } = await import("../src/config.js");
  loadConfig(process.env);
  const { buildServer } = await import("../src/index.js");
  app = await buildServer({ autoMigrate: false });
  await app.ready();
}

export async function stopServer(): Promise<void> {
  if (app) await app.close();
}

export async function resetDatabase(): Promise<void> {
  const { getPool } = await import("../src/db/pool.js");
  const pool = getPool();
  await pool.query(
    `TRUNCATE users, user_roles, sessions, refresh_tokens, devices, login_attempts,
       password_history, password_resets, email_verifications, mfa_factors,
       recovery_codes, security_events, audit_logs, notification_events,
       sheet_sync_jobs, applications, oauth_clients RESTART IDENTITY CASCADE`
  );
  // Clear per-IP throttle counters accumulated across suites
  const redis = (await import("../src/redis.js")).getRedis();
  const keys = await redis.keys("auth:*");
  if (keys.length > 0) await redis.del(...keys);
}

export async function runMigrationsAndSeed(): Promise<void> {
  const { runMigrations } = await import("../src/db/migrate.js");
  const { seed } = await import("../src/db/seed.js");
  await runMigrations();
  await seed();
}

// ---- Request helpers -------------------------------------------------------

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

export async function apiRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts?: { token?: string; body?: unknown; headers?: Record<string, string> }
): Promise<ApiResponse<T>> {
  const res = await app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts?.headers ?? {})
    },
    payload: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body: body as T, headers: res.headers };
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; userNumber: string; roles: string[]; permissions: string[] };
}

export async function loginAs(
  identifier: string,
  password: string
): Promise<LoginResult> {
  const res = await apiRequest<LoginResult & { mfaChallenge?: unknown }>("POST", "/auth/login", {
    body: { identifier, password }
  });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export async function bootstrapAdmin(password = "Test#Secure2026!Vault"): Promise<void> {
  const res = await apiRequest("POST", "/bootstrap/super-admin", {
    body: {
      email: "test.admin@dejoiy.com",
      bootstrapSecret: "test-bootstrap-secret",
      password,
      fullName: "Test Admin"
    }
  });
  if (res.status !== 200 && res.status !== 409) {
    throw new Error(`bootstrap failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
}

export const TEST_PASSWORD = "Test#Secure2026!Vault";

export function useTestServer() {
  beforeAll(async () => {
    await setupTestEnv();
    await runMigrationsAndSeed();
    await startServer();
  });
  beforeEach(async () => {
    await resetDatabase();
    await bootstrapAdmin();
  });
  afterAll(async () => {
    await stopServer();
  });
}
