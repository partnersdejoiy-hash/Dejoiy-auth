import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Redis } from "ioredis";
import { verifyAccessToken, type VerifiedAccessToken } from "../services/jwt.js";
import { errors } from "../errors.js";
import { getPermissionsForUser, getRolesForUser, isSuperAdmin } from "../services/rbac.js";
import { getUserById } from "../services/user.js";
import { getSessionById, sessionUsable } from "../services/session.js";
import { recordSecurityEvent, SECURITY_EVENT_TYPES } from "../services/security-events.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      token: VerifiedAccessToken;
      userId: string;
      userNumber: string;
      roles: string[];
      permissions: string[];
      sessionId: string;
      sessionValid: boolean;
    };
    correlationId?: string;
  }
  interface FastifyInstance {
    redisClient: Redis;
  }
}

const SERVICE_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Verifies the access token (Authorization: Bearer or HttpOnly cookie) and
 * loads the caller's identity. Session state is checked but kept soft by
 * default so downstream flows can respond appropriately.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  let rawToken: string | undefined;
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    rawToken = header.slice(7).trim();
  }
  if (!rawToken && request.cookies) {
    rawToken = request.cookies["dj_access"];
  }
  if (!rawToken) throw errors.unauthorized();

  const token = await verifyAccessToken(rawToken);

  // Service accounts carry embedded permissions and skip DB lookups.
  if (token.sub === SERVICE_ACCOUNT_ID) {
    request.auth = {
      token,
      userId: SERVICE_ACCOUNT_ID,
      userNumber: token.userNumber,
      roles: ["SERVICE_ACCOUNT"],
      permissions: token.permissions,
      sessionId: token.sid,
      sessionValid: true
    };
    return;
  }

  const [user, session] = await Promise.all([getUserById(token.sub), getSessionById(token.sid)]);
  if (!user) throw errors.unauthorized("Account no longer exists");

  if (user.deleted_at) throw errors.unauthorized("Account deleted");
  const lockedStates = new Set(["BLOCKED", "TERMINATED", "DISABLED"]);
  if (lockedStates.has(user.account_state)) {
    throw errors.forbidden("Account is not active");
  }

  const sessionValid = session
    ? sessionUsable({
        revoked_at: session.revoked_at,
        expires_at: session.expires_at,
        idle_expires_at: session.idle_expires_at,
        requires_reauth: session.requires_reauth
      })
    : false;
  if (!sessionValid) {
    throw errors.unauthorized("Session expired or revoked");
  }

  const [roles, dbPermissions] = await Promise.all([
    getRolesForUser(token.sub),
    getPermissionsForUser(token.sub)
  ]);

  request.auth = {
    token,
    userId: token.sub,
    userNumber: token.userNumber,
    roles: roles.map((r) => r.name),
    permissions: [...dbPermissions],
    sessionId: token.sid,
    sessionValid
  };
}

export interface PermissionGuardOptions {
  permissions?: string[];
  anyOf?: string[];
  hideOnDeny?: boolean;
}

export async function requirePermissions(
  request: FastifyRequest,
  opts: PermissionGuardOptions
): Promise<void> {
  if (!request.auth) throw errors.unauthorized();
  const { userId, permissions } = request.auth;

  if (await isSuperAdmin(userId)) return;
  if (opts.permissions?.length) {
    for (const permission of opts.permissions) {
      if (permissions.includes(permission)) return;
    }
    await deny(request);
  }
  if (opts.anyOf?.length) {
    if (opts.anyOf.some((p) => permissions.includes(p))) return;
    await deny(request);
  }
}

async function deny(request: FastifyRequest): Promise<never> {
  await recordSecurityEvent({
    eventType: SECURITY_EVENT_TYPES.PERMISSION_DENIED,
    severity: "medium",
    userId: request.auth?.userId ?? null,
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
    metadata: { path: request.url, method: request.method },
    correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId ?? null
  });
  throw errors.forbidden();
}

/** Fastify plugin: attaches the correlation-id hook. */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const id =
      typeof incoming === "string" && incoming.length <= 64
        ? incoming
        : `REQ-${request.id}`;
    request.correlationId = id;
    reply.header("x-correlation-id", id);
  });
});
