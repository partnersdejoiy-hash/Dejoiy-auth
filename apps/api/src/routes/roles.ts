import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listRoles, listPermissions, createRole, updateRole, deleteRole,
  createPermission, getRoleById, getRolePermissions
} from "../services/rbac.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { recordAudit } from "../services/audit.js";
import { emitEvent } from "../services/events.js";
import { errors } from "../errors.js";

const roleSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).default([])
});
const permissionSchema = z.object({
  name: z.string().min(3).max(64),
  resource: z.string().min(2).max(32),
  description: z.string().max(500).optional()
});

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/roles", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["role.read"] })] }, async () => {
    const roles = await listRoles();
    return Promise.all(
      roles.map(async (role) => ({
        ...role,
        permissions: await getRolePermissions(role.id)
      }))
    );
  });

  app.get("/permissions", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["permission.read"] })] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return listPermissions({ resource: query.resource });
  });

  app.post("/roles", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["role.create"] })] }, async (request) => {
    const input = roleSchema.parse(request.body);
    const role = await createRole(input);
    await recordAudit({
      actorUserId: request.auth!.userId,
      actorRole: request.auth!.roles[0],
      action: "ROLE_CREATED",
      targetType: "role",
      targetId: role.id,
      targetLabel: role.name,
      correlationId: request.correlationId,
      ip: request.ip,
      after: { permissions: input.permissions }
    });
    await emitEvent("role.changed", {
      roleId: role.id,
      roleName: role.name,
      action: "created",
      permissions: input.permissions
    }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
    return role;
  });

  app.patch("/roles/:id", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["role.update", "permission.assign"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      description: z.string().max(500).optional(),
      permissions: z.array(z.string()).max(200).optional()
    }).parse(request.body);
    const role = await updateRole(id, body);
    await recordAudit({
      actorUserId: request.auth!.userId,
      actorRole: request.auth!.roles[0],
      action: "ROLE_UPDATED",
      targetType: "role",
      targetId: id,
      targetLabel: role.name,
      correlationId: request.correlationId,
      ip: request.ip,
      after: body.permissions ? { permissions: body.permissions } : undefined
    });
    await emitEvent(body.permissions ? "permission.changed" : "role.changed", {
      roleId: id,
      roleName: role.name,
      action: body.permissions ? "permissions_updated" : "updated",
      permissions: body.permissions
    }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
    return role;
  });

  app.delete("/roles/:id", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["role.delete"] })] }, async (request) => {
    const { id } = request.params as { id: string };
    const role = await getRoleById(id);
    if (!role) throw errors.notFound("Role not found");
    await deleteRole(id);
    await recordAudit({
      actorUserId: request.auth!.userId,
      actorRole: request.auth!.roles[0],
      action: "ROLE_DELETED",
      targetType: "role",
      targetId: id,
      targetLabel: role.name,
      correlationId: request.correlationId,
      ip: request.ip
    });
    await emitEvent("role.changed", {
      roleId: id,
      roleName: role.name,
      action: "deleted"
    }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
    return { ok: true };
  });

  app.post("/permissions", { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["permission.assign"] })] }, async (request) => {
    const input = permissionSchema.parse(request.body);
    const permission = await createPermission(input);
    await recordAudit({
      actorUserId: request.auth!.userId,
      actorRole: request.auth!.roles[0],
      action: "PERMISSION_CREATED",
      targetType: "permission",
      targetId: permission.id,
      targetLabel: permission.name,
      correlationId: request.correlationId,
      ip: request.ip
    });
    await emitEvent("permission.changed", {
      permissionId: permission.id,
      permissionName: permission.name,
      action: "created"
    }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
    return permission;
  });
}
