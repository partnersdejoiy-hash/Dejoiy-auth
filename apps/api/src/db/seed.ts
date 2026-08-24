import { query, withTransaction } from "./pool.js";

/** Permission catalog: name -> { resource, description } */
export const PERMISSION_CATALOG: Record<string, { resource: string; description: string }> = {
  "profile.read": { resource: "profile", description: "Read own identity profile" },
  "profile.update": { resource: "profile", description: "Update own identity profile" },
  "user.read": { resource: "user", description: "View users" },
  "user.create": { resource: "user", description: "Create users" },
  "user.update": { resource: "user", description: "Update users" },
  "user.delete": { resource: "user", description: "Delete (soft) users" },
  "user.activate": { resource: "user", description: "Activate user accounts" },
  "user.suspend": { resource: "user", description: "Suspend user accounts" },
  "user.block": { resource: "user", description: "Block user accounts" },
  "user.unblock": { resource: "user", description: "Unblock user accounts" },
  "user.unlock": { resource: "user", description: "Unlock locked accounts" },
  "user.disable": { resource: "user", description: "Disable user accounts" },
  "user.terminate": { resource: "user", description: "Terminate user accounts" },
  "user.force_logout": { resource: "user", description: "Force logout a user" },
  "user.reset_password": { resource: "user", description: "Reset a user's password" },
  "user.reset_mfa": { resource: "user", description: "Reset a user's MFA" },
  "role.read": { resource: "role", description: "View roles" },
  "role.create": { resource: "role", description: "Create roles" },
  "role.update": { resource: "role", description: "Update roles" },
  "role.delete": { resource: "role", description: "Delete roles" },
  "role.assign": { resource: "role", description: "Assign roles to users" },
  "permission.read": { resource: "permission", description: "View permissions" },
  "permission.assign": { resource: "permission", description: "Assign permissions to roles" },
  "session.read": { resource: "session", description: "View sessions" },
  "session.revoke": { resource: "session", description: "Revoke sessions" },
  "session.global_logout": { resource: "session", description: "Global logout" },
  "device.read": { resource: "device", description: "View devices" },
  "device.revoke": { resource: "device", description: "Revoke devices" },
  "audit.read": { resource: "audit", description: "View audit logs" },
  "security.read": { resource: "security", description: "View security events" },
  "security.manage": { resource: "security", description: "Respond to security incidents" },
  "application.read": { resource: "application", description: "View applications" },
  "application.create": { resource: "application", description: "Create applications" },
  "application.update": { resource: "application", description: "Update applications" },
  "application.delete": { resource: "application", description: "Delete applications" },
  "oauth.client.manage": { resource: "oauth", description: "Manage OAuth clients" },
  "sync.zoho.run": { resource: "sync", description: "Run Zoho Sheet sync" },
  "sync.zoho.read": { resource: "sync", description: "View sync status" },
  "sync.zoho.update": { resource: "sync", description: "Configure Zoho sync (field mappings, mode, deletion policy)" },
  "sync.zoho.resolve": { resource: "sync", description: "Resolve Zoho sync conflicts" },
  "sync.zoho.generate": { resource: "sync", description: "Generate synthetic demo dataset" },
  "notification.read": { resource: "notification", description: "View notifications" },
  "notification.manage": { resource: "notification", description: "Manage notification providers" },
  "wfm.employee.manage": { resource: "wfm", description: "Manage WFM employee lifecycle" },
  "wfm.shift.manage": { resource: "wfm", description: "Manage shifts" },
  "wfm.shift.read": { resource: "wfm", description: "View shifts" },
  "wfm.access_eligibility.manage": { resource: "wfm", description: "Manage access eligibility" },
  "wfm.status.update": { resource: "wfm", description: "Update own agent status" },
  "customer.read": { resource: "customer", description: "View customers" },
  "customer.reset_password.request": { resource: "customer", description: "Request customer password reset" },
  "ticket.read": { resource: "ticket", description: "View tickets" },
  "ticket.update": { resource: "ticket", description: "Update tickets" },
  "seller.profile.manage": { resource: "seller", description: "Manage seller profile" },
  "order.read": { resource: "order", description: "View orders" },
  "report.read": { resource: "report", description: "View reports" },
  "auth.policy.change": { resource: "auth", description: "Change authentication policy" },
  "system.config.read": { resource: "system", description: "View system configuration" },
  "system.config.manage": { resource: "system", description: "Manage system configuration" }
};

/** role -> permissions */
export const ROLE_CATALOG: Record<string, { description: string; permissions: string[] }> = {
  SUPER_ADMIN: { description: "Platform owner with full control", permissions: [] }, // wildcard handled in code
  IT_ADMIN: {
    description: "IT operations: lifecycle, sessions, password reset authorization",
    permissions: [
      "user.read", "user.update", "user.activate", "user.suspend", "user.block", "user.unblock",
      "user.unlock", "user.disable", "user.terminate", "user.force_logout", "user.reset_password",
      "session.read", "session.revoke", "device.read", "device.revoke", "audit.read",
      "security.read", "notification.read", "system.config.read", "sync.zoho.read",
      "sync.zoho.run", "sync.zoho.update", "sync.zoho.resolve", "sync.zoho.generate"
    ]
  },
  ADMIN: {
    description: "General administration",
    permissions: [
      "user.read", "user.update", "user.activate", "user.suspend", "user.block", "user.unblock",
      "user.unlock", "user.disable", "user.force_logout", "user.reset_password",
      "role.read", "permission.read", "session.read", "session.revoke", "device.read",
      "audit.read", "security.read", "application.read", "notification.read", "report.read"
    ]
  },
  MANAGEMENT: {
    description: "Business management visibility",
    permissions: ["user.read", "role.read", "report.read"]
  },
  EMPLOYEE: {
    description: "Standard employee",
    permissions: ["profile.read", "profile.update", "wfm.status.update"]
  },
  CUSTOMER_SERVICE_ASSOCIATE: {
    description: "Support staff",
    permissions: ["customer.read", "ticket.read", "ticket.update", "customer.reset_password.request"]
  },
  SELLER: {
    description: "Marketplace seller",
    permissions: ["profile.read", "profile.update", "seller.profile.manage", "order.read"]
  },
  CUSTOMER: {
    description: "End customer",
    permissions: ["profile.read", "profile.update"]
  },
  WFM_MANAGER: {
    description: "Workforce management manager",
    permissions: [
      "wfm.employee.manage", "wfm.shift.manage", "wfm.access_eligibility.manage",
      "user.read", "role.read", "report.read"
    ]
  },
  WFM_AGENT: {
    description: "Workforce agent",
    permissions: ["profile.read", "wfm.shift.read", "wfm.status.update"]
  },
  AUDITOR: {
    description: "Read-only audit access",
    permissions: ["audit.read", "security.read", "user.read", "session.read", "device.read", "report.read"]
  },
  SECURITY_ADMIN: {
    description: "Security operations",
    permissions: [
      "security.read", "security.manage", "user.read", "user.block", "user.unblock", "user.unlock",
      "user.force_logout", "session.read", "session.revoke", "session.global_logout",
      "device.read", "device.revoke", "audit.read", "auth.policy.change"
    ]
  }
};

export const DEPARTMENT_CATALOG = [
  { name: "Engineering", code: "ENG" },
  { name: "IT Operations", code: "IT" },
  { name: "Support", code: "SUP" },
  { name: "Operations", code: "OPS" },
  { name: "Workforce Management", code: "WFM" },
  { name: "Human Resources", code: "HR" },
  { name: "Finance", code: "FIN" },
  { name: "Marketplace", code: "MKT" },
  { name: "Sales", code: "SLS" }
];

/** Idempotent seed. Safe to run repeatedly. */
export async function seed(): Promise<void> {
  await withTransaction(async (client) => {
    // Permissions
    for (const [name, meta] of Object.entries(PERMISSION_CATALOG)) {
      await client.query(
        `INSERT INTO permissions (name, resource, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET resource = EXCLUDED.resource, description = EXCLUDED.description`,
        [name, meta.resource, meta.description]
      );
    }

    // Roles + role_permissions
    for (const [roleName, meta] of Object.entries(ROLE_CATALOG)) {
      await client.query(
        `INSERT INTO roles (name, description, is_system)
         VALUES ($1, $2, true)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
        [roleName, meta.description]
      );
      if (meta.permissions.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
           WHERE r.name = $1 AND p.name = ANY($2)
           ON CONFLICT DO NOTHING`,
          [roleName, meta.permissions]
        );
      }
    }

    // Departments
    for (const dept of DEPARTMENT_CATALOG) {
      await client.query(
        `INSERT INTO departments (name, code)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        [dept.name, dept.code]
      );
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("[seed] done");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[seed] failed", err);
      process.exit(1);
    });
}
