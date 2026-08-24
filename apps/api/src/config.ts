import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Dependency-free .env loader (no dotenv). Looks in the working directory and
 * the repository root. Never overrides already-set environment variables.
 */
function loadEnvFile(): void {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) return;
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../../.env")
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Strip inline comments
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    break; // first existing file wins
  }
}

/**
 * Typed, validated runtime configuration.
 * All secrets come from environment variables — never from source code.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("dejoiy-auth"),
  APP_URL: z.string().url().default("http://localhost:8080"),

  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:8080"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),

  DATABASE_URL: z
    .string()
    .default("postgres://dejoiy_auth:dejoiy_auth@localhost:5432/dejoiy_auth"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  ACCESS_TOKEN_SECRET: z.string().min(32).default("dev-only-access-token-secret-0123456789abcdef"),
  REFRESH_TOKEN_SECRET: z.string().min(32).default("dev-only-refresh-token-secret-0123456789abcdef"),
  DATA_ENCRYPTION_KEY: z.string().min(32).default("dev-only-data-encryption-key-0123456789abcdef"),
  COOKIE_SECRET: z.string().min(16).default("dev-only-cookie-secret"),
  BOOTSTRAP_SECRET: z.string().min(8).default("dev-only-bootstrap-secret"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),

  PASSWORD_MIN_LENGTH: z.coerce.number().int().positive().default(14),
  PASSWORD_REQUIRE_UPPERCASE: z.coerce.boolean().default(true),
  PASSWORD_REQUIRE_LOWERCASE: z.coerce.boolean().default(true),
  PASSWORD_REQUIRE_NUMBER: z.coerce.boolean().default(true),
  PASSWORD_REQUIRE_SPECIAL: z.coerce.boolean().default(true),
  PASSWORD_HISTORY_LIMIT: z.coerce.number().int().positive().default(10),
  PRIVILEGED_ROLES: z.string().default("SUPER_ADMIN,IT_ADMIN,SECURITY_ADMIN,AUDITOR"),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  LOGIN_LOCKOUT_DURATION_SECONDS: z.coerce.number().int().positive().default(900),
  LOGIN_PROGRESSIVE_DELAY_STEP_MS: z.coerce.number().int().nonnegative().default(400),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(30),

  MAIL_PROVIDER: z.enum(["console", "smtp", "dejoiy-swiss", "ses"]).default("console"),
  MAIL_FROM: z.string().default("no-reply@dejoiy.com"),
  MAIL_ERRORS_FROM: z.string().default("errors@dejoiy.com"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_SECURE: z.coerce.boolean().default(false),
  DEJOIY_MAIL_API_URL: z.string().default(""),
  DEJOIY_MAIL_API_KEY: z.string().default(""),
  AWS_SES_REGION: z.string().default(""),
  AWS_SES_ACCESS_KEY_ID: z.string().default(""),
  AWS_SES_SECRET_ACCESS_KEY: z.string().default(""),

  ZOHO_CLIENT_ID: z.string().default(""),
  ZOHO_CLIENT_SECRET: z.string().default(""),
  ZOHO_REFRESH_TOKEN: z.string().default(""),
  ZOHO_SHEET_URL: z.string().default(""),
  ZOHO_SHEET_WORKSHEET: z.string().default(""),  // worksheet name; empty = first worksheet
  ZOHO_SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Sync mode: "scheduled" (interval) | "near-real-time" (incremental polling).
  // We never claim real-time: Zoho Sheet has no native outbound event for cell edits.
  ZOHO_SYNC_MODE: z.enum(["scheduled", "near-real-time"]).default("scheduled"),
  ZOHO_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // Deletion policy for soft-deleted users: mark (Status=TERMINATED) | keep | delete (row only)
  ZOHO_SYNC_DELETION_POLICY: z.enum(["mark", "keep", "delete"]).default("mark"),
  // Rate-limit safety: minimum spacing between Zoho API calls + retry/backoff.
  ZOHO_API_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(350),
  ZOHO_SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  ZOHO_SYNC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  ZOHO_SYNC_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  ZOHO_DEMO_MAX_RECORDS: z.coerce.number().int().positive().default(50000),

  OIDC_ISSUER_URL: z.string().url().default("http://localhost:8080"),
  OAUTH_AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Ed25519 JWT signing keys (PEM format). When absent, ephemeral keys are generated (dev only).
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_KID: z.string().default("dejoiy-auth-key-1"),

  CSP_FRAME_ANCESTORS: z.string().default("'none'"),
  HSTS_MAX_AGE: z.coerce.number().int().nonnegative().default(31536000),

  // Webhook configuration
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  WEBHOOK_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(5000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadEnvFile();
  if (cached && process.env.NODE_ENV !== "test") return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;
  cached = cfg;
  return cfg;
}

export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}

export const privilegedRoles = (cfg: AppConfig): Set<string> =>
  new Set(cfg.PRIVILEGED_ROLES.split(",").map((r) => r.trim()).filter(Boolean));

export const corsOrigins = (cfg: AppConfig): string[] =>
  cfg.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
