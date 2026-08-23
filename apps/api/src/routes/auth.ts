import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  login, refresh, logout, forgotPassword, resetPassword, verifyMfaAndLogin,
  requestEmailVerification, verifyEmail, changeOwnPassword, buildUserPayload
} from "../services/auth.js";
import { authenticate } from "../plugins/auth.js";

const loginSchema = z.object({
  identifier: z.string().min(3).max(255),
  password: z.string().min(1).max(512)
});
const mfaSchema = z.object({
  identifier: z.string().min(3).max(255),
  code: z.string().min(6).max(8),
  challenge: z.string().min(8)
});
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const emailSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(512)
});
const tokenSchema = z.object({ token: z.string().min(10) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(8).max(512)
});

function requestMeta(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
    clientNonce: typeof request.headers["x-client-nonce"] === "string" ? request.headers["x-client-nonce"] : undefined,
    correlationId: request.correlationId ?? null
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const { identifier, password } = loginSchema.parse(request.body);
    const result = await login(identifier, password, requestMeta(request));
    reply.header("x-auth-required", result.mfaChallenge ? "mfa" : "false");
    return reply.send(result);
  });

  app.post("/auth/mfa/verify", async (request) => {
    const { identifier, code, challenge } = mfaSchema.parse(request.body);
    return verifyMfaAndLogin(identifier, code, challenge, requestMeta(request));
  });

  app.post("/auth/refresh", async (request) => {
    const { refreshToken } = refreshSchema.parse(request.body);
    return refresh(refreshToken, requestMeta(request));
  });

  app.post("/auth/logout", { preHandler: [authenticate] }, async (request) => {
    await logout(request.auth!.sessionId);
    return { ok: true };
  });

  app.post("/auth/forgot-password", async (request) => {
    const { email } = emailSchema.parse(request.body);
    await forgotPassword(email, requestMeta(request));
    // Always the same response (prevents enumeration).
    return { ok: true, message: "If that email exists, a reset link has been sent." };
  });

  app.post("/auth/reset-password", async (request) => {
    const { token, password } = resetSchema.parse(request.body);
    await resetPassword(token, password, requestMeta(request));
    return { ok: true };
  });

  app.post("/auth/verify-email", async (request) => {
    const { token } = tokenSchema.parse(request.body);
    await verifyEmail(token, requestMeta(request));
    return { ok: true };
  });

  app.post("/auth/resend-verification", { preHandler: [authenticate] }, async (request) => {
    await requestEmailVerification(request.auth!.userId, requestMeta(request));
    return { ok: true };
  });

  app.post("/auth/change-password", { preHandler: [authenticate] }, async (request) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
    await changeOwnPassword(
      request.auth!.userId,
      currentPassword,
      newPassword,
      { ...requestMeta(request), sessionId: request.auth!.sessionId }
    );
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: [authenticate] }, async (request) => {
    return buildUserPayload(request.auth!.userId);
  });

  app.get("/auth/session-status", { preHandler: [authenticate] }, async (request) => {
    return { valid: request.auth!.sessionValid, sessionId: request.auth!.sessionId };
  });
}
