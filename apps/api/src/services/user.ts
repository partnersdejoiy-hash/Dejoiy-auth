import { query, withTransaction, clientExecutor } from "../db/pool.js";
import { redisDel } from "../redis.js";
import { errors } from "../errors.js";
import { hashPassword } from "../crypto.js";
import { assignRoleToUser, removeRoleFromUser, getRolesForUser } from "./rbac.js";
import { recordAudit } from "./audit.js";

export type UserType = "customer" | "seller" | "employee" | "admin" | "service_account";
export type AccountState =
  | "PENDING" | "ACTIVE" | "SUSPENDED" | "BLOCKED" | "LOCKED"
  | "DISABLED" | "TERMINATED" | "PASSWORD_RESET_REQUIRED";

export interface UserRow {
  id: string;
  user_number: string;
  user_type: UserType;
  email: string | null;
  phone: string | null;
  username: string | null;
  password_hash: string | null;
  account_state: AccountState;
  mfa_enabled: boolean;
  mfa_required: boolean;
  password_changed_at: Date | null;
  last_login_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const USER_TYPE_PREFIX: Record<UserType, string> = {
  customer: "DJY-CUS",
  seller: "DJY-SLR",
  employee: "DJY-EMP",
  admin: "DJY-ADM",
  service_account: "DJY-SVC"
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Generate the next stable internal identifier, e.g. DJY-EMP-000428. */
async function nextUserNumber(type: UserType): Promise<string> {
  const prefix = USER_TYPE_PREFIX[type];
  const { rows } = await query<{ seq: number }>(
    `SELECT COALESCE(MAX(CAST(substring(user_number FROM '([0-9]+)$') AS integer)), 0) + 1 AS seq
       FROM users WHERE user_type = $1`,
    [type]
  );
  const seq = rows[0]?.seq ?? 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

export interface CreateUserInput {
  userType: UserType;
  email?: string;
  phone?: string;
  username?: string;
  password?: string;
  fullName?: string;
  accountState?: AccountState;
  roles?: string[];
  departmentId?: string;
  employeeId?: string;
  managerId?: string;
  mfaRequired?: boolean;
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const email = input.email ? normalizeEmail(input.email) : undefined;
  if (!email && !input.phone && !input.username) {
    throw errors.validation("At least one identifier (email, phone or username) is required");
  }
  if (email) {
    const existing = await findUserByIdentifier(email);
    if (existing) throw errors.conflict("A user with this email already exists");
  }

  const userNumber = await nextUserNumber(input.userType);
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users
         (user_number, user_type, email, phone, username, password_hash, account_state, mfa_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        userNumber,
        input.userType,
        email ?? null,
        input.phone ?? null,
        input.username ?? null,
        passwordHash,
        input.accountState ?? (input.password ? "PENDING" : "PENDING"),
        input.mfaRequired ?? false
      ]
    );
    const userRow = rows[0]!;

    if (input.fullName) {
      await client.query(
        `INSERT INTO user_profiles (user_id, full_name) VALUES ($1,$2)`,
        [userRow.id, input.fullName]
      );
    }

    if (input.userType === "employee") {
      await client.query(
        `INSERT INTO employee_profiles (user_id, employee_id, department_id, manager_id)
         VALUES ($1,$2,$3,$4)`,
        [userRow.id, input.employeeId ?? null, input.departmentId ?? null, input.managerId ?? null]
      );
      await client.query(
        `INSERT INTO wfm_profiles (user_id) VALUES ($1)`,
        [userRow.id]
      );
    }

    if (input.roles?.length) {
      const db = clientExecutor(client);
      for (const role of input.roles) {
        await assignRoleToUser(userRow.id, role, null, db);
      }
    }
    return userRow;
  });

  return user;
}

export async function findUserByIdentifier(identifier: string): Promise<UserRow | null> {
  const normalized = normalizeEmail(identifier);
  const { rows } = await query<UserRow>(
    `SELECT * FROM users
      WHERE (email = $1 OR username = $1 OR phone = $1 OR user_number = $1)
        AND deleted_at IS NULL
      LIMIT 1`,
    [normalized]
  );
  return rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [normalizeEmail(email)]
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE id = $1 ${opts?.includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    [id]
  );
  return rows[0] ?? null;
}

export interface UserDetail extends UserRow {
  profile: Record<string, unknown> | null;
  roles: string[];
  employee: Record<string, unknown> | null;
  wfm: Record<string, unknown> | null;
}

/** Full user view used by admin/IT/WFM panels. Never includes password_hash. */
export async function getUserDetail(id: string): Promise<UserDetail | null> {
  const user = await getUserById(id);
  if (!user) return null;
  const [profile, roles, employee, wfm] = await Promise.all([
    query("SELECT * FROM user_profiles WHERE user_id = $1", [id]),
    getRolesForUser(id),
    query("SELECT * FROM employee_profiles WHERE user_id = $1", [id]),
    query("SELECT * FROM wfm_profiles WHERE user_id = $1", [id])
  ]);
  return {
    ...user,
    password_hash: undefined as never, // strip
    profile: profile.rows[0] ?? null,
    roles: roles.map((r) => r.name),
    employee: employee.rows[0] ?? null,
    wfm: wfm.rows[0] ?? null
  };
}

export function publicUser(user: UserRow | UserDetail) {
  const { password_hash: _ph, ...safe } = user as UserRow & Record<string, unknown>;
  return safe;
}

export async function listUsers(opts: {
  search?: string;
  state?: AccountState;
  userType?: UserType;
  role?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: UserDetail[]; total: number }> {
  const where: string[] = ["u.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    const i = params.length;
    where.push(
      `(lower(u.email) LIKE $${i} OR lower(u.user_number) LIKE $${i} OR lower(u.username) LIKE $${i}
        OR lower(p.full_name) LIKE $${i} OR lower(ep.employee_id) LIKE $${i})`
    );
  }
  if (opts.state) {
    params.push(opts.state);
    where.push(`u.account_state = $${params.length}`);
  }
  if (opts.userType) {
    params.push(opts.userType);
    where.push(`u.user_type = $${params.length}`);
  }
  if (opts.role) {
    params.push(opts.role);
    where.push(`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = u.id AND r.name = $${params.length})`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  params.push(opts.limit, opts.offset);

  const [{ rows: countRows }, { rows }] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM users u
             LEFT JOIN user_profiles p ON p.user_id = u.id
             LEFT JOIN employee_profiles ep ON ep.user_id = u.id ${whereSql}`, params.slice(0, -2)),
    query(
      `SELECT u.id, u.user_number, u.user_type, u.email, u.phone, u.username, u.account_state,
              u.mfa_enabled, u.mfa_required, u.last_login_at, u.created_at, u.updated_at,
              p.full_name, ep.employee_id, ep.department_id, ep.employment_status,
              array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL) AS roles
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.id
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         ${whereSql}
         GROUP BY u.id, p.full_name, ep.employee_id, ep.department_id, ep.employment_status
         ORDER BY u.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  ]);
  return { rows: rows as unknown as UserDetail[], total: countRows[0]?.n ?? 0 };
}

// ---- Lifecycle ---------------------------------------------------------------

const LIFE_CYCLE_ACTIONS: Record<string, { target: AccountState; audit: string }> = {
  activate: { target: "ACTIVE", audit: "USER_ACTIVATED" },
  suspend: { target: "SUSPENDED", audit: "USER_SUSPENDED" },
  block: { target: "BLOCKED", audit: "USER_BLOCKED" },
  disable: { target: "DISABLED", audit: "USER_DISABLED" },
  terminate: { target: "TERMINATED", audit: "USER_TERMINATED" }
};

export async function changeAccountState(
  userId: string,
  action: keyof typeof LIFE_CYCLE_ACTIONS,
  actor: { id?: string; role?: string; ip?: string; correlationId?: string; reason?: string }
): Promise<UserRow> {
  const meta = LIFE_CYCLE_ACTIONS[action];
  if (!meta) throw errors.badRequest(`Unknown lifecycle action: ${action}`);
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("User not found");

  const { rows } = await query<UserRow>(
    `UPDATE users SET account_state = $1, failed_login_count = 0, locked_until = NULL
      WHERE id = $2 RETURNING *`,
    [meta.target, userId]
  );
  const updated = rows[0]!;

  if (action === "terminate") {
    await query("UPDATE employee_profiles SET employment_status = 'terminated', termination_date = now() WHERE user_id = $1", [userId]);
  }
  if (action === "activate" && user.user_type === "employee") {
    await query("UPDATE employee_profiles SET onboarding_status = 'onboarded' WHERE user_id = $1", [userId]);
  }

  await recordAudit({
    actorUserId: actor.id ?? null,
    actorRole: actor.role ?? null,
    action: meta.audit,
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor.correlationId ?? null,
    ip: actor.ip ?? null,
    reason: actor.reason ?? null,
    before: { account_state: user.account_state },
    after: { account_state: meta.target }
  });
  return updated;
}

export async function unlockAccount(
  userId: string,
  actor: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<UserRow> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("User not found");
  const { rows } = await query<UserRow>(
    `UPDATE users SET locked_until = NULL, failed_login_count = 0
      WHERE id = $1 RETURNING *`,
    [userId]
  );
  // Clear the Redis lock + attempt counters so the user can sign in immediately.
  await redisDel(`auth:lock:${userId}`, `auth:attempts:${userId}`);
  await recordAudit({
    actorUserId: actor.id ?? null,
    actorRole: actor.role ?? null,
    action: "USER_UNLOCKED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor.correlationId ?? null,
    ip: actor.ip ?? null
  });
  return rows[0]!;
}

export async function setAccountState(userId: string, state: AccountState): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    "UPDATE users SET account_state = $1 WHERE id = $2 RETURNING *",
    [state, userId]
  );
  return rows[0]!;
}

// ---- Password ------------------------------------------------------------------

export async function updatePassword(
  userId: string,
  newPassword: string,
  actor?: { id?: string; correlationId?: string; ip?: string | null }
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("User not found");

  const hash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query("UPDATE users SET password_hash = $1, password_changed_at = now(), account_state = 'ACTIVE' WHERE id = $2", [hash, userId]);
    await client.query(
      `INSERT INTO password_history (user_id, password_hash, changed_by) VALUES ($1,$2,$3)`,
      [userId, hash, actor?.id ?? null]
    );
    // Keep only the most recent N entries
    const limit = 10;
    await client.query(
      `DELETE FROM password_history WHERE id IN (
         SELECT id FROM password_history WHERE user_id = $1
         ORDER BY created_at DESC OFFSET $2
       )`,
      [userId, limit]
    );
  });
  await recordAudit({
    actorUserId: actor?.id ?? userId,
    action: "PASSWORD_CHANGED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor?.correlationId ?? null,
    ip: actor?.ip ?? null
  });
}

/** True when the new password was used recently (password history check). */
export async function isPasswordReused(userId: string, newPassword: string): Promise<boolean> {
  const { rows } = await query<{ password_hash: string }>(
    `SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  const { verifyPassword } = await import("../crypto.js");
  for (const row of rows) {
    if (await verifyPassword(row.password_hash, newPassword)) return true;
  }
  return false;
}

// ---- Roles on users ------------------------------------------------------------

export async function setUserRoles(
  userId: string,
  roleNames: string[],
  actor: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("User not found");
  const current = (await getRolesForUser(userId)).map((r) => r.name);

  for (const role of current) {
    if (!roleNames.includes(role)) await removeRoleFromUser(userId, role);
  }
  for (const role of roleNames) {
    if (!current.includes(role)) await assignRoleToUser(userId, role, actor.id ?? null);
  }

  await recordAudit({
    actorUserId: actor.id ?? null,
    actorRole: actor.role ?? null,
    action: "ROLE_CHANGED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor.correlationId ?? null,
    ip: actor.ip ?? null,
    before: { roles: current },
    after: { roles: roleNames }
  });
}

/** Soft-delete a user. */
export async function deleteUser(
  userId: string,
  actor: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("User not found");
  await query("UPDATE users SET deleted_at = now() WHERE id = $1", [userId]);
  await recordAudit({
    actorUserId: actor.id ?? null,
    actorRole: actor.role ?? null,
    action: "USER_DELETED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor.correlationId ?? null,
    ip: actor.ip ?? null
  });
}
