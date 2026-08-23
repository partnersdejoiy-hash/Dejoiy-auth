import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  onboardEmployee, activationQueue, bulkLifecycle, markAbsconded,
  updateAgentStatus, setAccessEligibility, listEmployees
} from "../services/wfm.js";
import { listUserSessions } from "../services/session.js";
import { query } from "../db/pool.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { errors } from "../errors.js";

const onboardSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  employeeId: z.string().min(2).max(64),
  departmentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  designation: z.string().max(120).optional(),
  shiftId: z.string().max(64).optional(),
  hireDate: z.string().optional(),
  roles: z.array(z.string()).max(10).optional()
});

const bulkSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["activate", "suspend", "block", "disable", "terminate"]),
  reason: z.string().max(500).optional()
});

const agentStatusSchema = z.object({ status: z.enum(["offline", "available", "busy", "break"]) });
const eligibilitySchema = z.object({ eligible: z.boolean() });

const actorFrom = (request: { auth?: { userId: string; roles: string[] }; ip: string; correlationId?: string }) => ({
  id: request.auth?.userId,
  role: request.auth?.roles[0],
  ip: request.ip,
  correlationId: request.correlationId ?? undefined
});

export async function wfmRoutes(app: FastifyInstance): Promise<void> {
  // Employee search/filter
  app.get(
    "/wfm/employees",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage", "user.read"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return listEmployees({
        search: q.search,
        departmentId: q.departmentId,
        employmentStatus: q.employmentStatus,
        agentStatus: q.agentStatus,
        eligibleOnly: q.eligibleOnly === "true",
        limit: Math.min(Number(q.limit ?? 50), 200),
        offset: Number(q.offset ?? 0)
      });
    }
  );

  // Employee onboarding
  app.post(
    "/wfm/employees",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage"] })] },
    async (request) => {
      const input = onboardSchema.parse(request.body);
      const result = await onboardEmployee({ ...input, actor: actorFrom(request) });
      return result;
    }
  );

  // Activation queue
  app.get(
    "/wfm/activation-queue",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage"] })] },
    async (request) => {
      const q = request.query as Record<string, string | undefined>;
      return activationQueue({ limit: Math.min(Number(q.limit ?? 50), 200), offset: Number(q.offset ?? 0) });
    }
  );

  // Bulk lifecycle actions
  app.post(
    "/wfm/bulk-lifecycle",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage"] })] },
    async (request) => {
      const input = bulkSchema.parse(request.body);
      return bulkLifecycle({ ...input, actor: actorFrom(request) });
    }
  );

  // Absconded flow
  app.post(
    "/wfm/employees/:id/absconded",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      await markAbsconded(id, actorFrom(request));
      return { ok: true };
    }
  );

  // Access eligibility
  app.post(
    "/wfm/employees/:id/access-eligibility",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.access_eligibility.manage"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { eligible } = eligibilitySchema.parse(request.body);
      await setAccessEligibility(id, eligible, actorFrom(request));
      return { ok: true, eligible };
    }
  );

  // Own agent status
  app.post(
    "/wfm/me/status",
    { preHandler: [authenticate] },
    async (request) => {
      const { status } = agentStatusSchema.parse(request.body);
      await updateAgentStatus(request.auth!.userId, status);
      return { ok: true, status };
    }
  );

  // Employee detail: identity + sessions + activity
  app.get(
    "/wfm/employees/:id",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.employee.manage", "user.read"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { getUserDetail } = await import("../services/user.js");
      const user = await getUserDetail(id);
      if (!user || user.user_type !== "employee") throw errors.notFound("Employee not found");
      const [sessions, loginActivity] = await Promise.all([
        listUserSessions(id),
        query(
          `SELECT identifier, ip, success, failure_reason, created_at
             FROM login_attempts WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 20`,
          [id]
        )
      ]);
      return { ...user, sessions, loginActivity: loginActivity.rows };
    }
  );

  // Departments
  app.get(
    "/wfm/departments",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["user.read"] })] },
    async () => {
      const { rows } = await query("SELECT * FROM departments ORDER BY name");
      return rows;
    }
  );

  // Shifts (integration-ready seam)
  app.get(
    "/wfm/shifts",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["wfm.shift.read"] })] },
    async () => {
      const { rows } = await query(
        `SELECT DISTINCT shift_id, count(*)::int AS employees
           FROM wfm_profiles WHERE shift_id IS NOT NULL GROUP BY shift_id ORDER BY shift_id`
      );
      return rows;
    }
  );
}
