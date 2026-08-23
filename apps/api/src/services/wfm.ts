import { query } from "../db/pool.js";
import { errors } from "../errors.js";
import { recordAudit } from "./audit.js";
import { createUser, getUserById, setAccountState } from "./user.js";
import { assignRoleToUser } from "./rbac.js";

/**
 * WFM panel — employee-centric identity workflows:
 * onboarding, activation queue, deactivation, termination, absconding,
 * shift-linked access, department/manager mapping, bulk lifecycle actions.
 */

export interface OnboardEmployeeInput {
  email: string;
  fullName: string;
  employeeId: string;
  departmentId?: string;
  managerId?: string;
  designation?: string;
  shiftId?: string;
  hireDate?: string;
  roles?: string[];
  actor?: { id?: string; role?: string; ip?: string; correlationId?: string };
}

export async function onboardEmployee(input: OnboardEmployeeInput): Promise<{ id: string; userNumber: string }> {
  const existing = await query("SELECT 1 FROM employee_profiles WHERE employee_id = $1", [input.employeeId]);
  if (existing.rows.length > 0) throw errors.conflict("Employee ID already exists");

  // Created PENDING — sits in the activation queue until an authorized user activates it.
  const user = await createUser({
    userType: "employee",
    email: input.email,
    fullName: input.fullName,
    accountState: "PENDING",
    roles: input.roles ?? ["EMPLOYEE"],
    departmentId: input.departmentId,
    employeeId: input.employeeId,
    managerId: input.managerId
  });

  await query(
    `UPDATE employee_profiles SET designation = $2, hire_date = $3 WHERE user_id = $1`,
    [user.id, input.designation ?? null, input.hireDate ?? null]
  );
  if (input.shiftId) {
    await query("UPDATE wfm_profiles SET shift_id = $1, access_eligibility = false WHERE user_id = $2", [input.shiftId, user.id]);
  }

  await recordAudit({
    actorUserId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    action: "EMPLOYEE_ONBOARDED",
    targetType: "user",
    targetId: user.id,
    targetLabel: input.email,
    correlationId: input.actor?.correlationId ?? null,
    ip: input.actor?.ip ?? null,
    after: { employeeId: input.employeeId, departmentId: input.departmentId ?? null }
  });

  return { id: user.id, userNumber: user.user_number };
}

export async function activationQueue(opts: { limit: number; offset: number }) {
  const { rows } = await query(
    `SELECT u.id, u.user_number, u.email, u.created_at,
            p.full_name, ep.employee_id, d.name AS department
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       LEFT JOIN departments d ON d.id = ep.department_id
      WHERE u.account_state = 'PENDING' AND u.deleted_at IS NULL
      ORDER BY u.created_at
      LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset]
  );
  return rows;
}

export interface BulkLifecycleInput {
  userIds: string[];
  action: "activate" | "suspend" | "block" | "disable" | "terminate";
  reason?: string;
  actor?: { id?: string; role?: string; ip?: string; correlationId?: string };
}

/** Bulk lifecycle with per-user audit trail. */
export async function bulkLifecycle(input: BulkLifecycleInput): Promise<{ processed: number; results: Record<string, string> }> {
  const { changeAccountState } = await import("./user.js");
  const results: Record<string, string> = {};
  let processed = 0;
  for (const userId of input.userIds) {
    try {
      await changeAccountState(userId, input.action, {
        id: input.actor?.id,
        role: input.actor?.role,
        ip: input.actor?.ip,
        correlationId: input.actor?.correlationId,
        reason: input.reason
      });
      results[userId] = "ok";
      processed++;
    } catch (err) {
      results[userId] = err instanceof Error ? err.message : "failed";
    }
  }
  await recordAudit({
    actorUserId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    action: "BULK_" + input.action.toUpperCase(),
    targetType: "user",
    correlationId: input.actor?.correlationId ?? null,
    ip: input.actor?.ip ?? null,
    reason: input.reason ?? null,
    after: { userIds: input.userIds, results }
  });
  return { processed, results };
}

/** Absconded-employee disable flow: revoke access + mark absconded. */
export async function markAbsconded(
  userId: string,
  actor?: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("Employee not found");
  await query("UPDATE employee_profiles SET employment_status = 'absconded', absconded_at = now() WHERE user_id = $1", [userId]);
  await query("UPDATE wfm_profiles SET access_eligibility = false, agent_status = 'offline' WHERE user_id = $1", [userId]);
  await setAccountState(userId, "DISABLED");
  await recordAudit({
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: "EMPLOYEE_ABSCONDED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor?.correlationId ?? null,
    ip: actor?.ip ?? null,
    after: { employment_status: "absconded", account_state: "DISABLED" }
  });
}

export async function updateAgentStatus(
  userId: string,
  status: "offline" | "available" | "busy" | "break"
): Promise<void> {
  const valid = new Set(["offline", "available", "busy", "break"]);
  if (!valid.has(status)) throw errors.validation("Invalid agent status");
  await query(
    "UPDATE wfm_profiles SET agent_status = $1, last_status_change_at = now() WHERE user_id = $2",
    [status, userId]
  );
}

export async function setAccessEligibility(
  userId: string,
  eligible: boolean,
  actor?: { id?: string; role?: string; ip?: string; correlationId?: string }
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw errors.notFound("Employee not found");
  await query("UPDATE wfm_profiles SET access_eligibility = $1 WHERE user_id = $2", [eligible, userId]);
  await recordAudit({
    actorUserId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: eligible ? "ACCESS_ELIGIBILITY_GRANTED" : "ACCESS_ELIGIBILITY_REVOKED",
    targetType: "user",
    targetId: userId,
    targetLabel: user.email ?? user.user_number,
    correlationId: actor?.correlationId ?? null,
    ip: actor?.ip ?? null,
    after: { access_eligibility: eligible }
  });
}

export async function listEmployees(opts: {
  search?: string;
  departmentId?: string;
  employmentStatus?: string;
  agentStatus?: string;
  eligibleOnly?: boolean;
  limit: number;
  offset: number;
}) {
  const where: string[] = ["u.deleted_at IS NULL", "u.user_type = 'employee'"];
  const params: unknown[] = [];
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    const i = params.length;
    where.push(
      `(lower(u.email) LIKE $${i} OR lower(u.user_number) LIKE $${i} OR lower(p.full_name) LIKE $${i} OR lower(ep.employee_id) LIKE $${i})`
    );
  }
  if (opts.departmentId) {
    params.push(opts.departmentId);
    where.push(`ep.department_id = $${params.length}`);
  }
  if (opts.employmentStatus) {
    params.push(opts.employmentStatus);
    where.push(`ep.employment_status = $${params.length}`);
  }
  if (opts.agentStatus) {
    params.push(opts.agentStatus);
    where.push(`wp.agent_status = $${params.length}`);
  }
  if (opts.eligibleOnly) where.push("wp.access_eligibility = true");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  params.push(opts.limit, opts.offset);

  const [{ rows: countRows }, { rows }] = await Promise.all([
    query(
      `SELECT count(*)::int AS n FROM users u
         JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN user_profiles p ON p.user_id = u.id
         LEFT JOIN wfm_profiles wp ON wp.user_id = u.id ${whereSql}`,
      params.slice(0, -2)
    ),
    query(
      `SELECT u.id, u.user_number, u.email, u.account_state, u.last_login_at,
              p.full_name, ep.employee_id, ep.employment_status, ep.designation,
              ep.hire_date, ep.termination_date, ep.absconded_at,
              d.name AS department, m.email AS manager,
              wp.agent_status, wp.shift_id, wp.access_eligibility
         FROM users u
         JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN user_profiles p ON p.user_id = u.id
         LEFT JOIN wfm_profiles wp ON wp.user_id = u.id
         LEFT JOIN departments d ON d.id = ep.department_id
         LEFT JOIN users m ON m.id = ep.manager_id
         ${whereSql}
         ORDER BY ep.employee_id NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  ]);
  return { rows, total: countRows[0]?.n ?? 0 };
}
