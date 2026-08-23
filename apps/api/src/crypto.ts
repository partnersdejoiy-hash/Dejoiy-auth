import argon2 from "argon2";
import crypto from "node:crypto";

/**
 * Cryptographic primitives used across the platform.
 * - Argon2id password hashing (OWASP-recommended parameters)
 * - cryptographically secure random tokens
 * - SHA-256 digests for at-rest token storage
 * - AES-256-GCM for short-lived secret encryption
 */

// ---- Password hashing (Argon2id) ------------------------------------------

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// ---- Random tokens ----------------------------------------------------------

/** Cryptographically secure random bytes as base64url (no padding). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Short numeric OTP (for MFA/recovery where required). */
export function randomOtp(length = 6): string {
  const digits = new Uint8Array(length);
  crypto.getRandomValues(digits);
  return Array.from(digits, (d) => String(d % 10)).join("");
}

// ---- Token storage hashes ----------------------------------------------------

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Hash of a refresh token for at-rest storage (never store raw). */
export function hashToken(token: string): string {
  return sha256(token);
}

// ---- Symmetric encryption (AES-256-GCM) ---------------------------------------

/** Encrypt a short-lived secret (e.g. OTP/recovery blobs) with DATA_ENCRYPTION_KEY. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) key.fill(0, key.length, 32).subarray(0, 32); // normalize dev keys
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(".");
}

export function decryptSecret(payload: string, keyHex: string): string | null {
  try {
    const key = Buffer.from(keyHex, "hex");
    if (key.length !== 32) key.fill(0, key.length, 32).subarray(0, 32);
    const [ivHex, tagHex, dataHex] = payload.split(".");
    if (!ivHex || !tagHex || !dataHex) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final()
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

// ---- Fingerprints (privacy-conscious) ------------------------------------------

/**
 * Device fingerprint: SHA-256 of normalized user-agent + IP prefix + client nonce.
 * Never stores raw IP/UA.
 */
export function deviceFingerprint(userAgent: string, ip: string, nonce: string): string {
  const normalized = `${userAgent.toLowerCase().replace(/\s+/g, " ").trim()}|${ipPrefix(ip)}|${nonce}`;
  return sha256(normalized);
}

function ipPrefix(ip: string): string {
  const cleaned = ip.replace(/^::ffff:/, "");
  if (cleaned.includes(":")) {
    // IPv6: first 4 hextets
    return cleaned.split(":").slice(0, 4).join(":");
  }
  // IPv4: first 3 octets
  return cleaned.split(".").slice(0, 3).join(".");
}
