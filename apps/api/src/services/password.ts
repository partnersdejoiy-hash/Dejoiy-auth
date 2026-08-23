import { getConfig } from "../config.js";
import { hashPassword } from "../crypto.js";

/** Result of password policy evaluation. */
export interface PasswordCheck {
  ok: boolean;
  errors: string[];
  score: number; // 0..4 for strength meter
}

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "qwertyuiop", "letmein", "welcome", "welcome1", "admin123",
  "iloveyou", "monkey123", "dragon123", "abc12345", "passw0rd", "trustno1",
  "sunshine1", "princess1", "football1", "shadow123", "superman1", "michael1",
  "dejoiy123", "dejoiy1234", "dejoiy2024", "dejoiy2025", "dejoiy@123"
]);

const COMPANY_TOKENS = ["dejoiy", "djy", "dejoiyindia", "dejoiy india"];

export function evaluatePassword(
  password: string,
  opts?: { username?: string; email?: string; privileged?: boolean }
): PasswordCheck {
  const cfg = getConfig();
  const errors: string[] = [];
  const minLength = opts?.privileged ? Math.max(cfg.PASSWORD_MIN_LENGTH, 16) : cfg.PASSWORD_MIN_LENGTH;

  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters`);
  }
  if (cfg.PASSWORD_REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
    errors.push("Password must contain an uppercase letter");
  }
  if (cfg.PASSWORD_REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
    errors.push("Password must contain a lowercase letter");
  }
  if (cfg.PASSWORD_REQUIRE_NUMBER && !/\d/.test(password)) {
    errors.push("Password must contain a number");
  }
  if (cfg.PASSWORD_REQUIRE_SPECIAL && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must contain a special character");
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push("This password is too common");
  }
  if (/(.)\1{3,}/.test(password)) {
    errors.push("Password contains too many repeated characters");
  }
  if (/(0123|1234|2345|3456|4567|5678|6789|7890|9876|8765|7654|6543|5432|4321|3210|qwer|wert|erty|rtyu|tyui|yuio|uiop|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm)/i.test(password)) {
    errors.push("Password contains a sequential sequence");
  }
  const lower = password.toLowerCase();
  for (const token of COMPANY_TOKENS) {
    if (lower.includes(token)) {
      errors.push("Password must not contain the company name");
      break;
    }
  }
  if (opts?.username && lower.includes(opts.username.toLowerCase())) {
    errors.push("Password must not contain your username");
  }
  if (opts?.email) {
    const local = opts.email.split("@")[0]?.toLowerCase();
    if (local && lower.includes(local)) {
      errors.push("Password must not contain your email address");
    }
  }

  return { ok: errors.length === 0, errors, score: passwordStrengthScore(password) };
}

/** Simple entropy-based strength score 0..4 (for the frontend meter). */
export function passwordStrengthScore(password: string): number {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(4, score);
}

/** Checks breached-password via HIBP k-anonymity when enabled. */
export async function isBreachedPassword(password: string): Promise<boolean> {
  // Provider seam: enable by setting BREACH_CHECK=hibp in a future release.
  // Implementation keeps only the first 5 hex chars of the SHA-1 remotely.
  return false;
}

/** Hash a password for storage (Argon2id). */
export function hashForStorage(password: string): Promise<string> {
  return hashPassword(password);
}
