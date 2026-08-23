import { SignJWT, jwtVerify } from "jose";
import { getConfig } from "../config.js";
import { errors, AppError } from "../errors.js";

export interface AccessTokenClaims {
  sub: string;          // internal user id (uuid)
  userNumber: string;   // e.g. DJY-EMP-000428
  role: string;         // primary role name (for convenience; RBAC resolves full set)
  permissions: string[]; // resolved permissions snapshot
  sid: string;          // session id
  type: "access";
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getConfig().ACCESS_TOKEN_SECRET);
}

export async function issueAccessToken(payload: {
  userId: string;
  userNumber: string;
  role: string;
  permissions: string[];
  sessionId: string;
}): Promise<string> {
  const cfg = getConfig();
  return new SignJWT({
    userNumber: payload.userNumber,
    role: payload.role,
    permissions: payload.permissions,
    sid: payload.sessionId,
    type: "access"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuer(cfg.OIDC_ISSUER_URL)
    .setAudience(cfg.APP_URL)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + cfg.ACCESS_TOKEN_TTL_SECONDS)
    .sign(secretKey());
}

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
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: cfg.OIDC_ISSUER_URL,
      audience: cfg.APP_URL
    });
    if (payload.type !== "access" || !payload.sub || !payload.sid) {
      throw errors.unauthorized("Invalid token");
    }
    return {
      sub: payload.sub,
      userNumber: String(payload.userNumber ?? ""),
      role: String(payload.role ?? ""),
      permissions: Array.isArray(payload.permissions) ? payload.permissions.map(String) : [],
      sid: String(payload.sid)
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.unauthorized("Invalid or expired token");
  }
}

export async function issueIdToken(payload: {
  userId: string;
  userNumber: string;
  email?: string | null;
  name?: string | null;
  role: string;
}): Promise<string> {
  const cfg = getConfig();
  return new SignJWT({
    userNumber: payload.userNumber,
    role: payload.role,
    email: payload.email ?? undefined,
    name: payload.name ?? undefined
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuer(cfg.OIDC_ISSUER_URL)
    .setAudience("dejoiy-auth")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secretKey());
}
