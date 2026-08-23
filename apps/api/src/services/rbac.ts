import { query, type DbExecutor } from "../db/pool.js";
import { errors } from "../errors.js";

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
}

export interface PermissionRow {
  id: string;
  name: string;
  resource: string;
  description: string | null;
}

/** Resolve the full permission set for a user (roles → permissions). */
export async function getPermissionsForUser(userId: string): Promise<Set<string>> {
  const { rows } = await query<{ name: string }>(
    `SELECT DISTINCT p.name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [userId]
  );
  return new Set(rows.map((r) => r.name));
}

export async function getRolesForUser(userId: string): Promise<RoleRow[]> {
  const { rows } = await query<RoleRow>(
    `SELECT r.id, r.name, r.description, r.is_system
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId]
  );
  return rows;
}

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.name = 'SUPER_ADMIN'`,
    [userId]
  );
  return rows.length > 0;
}

/**
 * Check whether a user holds a permission.
 * SUPER_ADMIN carries the wildcard. Missing permission → 403 (or 404 when
 * `hideOnDeny` is set, to reduce resource enumeration).
 */
export async function requirePermission(
  userId: string,
  permission: string,
  opts?: { hideOnDeny?: boolean }
): Promise<void> {
  if (await isSuperAdmin(userId)) return;
  const permissions = await getPermissionsForUser(userId);
  if (permissions.has(permission)) return;
  if (opts?.hideOnDeny) throw errors.notFound();
  throw errors.forbidden();
}

export async function requireAnyPermission(userId: string, permissions: string[]): Promise<void> {
  if (await isSuperAdmin(userId)) return;
  const owned = await getPermissionsForUser(userId);
  if (permissions.some((p) => owned.has(p))) return;
  throw errors.forbidden();
}

export async function listRoles(): Promise<RoleRow[]> {
  const { rows } = await query<RoleRow>("SELECT * FROM roles ORDER BY name");
  return rows;
}

export async function listPermissions(filter?: { resource?: string }): Promise<PermissionRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (filter?.resource) {
    params.push(filter.resource);
    where = "WHERE resource = $1";
  }
  const { rows } = await query<PermissionRow>(
    `SELECT * FROM permissions ${where} ORDER BY resource, name`,
    params
  );
  return rows;
}

export async function getRoleById(id: string): Promise<RoleRow | null> {
  const { rows } = await query<RoleRow>("SELECT * FROM roles WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getRoleByName(name: string): Promise<RoleRow | null> {
  const { rows } = await query<RoleRow>("SELECT * FROM roles WHERE name = $1", [name]);
  return rows[0] ?? null;
}

export async function getRolePermissions(roleId: string): Promise<string[]> {
  const { rows } = await query<{ name: string }>(
    `SELECT p.name FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 ORDER BY p.name`,
    [roleId]
  );
  return rows.map((r) => r.name);
}

export async function createRole(input: {
  name: string;
  description?: string;
  permissions: string[];
}): Promise<RoleRow> {
  const name = input.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!name) throw errors.validation("Role name is required");
  const { rows } = await query<RoleRow>(
    `INSERT INTO roles (name, description, is_system) VALUES ($1,$2,false) RETURNING *`,
    [name, input.description ?? null]
  );
  const role = rows[0]!;
  await setRolePermissions(role.id, input.permissions);
  return role;
}

export async function updateRole(
  roleId: string,
  input: { description?: string; permissions?: string[] }
): Promise<RoleRow> {
  const role = await getRoleById(roleId);
  if (!role) throw errors.notFound("Role not found");
  if (role.is_system) throw errors.forbidden("System roles cannot be modified directly");
  if (input.description !== undefined) {
    await query("UPDATE roles SET description = $1 WHERE id = $2", [input.description, roleId]);
  }
  if (input.permissions) {
    await setRolePermissions(roleId, input.permissions);
  }
  return (await getRoleById(roleId))!;
}

export async function deleteRole(roleId: string): Promise<void> {
  const role = await getRoleById(roleId);
  if (!role) throw errors.notFound("Role not found");
  if (role.is_system) throw errors.forbidden("System roles cannot be deleted");
  const { rows } = await query("SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1", [roleId]);
  if (rows.length > 0) throw errors.conflict("Role is assigned to users and cannot be deleted");
  await query("DELETE FROM roles WHERE id = $1", [roleId]);
}

async function setRolePermissions(roleId: string, permissionNames: string[]): Promise<void> {
  if (permissionNames.includes("*")) {
    throw errors.validation("Wildcard permissions can only be granted to SUPER_ADMIN");
  }
  await query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
  if (permissionNames.length === 0) return;
  await query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM permissions p WHERE p.name = ANY($2)
     ON CONFLICT DO NOTHING`,
    [roleId, permissionNames]
  );
}

export async function assignRoleToUser(
  userId: string,
  roleName: string,
  grantedBy?: string | null,
  db: DbExecutor = query
): Promise<void> {
  const role = await getRoleByName(roleName);
  if (!role) throw errors.notFound(`Role ${roleName} not found`);
  await db(
    `INSERT INTO user_roles (user_id, role_id, granted_by)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [userId, role.id, grantedBy ?? null]
  );
}

export async function removeRoleFromUser(userId: string, roleName: string, db: DbExecutor = query): Promise<void> {
  const role = await getRoleByName(roleName);
  if (!role) throw errors.notFound(`Role ${roleName} not found`);
  if (role.name === "SUPER_ADMIN") {
    const count = await countSuperAdmins();
    if (count <= 1) throw errors.conflict("Cannot remove the last Super Admin");
  }
  await db("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [userId, role.id]);
}

export async function countSuperAdmins(): Promise<number> {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'SUPER_ADMIN'`
  );
  return rows[0]?.n ?? 0;
}

/** Create a new permission (inert until assigned to a role). */
export async function createPermission(input: {
  name: string;
  resource: string;
  description?: string;
}): Promise<PermissionRow> {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");
  if (!name || !name.includes(".")) {
    throw errors.validation("Permission name must follow the resource.action pattern");
  }
  const resource = input.resource.trim().toLowerCase();
  const { rows } = await query<PermissionRow>(
    `INSERT INTO permissions (name, resource, description) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO UPDATE SET resource = EXCLUDED.resource, description = EXCLUDED.description
     RETURNING *`,
    [name, resource, input.description ?? null]
  );
  return rows[0]!;
}
