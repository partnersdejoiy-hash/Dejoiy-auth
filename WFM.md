# DEJOIY AUTH — WFM Panel

The WFM panel manages the **employee-centric identity lifecycle**:

```
Employee ID → Identity → Department → Role → Manager → Status → Shift → Sessions → Access
```

## Concepts

- **Onboarding** creates the identity in `PENDING` state — it lands in the **activation queue**.
  No sign-in is possible until an authorized user activates it (grants `ACTIVE`).
- **Deactivation / termination** moves the account to `DISABLED` / `TERMINATED` and records the
  termination date on the employee profile.
- **Absconded flow**: marks `employment_status = absconded`, revokes access eligibility, flips agent
  status to offline, and disables the account — one audited action.
- **Shift-linked access**: `wfm_profiles.shift_id` + `access_eligibility`. Integration-ready seam for
  attendance/WFM providers (DEJOIY BPO / WFM systems can map their shift identifiers).
- **Bulk lifecycle** applies `activate | suspend | block | disable | terminate` to a list of users with
  per-user results and a single audit entry (`BULK_*`).

## Roles

| Role | Capabilities |
| --- | --- |
| `WFM_MANAGER` | `wfm.employee.manage`, `wfm.shift.manage`, `wfm.access_eligibility.manage`, `user.read`, `report.read` |
| `WFM_AGENT` | `profile.read`, `wfm.shift.read`, `wfm.status.update` (own agent status) |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /wfm/employees` | Search/filter: `search`, `departmentId`, `employmentStatus`, `agentStatus`, `eligibleOnly` |
| `POST /wfm/employees` | Onboard (email, fullName, employeeId, departmentId, managerId, designation, shiftId, roles) |
| `GET /wfm/activation-queue` | Pending identities |
| `POST /wfm/bulk-lifecycle` | Bulk state changes with audit |
| `POST /wfm/employees/:id/absconded` | Absconded disable flow |
| `POST /wfm/employees/:id/access-eligibility` | Grant/revoke access eligibility |
| `POST /wfm/me/status` | Agent self-status (`offline|available|busy|break`) |
| `GET /wfm/employees/:id` | Detail + sessions + login activity |

## Privacy

Employee records in the WFM panel never expose passwords, tokens or MFA secrets. Login activity shows
only safe metadata (IP-less summaries, timestamps, success/failure).

## Attendance/WFM integration

The `attendance_provider_id` field on `wfm_profiles` is the seam for future attendance/WFM providers:
map your external agent id to the DEJOIY identity without changing auth logic.
