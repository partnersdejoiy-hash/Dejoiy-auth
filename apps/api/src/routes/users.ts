import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createUser, getUserDetail, listUsers, changeAccountState, unlockAccount,
  setUserRoles, deleteUser, updatePassword, publicUser
} from "../services/user.js";
import { query } from "../db/pool.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { evaluatePassword, isBreachedPassword } from "../services/password.js";
import { isPasswordReused } from "../services/user.js";
import { revokeAllUserSessions } from "../services/session.js";
import { errors } from "../errors.js";

const createUserSchema = z.object({
  userType: z.enum(["customer", "seller", "employee", "admin", "service_account"]),
  email: z.string().email().optional(),
  phone: z.string().min(5).max(20).optional(),
  username: z.string().min(3).max(64).optional(),
  password: z.string().min(8).max(512).optional(),
  fullName: z.string().min(1).max(200).optional(),
  accountState: z.string().optional(),
  roles: z.array(z.string()).optional(),
  departmentId: z.string().uuid().optional(),
  employeeId: z.string().optional(),
  managerId: z.string().uuid().optional(),
  mfaRequired: z.boolean().optional()
});

const updateRolesSchema = z.object({ roles: z.array(z.string()).max(20) });
const resetPasswordSchema = z.object({
  newPassword: z.string().min(8).max(512),
  forceChange: z.boolean().optional()
});
const lifecycleSchema = z.object({ reason: z.string().max(500).optional() });

const actorFrom = (request: { auth?: { userId: string; roles: string[] }; ip: string; correlationId?: string }) => ({
  id: request.auth?.userId,
  role: request.auth?.roles[0],
  ip: request.ip,
  correlationId: request.correlationId ?? undefined
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.read"] })] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const result = await listUsers({
      search: query.search,
      state: query.state as never,
      userType: query.userType as never,
      role: query.role,
      limit: Math.min(Number(query.limit ?? 50), 200),
      offset: Number(query.offset ?? 0)
    });
    return result;
  });

  app.get("/users/:id", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.read"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await getUserDetail(id);
    if (!user) throw errors.notFound("User not found");
    return user;
  });

  app.post("/users", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.create"] })] }, async (request) => {
    const input = createUserSchema.parse(request.body);
    if (input.password) {
      const check = evaluatePassword(input.password, {
        email: input.email,
        username: input.username
      });
      if (!check.ok) throw errors.validation(check.errors.join("; "));
      if (await isBreachedPassword(input.password)) {
        throw errors.validation("This password appears in known data breaches");
      }
    }
    const user = await createUser({
      ...input,
      accountState: input.accountState as never
    });
    return publicUser(user);
  });

  app.patch("/users/:id", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.update"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      fullName: z.string().min(1).max(200).optional(),
      phone: z.string().min(5).max(20).optional(),
      departmentId: z.string().uuid().nullable().optional(),
      managerId: z.string().uuid().nullable().optional(),
      mfaRequired: z.boolean().optional()
    }).parse(request.body);

    const user = await getUserDetail(id);
    if (!user) throw errors.notFound("User not found");

    if (body.fullName !== undefined) {
      await query(
        `INSERT INTO user_profiles (user_id, full_name) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
        [id, body.fullName]
      );
    }
    if (body.phone !== undefined) {
      await query("UPDATE users SET phone = $1 WHERE id = $2", [body.phone, id]);
    }
    if (body.departmentId !== undefined || body.managerId !== undefined) {
      await query(
        "UPDATE employee_profiles SET department_id = COALESCE($1, department_id), manager_id = COALESCE($2, manager_id) WHERE user_id = $3",
        [body.departmentId ?? null, body.managerId ?? null, id]
      );
    }
    if (body.mfaRequired !== undefined) {
      await query("UPDATE users SET mfa_required = $1 WHERE id = $2", [body.mfaRequired, id]);
    }
    return getUserDetail(id);
  });

  // Lifecycle: activate / suspend / block / disable / terminate
  for (const action of ["activate", "suspend", "block", "disable", "terminate"] as const) {
    const permission =
      action === "activate" ? "user.activate" :
      action === "suspend" ? "user.suspend" :
      action === "block" ? "user.block" :
      action === "disable" ? "user.disable" : "user.terminate";
    app.post(
      `/users/:id/${action}`,
      { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: [permission] })] },
      async (request) => {
        const { id } = request.params as { id: string };
        const { reason } = lifecycleSchema.parse(request.body ?? {});
        const updated = await changeAccountState(id, action, { ...actorFrom(request), reason });
        return publicUser(updated);
      }
    );
  }

  app.post("/users/:id/unblock", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.unblock"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const updated = await changeAccountState(id, "activate", actorFrom(request));
    return publicUser(updated);
  });

  app.post("/users/:id/unlock", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.unlock"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const updated = await unlockAccount(id, actorFrom(request));
    return publicUser(updated);
  });

  app.post("/users/:id/force-logout", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.force_logout"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const count = await revokeAllUserSessions(id, "force_logout", { actor: actorFrom(request) });
    return { ok: true, revokedSessions: count };
  });

  app.post("/users/:id/roles", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["role.assign"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const { roles } = updateRolesSchema.parse(request.body);
    await setUserRoles(id, roles, actorFrom(request));
    return { ok: true, roles };
  });

  app.post("/users/:id/reset-password", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.reset_password"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const { newPassword, forceChange } = resetPasswordSchema.parse(request.body);
    const user = await getUserDetail(id);
    if (!user) throw errors.notFound("User not found");
    const check = evaluatePassword(newPassword, { email: user.email ?? undefined, privileged: user.roles.includes("SUPER_ADMIN") });
    if (!check.ok) throw errors.validation(check.errors.join("; "));
    if (await isPasswordReused(id, newPassword)) {
      throw errors.validation("Password was used recently. Choose a different password.");
    }
    await updatePassword(id, newPassword, actorFrom(request));
    if (forceChange) {
      await query("UPDATE users SET account_state = 'PASSWORD_RESET_REQUIRED' WHERE id = $1", [id]);
    }
    await revokeAllUserSessions(id, "password_reset_by_admin", { actor: actorFrom(request) });
    return { ok: true };
  });

  app.delete("/users/:id", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.delete"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteUser(id, actorFrom(request));
    return { ok: true };
  });
}
