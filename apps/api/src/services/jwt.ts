import { SignJWT, jwtVerify, exportJWK, generateKeyPair, importPKCS8, importSPKI, type JWK } from "jose";
import { getConfig } from "../config.js";
import { errors, AppError } from "../errors.js";

// ─── Key Management ─────────────────────────────────────────────────────────

type CryptoKeyType = ReturnType<typeof generateKeyPair> extends Promise<{ publicKey: infer P }> ? P : never;

interface SigningKeyPair {
  privateKey: CryptoKeyType;
  publicKey: CryptoKeyType;
  kid: string;
  jwk: JWK & { kid: string; alg: string; use: string };
  algorithm: "EdDSA";
}

let currentKeyPair: SigningKeyPair | null = null;
let previousKeyPair: SigningKeyPair | null = null;

/**
 * Initialize or load signing keys.
 * In production, keys should be loaded from environment variables or a KMS.
 * In development, we generate ephemeral keys on startup.
 */
export async function initializeSigningKeys(): Promise<void> {
  const cfg = getConfig();

  // Try to load from environment first (production)
  if (cfg.JWT_PRIVATE_KEY && cfg.JWT_PUBLIC_KEY) {
    try {
      const privateKey = await importPKCS8(cfg.JWT_PRIVATE_KEY, "EdDSA");
      const publicKey = await importSPKI(cfg.JWT_PUBLIC_KEY, "EdDSA");
      const jwk = await exportJWK(publicKey);
      const kid = cfg.JWT_KID || "dejoiy-auth-key-1";

      currentKeyPair = {
        privateKey,
        publicKey,
        kid,
        jwk: { ...jwk, kid, alg: "EdDSA", use: "sig" },
        algorithm: "EdDSA"
      };

      console.log(`[jwt] Loaded Ed25519 signing key: ${kid}`);
      return;
    } catch (err) {
      console.warn("[jwt] Failed to load keys from env, generating ephemeral:", err);
    }
  }

  // Generate ephemeral keys (development only)
  console.log("[jwt] Generating ephemeral Ed25519 key pair...");
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519"
  });

  const jwk = await exportJWK(publicKey);
  const kid = "dejoiy-auth-dev-key";

  currentKeyPair = {
    privateKey,
    publicKey,
    kid,
    jwk: { ...jwk, kid, alg: "EdDSA", use: "sig" },
    algorithm: "EdDSA"
  };

  console.log(`[jwt] Ephemeral key generated: ${kid}`);
  console.log("[jwt] WARNING: Use JWT_PRIVATE_KEY/JWT_PUBLIC_KEY env vars in production!");
}

/**
 * Rotate signing keys. Current becomes previous, new becomes current.
 */
export async function rotateSigningKeys(): Promise<{ oldKid: string; newKid: string }> {
  if (currentKeyPair) {
    previousKeyPair = currentKeyPair;
  }

  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519"
  });

  const jwk = await exportJWK(publicKey);
  const kid = `dejoiy-auth-key-${Date.now()}`;

  currentKeyPair = {
    privateKey,
    publicKey,
    kid,
    jwk: { ...jwk, kid, alg: "EdDSA", use: "sig" },
    algorithm: "EdDSA"
  };

  const oldKid = previousKeyPair?.kid ?? "none";
  console.log(`[jwt] Key rotated: ${oldKid} → ${kid}`);

  return { oldKid, newKid: kid };
}

/**
 * Get the JWKS (JSON Web Key Set) for external verification.
 */
export function getJWKS(): { keys: Array<Record<string, unknown>> } {
  const keys: Array<Record<string, unknown>> = [];

  if (currentKeyPair) {
    keys.push(currentKeyPair.jwk as unknown as Record<string, unknown>);
  }

  // Previous keys remain valid for verification during rotation grace period
  if (previousKeyPair) {
    keys.push(previousKeyPair.jwk as unknown as Record<string, unknown>);
  }

  return { keys };
}

/**
 * Get the current signing key pair.
 */
function getCurrentKeyPair(): SigningKeyPair {
  if (!currentKeyPair) {
    throw new Error("JWT signing keys not initialized. Call initializeSigningKeys() first.");
  }
  return currentKeyPair;
}

// ─── Token Issuance ─────────────────────────────────────────────────────────

export interface AccessTokenClaims {
  sub: string;
  userNumber: string;
  role: string;
  permissions: string[];
  sid: string;
  type: "access";
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export async function issueAccessToken(payload: {
  userId: string;
  userNumber: string;
  role: string;
  permissions: string[];
  sessionId: string;
}): Promise<string> {
  const cfg = getConfig();
  const keyPair = getCurrentKeyPair();

  return new SignJWT({
    userNumber: payload.userNumber,
    role: payload.role,
    permissions: payload.permissions,
    sid: payload.sessionId,
    type: "access"
  })
    .setProtectedHeader({ alg: "EdDSA", kid: keyPair.kid })
    .setSubject(payload.userId)
    .setIssuer(cfg.OIDC_ISSUER_URL)
    .setAudience(cfg.APP_URL)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + cfg.ACCESS_TOKEN_TTL_SECONDS)
    .sign(keyPair.privateKey);
}

// ─── Token Verification ─────────────────────────────────────────────────────

export interface VerifiedAccessToken {
  sub: string;
  userNumber: string;
  role: string;
  permissions: string[];
  sid: string;
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  try {
    const cfg = getConfig();
    const keyPair = getCurrentKeyPair();

    // Try current key first
    try {
      const { payload } = await jwtVerify(token, keyPair.publicKey, {
        issuer: cfg.OIDC_ISSUER_URL,
        audience: cfg.APP_URL
      });
      return extractClaims(payload);
    } catch {
      // If current key fails, try previous key (rotation grace period)
      if (previousKeyPair) {
        const { payload } = await jwtVerify(token, previousKeyPair.publicKey, {
          issuer: cfg.OIDC_ISSUER_URL,
          audience: cfg.APP_URL
        });
        return extractClaims(payload);
      }
      throw errors.unauthorized("Invalid or expired token");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.unauthorized("Invalid or expired token");
  }
}

function extractClaims(payload: Record<string, unknown>): VerifiedAccessToken {
  if (payload.type !== "access" || !payload.sub || !payload.sid) {
    throw errors.unauthorized("Invalid token");
  }
  return {
    sub: payload.sub as string,
    userNumber: String(payload.userNumber ?? ""),
    role: String(payload.role ?? ""),
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
    sid: payload.sid as string
  };
}

// ─── ID Token ───────────────────────────────────────────────────────────────

export async function issueIdToken(payload: {
  userId: string;
  userNumber: string;
  email?: string | null;
  name?: string | null;
  role: string;
}): Promise<string> {
  const cfg = getConfig();
  const keyPair = getCurrentKeyPair();

  return new SignJWT({
    userNumber: payload.userNumber,
    role: payload.role,
    email: payload.email ?? undefined,
    name: payload.name ?? undefined
  })
    .setProtectedHeader({ alg: "EdDSA", kid: keyPair.kid })
    .setSubject(payload.userId)
    .setIssuer(cfg.OIDC_ISSUER_URL)
    .setAudience("dejoiy-auth")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(keyPair.privateKey);
}

// ─── Legacy HS256 Support (for backward compatibility) ──────────────────────

/**
 * Verify a token signed with legacy HS256 algorithm.
 * Used during migration period only.
 */
export async function verifyLegacyHS256(token: string): Promise<VerifiedAccessToken> {
  try {
    const cfg = getConfig();
    const legacyKey = new TextEncoder().encode(cfg.ACCESS_TOKEN_SECRET);

    const { payload } = await jwtVerify(token, legacyKey, {
      issuer: cfg.OIDC_ISSUER_URL,
      audience: cfg.APP_URL
    });

    return extractClaims(payload);
  } catch {
    throw errors.unauthorized("Invalid or expired token");
  }
}
