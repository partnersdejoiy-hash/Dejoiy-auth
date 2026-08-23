# DEJOIY AUTH — RBAC

## 1. Model

```
User ──< user_roles >── Role ──< role_permissions >── Permission
```

- A **Role** is a named set of permissions (e.g. `IT_ADMIN`).
- A **Permission** is a fine-grained capability string, namespaced as `resource.action`
  (e.g. `user.delete`, `ticket.update`, `auth.policy.change`).
- Users may hold multiple roles.
- Role ↔ permission mapping is editable in the Admin panel and enforced server-side.

## 2. Built-in roles

| Role | Purpose | Typical permissions |
| --- | --- | --- |
| `SUPER_ADMIN` | Platform owner. Full control incl. bootstrap, secrets policy, global logout | `*` |
| `IT_ADMIN` | IT operations: activation, blocking, unlocking, password-reset authorization, sessions | `user.manage`, `user.activate`, `user.block`, `user.unlock`, `user.force_logout`, `session.manage`, `user.reset_password` |
| `ADMIN` | General administration within delegated scope | `user.read`, `user.update`, `role.read`, `audit.read` |
| `MANAGEMENT` | Business management visibility | `user.read`, `report.read` |
| `EMPLOYEE` | Standard employee identity | `profile.read`, `profile.update` |
| `CUSTOMER_SERVICE_ASSOCIATE` | Support staff | `customer.read`, `ticket.read`, `ticket.update`, `customer.reset_password.request` |
| `SELLER` | Marketplace sellers | `seller.profile.manage`, `order.read` |
| `CUSTOMER` | End customers | `profile.read`, `profile.update` |
| `WFM_MANAGER` | Workforce management | `employee.manage`, `wfm.shift.manage`, `wfm.access_eligibility.manage` |
| `WFM_AGENT` | Workforce agent | `wfm.shift.read`, `wfm.status.update` |
| `AUDITOR` | Read-only audit access | `audit.read`, `security.read` |
| `SECURITY_ADMIN` | Security operations | `security.manage`, `security.read`, `user.block`, `user.force_logout`, `session.manage` |

## 3. Permission catalog (initial seed)

| Permission | Description |
| --- | --- |
| `profile.read` / `profile.update` | Own identity profile |
| `user.read` / `user.create` / `user.update` / `user.delete` | User management |
| `user.activate` / `user.suspend` / `user.block` / `user.unblock` / `user.unlock` / `user.disable` / `user.terminate` | Lifecycle |
| `user.force_logout` / `user.reset_password` / `user.reset_mfa` | Privileged actions |
| `role.read` / `role.create` / `role.update` / `role.delete` / `role.assign` | Role management |
| `permission.read` / `permission.assign` | Permission management |
| `session.read` / `session.revoke` / `session.global_logout` | Sessions |
| `device.read` / `device.revoke` | Devices |
| `audit.read` | Audit logs |
| `security.read` / `security.manage` | Security events + response |
| `application.read` / `application.create` / `application.update` / `application.delete` | App registry |
| `oauth.client.manage` | OAuth clients |
| `sync.zoho.run` / `sync.zoho.read` | Zoho sync |
| `notification.read` / `notification.manage` | Notifications |
| `wfm.employee.manage` / `wfm.shift.manage` / `wfm.access_eligibility.manage` / `wfm.status.update` | WFM |
| `customer.read` / `ticket.read` / `ticket.update` / `customer.reset_password.request` | CSA |
| `seller.profile.manage` / `order.read` | Seller |
| `report.read` | Reporting |
| `auth.policy.change` | Password/session policy changes |
| `system.config.read` / `system.config.manage` | System config |
| `*` | Super admin wildcard |

## 4. Creating additional roles

Via the Admin panel → Access/Identity → Roles → Create, or the API:

```
POST /api/v1/roles
{ "name": "OPERATIONS_MANAGER", "description": "...", "permissions": ["user.read","report.read"] }
```

## 5. Creating additional permissions

```
POST /api/v1/permissions
{ "name": "billing.invoice.refund", "description": "Refund invoices", "resource": "billing" }
```

New permissions are inert until assigned to a role. Keep names `resource.action` and document them here.

## 6. Enforcement

- Route declarations carry `permissions: ["user.delete"]`.
- The `requirePermissions` hook resolves the caller's roles → permissions and rejects with 403 when
  missing (404 for targets the caller may not know exist, to reduce enumeration).
- `SUPER_ADMIN` carries wildcard `*`.
- Privileged roles (`SUPER_ADMIN`, `IT_ADMIN`, `SECURITY_ADMIN`, `AUDITOR`) may be subject to a stricter
  password policy (`PRIVILEGED_ROLES` env) and MFA/re-auth requirements.
