import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { acquireLock, releaseLock } from "../redis.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";
import { errors } from "../errors.js";

/**
 * Synthetic demo dataset generator (Phase 11).
 *
 * Generates realistic enterprise-scale sample data bounded to a safe maximum
 * (default 50,000 — Zoho Sheet practical limits). All generated users are
 * clearly marked metadata.synthetic = true and use the dejoiy.local domain so
 * they can never be confused with real people or receive real mail.
 *
 * Processing runs in the background with progress persisted on
 * demo_generation_jobs (queued → running → success | failed).
 */

const FIRST_NAMES = [
  "Aarav", "Diya", "Ishaan", "Ananya", "Vihaan", "Kavya", "Aditya", "Saanvi",
  "Arjun", "Priya", "Rohan", "Meera", "Kabir", "Anika", "Dev", "Riya",
  "Aryan", "Isha", "Rahul", "Neha", "Karan", "Pooja", "Nikhil", "Shreya",
  "Varun", "Tanvi", "Siddharth", "Aisha", "Manav", "Kriti"
];

const LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Reddy", "Nair", "Iyer", "Gupta", "Mehta",
  "Khan", "Singh", "Kumar", "Das", "Bose", "Menon", "Pillai", "Rao",
  "Chopra", "Malhotra", "Joshi", "Bhatt", "Desai", "Saxena", "Kulkarni",
  "Srivastava", "Agarwal", "Mishra", "Tiwari", "Pandey", "Chauhan", "Yadav"
];

const DESIGNATIONS = [
  "Software Engineer", "Senior Software Engineer", "QA Engineer", "DevOps Engineer",
  "Technical Support", "Customer Success Manager", "Operations Executive",
  "Workforce Analyst", "HR Associate", "Finance Executive", "Sales Associate",
  "Product Manager", "Data Analyst", "Security Analyst", "Network Administrator"
];

const BATCH_SIZE = 500;

const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=3,p=1$c3ludGhldGljLWRlbW8$bm90LWEtcmVhbC1jcmVkZW50aWFs"; // never usable

export interface DemoJob {
  id: string;
  status: string;
  requested: number;
  inserted: number;
  updated: number;
  failed: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Validate and queue a demo generation job. Processing is backgrounded. */
export async function queueDemoGeneration(
  count: number,
  createdBy: string
): Promise<{ jobId: string }> {
  const max = getConfig().ZOHO_DEMO_MAX_RECORDS;
  if (!Number.isInteger(count) || count < 100 || count > max) {
    throw errors.badRequest(`count must be an integer between 100 and ${max}`);
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO demo_generation_jobs (status, requested, created_by)
     VALUES ('queued', $1, $2) RETURNING id`,
    [count, createdBy]
  );
  const jobId = rows[0]!.id;

  // Background processing — never blocks the request.
  void processDemoGeneration(jobId).catch((err) => {
    logger.error({ jobId, err }, "demo generation crashed");
  });

  await recordAudit({
    actorUserId: createdBy,
    action: "ZOHO_DEMO_GENERATION_QUEUED",
    targetType: "demo_generation_job",
    targetId: jobId,
    after: { requested: count }
  });

  return { jobId };
}

export async function getDemoGenerationJob(jobId: string): Promise<DemoJob | null> {
  const { rows } = await query<DemoJob>(
    `SELECT id, status, requested, inserted, updated, failed, error,
            created_by, created_at, finished_at
       FROM demo_generation_jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] ?? null;
}

async function processDemoGeneration(jobId: string): Promise<void> {
  const lockAcquired = await acquireLock("zoho-demo-gen", 600);
  if (!lockAcquired) {
    await query(
      `UPDATE demo_generation_jobs SET status = 'failed', error = 'another generation is already running', finished_at = now()
       WHERE id = $1`,
      [jobId]
    );
    return;
  }

  try {
    const { rows } = await query<{ requested: number }>(
      `UPDATE demo_generation_jobs SET status = 'running' WHERE id = $1 RETURNING requested`,
      [jobId]
    );
    if (rows.length === 0) return;
    const requested = rows[0]!.requested;

    const { rows: deptRows } = await query<{ id: string }>(
      `SELECT id FROM departments ORDER BY name`
    );
    const departments = deptRows.map((r) => r.id);
    const { rows: roleRows } = await query<{ id: string }>(
      `SELECT id FROM roles WHERE name = 'EMPLOYEE'`
    );
    const employeeRoleId = roleRows[0]?.id ?? null;

    let inserted = 0;
    let updated = 0;

    for (let start = 1; start <= requested; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, requested);
      const insertedThisBatch = await insertBatch(start, end, jobId, departments, employeeRoleId);
      inserted += insertedThisBatch.inserted;
      updated += insertedThisBatch.updated;

      await query(
        `UPDATE demo_generation_jobs SET inserted = $1, updated = $2 WHERE id = $3`,
        [inserted, updated, jobId]
      );
    }

    await query(
      `UPDATE demo_generation_jobs SET status = 'success', finished_at = now() WHERE id = $1`,
      [jobId]
    );
    logger.info({ jobId, inserted, updated }, "demo generation completed");
  } catch (err) {
    logger.error({ jobId, err }, "demo generation failed");
    await query(
      `UPDATE demo_generation_jobs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2`,
      [String(err).slice(0, 500), jobId]
    );
  } finally {
    await releaseLock("zoho-demo-gen");
  }
}

async function insertBatch(
  start: number,
  end: number,
  jobId: string,
  departments: string[],
  employeeRoleId: string | null
): Promise<{ inserted: number; updated: number }> {
  const userIds: string[] = [];
  let inserted = 0;
  let updated = 0;

  const { rows } = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO users (user_number, user_type, email, phone, username, password_hash,
                        account_state, mfa_enabled, metadata, created_by)
     SELECT * FROM unnest($1::text[], $2::user_type[], $3::citext[], $4::text[],
                          $5::text[], $6::text[], $7::account_state[], $8::boolean[],
                          $9::jsonb[], $10::uuid[])
     ON CONFLICT (user_number) DO UPDATE SET
       email = EXCLUDED.email, phone = EXCLUDED.phone, username = EXCLUDED.username,
       metadata = EXCLUDED.metadata, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      numbers(start, end),
      Array.from({ length: end - start + 1 }, () => "employee"),
      emails(start, end),
      phones(start, end),
      usernames(start, end),
      Array.from({ length: end - start + 1 }, () => DUMMY_HASH),
      Array.from({ length: end - start + 1 }, (_, i) => (i % 12 === 0 ? "PENDING" : "ACTIVE")),
      Array.from({ length: end - start + 1 }, (_, i) => i % 7 === 0),
      Array.from({ length: end - start + 1 }, () => JSON.stringify({ synthetic: true, demoJobId: jobId })),
      Array.from({ length: end - start + 1 }, () => null)
    ]
  );

  for (const row of rows) {
    userIds.push(row.id);
    if (row.inserted) inserted++;
    else updated++;
  }

  if (userIds.length === 0) return { inserted, updated };

  // Profiles + employee records (one query each, unnest).
  await query(
    `INSERT INTO user_profiles (user_id, full_name)
     SELECT * FROM unnest($1::uuid[], $2::text[])
     ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()`,
    [userIds, names(start, end)]
  );

  await query(
    `INSERT INTO employee_profiles (user_id, employee_id, department_id, designation,
                                    hire_date, employment_status)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::date[], $6::text[])
     ON CONFLICT (user_id) DO UPDATE SET
       employee_id = EXCLUDED.employee_id, department_id = EXCLUDED.department_id,
       designation = EXCLUDED.designation, hire_date = EXCLUDED.hire_date,
       employment_status = EXCLUDED.employment_status, updated_at = now()`,
    [
      userIds,
      employeeIds(start, end),
      userIds.map((_, i) => departments[i % departments.length] ?? null),
      userIds.map((_, i) => DESIGNATIONS[i % DESIGNATIONS.length]!),
      userIds.map((_, i) => hireDate(i)),
      Array.from({ length: userIds.length }, () => "active")
    ]
  );

  if (employeeRoleId) {
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT * FROM unnest($1::uuid[], $2::uuid[])
       ON CONFLICT DO NOTHING`,
      [userIds, Array.from({ length: userIds.length }, () => employeeRoleId)]
    );
  }

  return { inserted, updated };
}

// ── Synthetic value builders (deterministic, no real PII) ─────────────────

function pad(n: number, width = 6): string {
  return String(n).padStart(width, "0");
}

function numbers(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`DJY-DEMO-${pad(i)}`);
  return out;
}

function emails(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`demo.${pad(i)}@dejoiy.local`);
  return out;
}

function usernames(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`demo_${pad(i)}`);
  return out;
}

function phones(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`+91${String(9_900_000_000 + i).slice(0, 10)}`);
  return out;
}

function names(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const last = LAST_NAMES[(i * 7) % LAST_NAMES.length]!;
    out.push(`${first} ${last}`);
  }
  return out;
}

function employeeIds(start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`EMP-DEMO-${pad(i)}`);
  return out;
}

function hireDate(index: number): string {
  const base = new Date("2021-01-01");
  base.setDate(base.getDate() + (index * 3) % 1400);
  return base.toISOString().slice(0, 10);
}
