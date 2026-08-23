import { pino } from "pino";
import { getConfig } from "./config.js";

/**
 * Structured JSON logger with automatic redaction of secrets.
 * Never log: passwords, tokens, cookies, authorization headers, MFA secrets, API keys.
 */
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "*.password",
  "*.passwordConfirm",
  "*.currentPassword",
  "*.newPassword",
  "*.token",
  "*.refreshToken",
  "*.accessToken",
  "*.secret",
  "*.clientSecret",
  "*.mfaCode",
  "*.recoveryCode",
  "*.bootstrapSecret",
  "*.apiKey"
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (getConfig().NODE_ENV === "production" ? "info" : "debug"),
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  base: { service: "dejoiy-auth-api" },
  timestamp: pino.stdTimeFunctions.isoTime
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
