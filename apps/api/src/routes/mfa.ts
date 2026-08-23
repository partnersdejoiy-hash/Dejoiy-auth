import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  enrollTotp, verifyTotpForUser, useRecoveryCode, resetMfa, listMfaStatus
} from "../services/mfa.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { getUserById } from "../services/user.js";
import { errors } from "../errors.js";

const codeSchema = z.object({ code: z.string().min(6).max(16) });
const recoverySchema = z.object({ code: z.string().min(8).max(32) });

export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  // Enroll TOTP (own account)
  app.post("/mfa/totp/enroll", { preHandler: [authenticate] }, async (request) => {
    const result = await enrollTotp(request.auth!.userId, {
      correlationId: request.correlationId,
      ip: request.ip
    });
    return result;
  });

  // Verify a TOTP code (re-auth / enrollment confirmation)
  app.post("/mfa/totp/verify", { preHandler: [authenticate] }, async (request) => {
    const { code } = codeSchema.parse(request.body);
    const ok = await verifyTotpForUser(request.auth!.userId, code);
    if (!ok) throw errors.unauthorized("Invalid code");
    return { ok: true };
  });

  // Use a recovery code (own account)
  app.post("/mfa/recovery/use", { preHandler: [authenticate] }, async (request) => {
    const { code } = recoverySchema.parse(request.body);
    const ok = await useRecoveryCode(request.auth!.userId, code);
    if (!ok) throw errors.unauthorized("Invalid or used recovery code");
    return { ok: true };
  });

  // MFA status (own account)
  app.get("/mfa/status", { preHandler: [authenticate] }, async (request) => {
    return listMfaStatus(request.auth!.userId);
  });

  // Admin: reset another user's MFA
  app.post(
    "/users/:id/reset-mfa",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.reset_mfa"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      await resetMfa(id, {
        id: request.auth!.userId,
        role: request.auth!.roles[0],
        ip: request.ip,
        correlationId: request.correlationId
      });
      return { ok: true };
    }
  );
}
