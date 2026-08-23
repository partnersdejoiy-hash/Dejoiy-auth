import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * RFC 6238 TOTP implementation (SHA-1, 6 digits, 30s period).
 * Base32 secrets; standard otpauth:// URI generation for QR enrollment.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = randomBytes(20); // 160-bit secret
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    secret += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return secret;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const c of clean) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error("Invalid base32 character");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpCounter(timestamp = Date.now(), period = 30): number {
  return Math.floor(timestamp / 1000 / period);
}

export function generateTOTP(secret: string, counter?: number, digits = 6, period = 30): string {
  const key = base32Decode(secret);
  const c = counter ?? totpCounter(Date.now(), period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(c));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** Verify a TOTP code allowing ±1 window step (30s drift tolerance). */
export function verifyTOTP(secret: string, code: string, digits = 6, window = 1, period = 30): boolean {
  const c = totpCounter(Date.now(), period);
  for (let i = -window; i <= window; i++) {
    if (generateTOTP(secret, c + i, digits, period) === code) return true;
  }
  return false;
}

export function otpauthUri(opts: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Deterministic hash used to derive a stable recovery-code hash. */
export function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
