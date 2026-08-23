import { describe, expect, it } from "vitest";
import { useTestServer, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";

useTestServer();

describe("WFM panel", () => {
  it("onboards an employee into the activation queue", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("POST", "/wfm/employees", {
      token: admin.accessToken,
      body: {
        email: "wfm.emp1@dejoiy.com",
        fullName: "WFM Emp",
        employeeId: "EMP-9001",
        designation: "WFM Agent",
        roles: ["WFM_AGENT"]
      }
    });
    expect(res.status).toBe(200);

    const queue = await apiRequest("GET", "/wfm/activation-queue", {
      token: admin.accessToken
    });
    expect(queue.status).toBe(200);
    const items = queue.body as Array<{ employee_id: string }>;
    expect(items.some((i) => i.employee_id === "EMP-9001")).toBe(true);
  });

  it("bulk lifecycle processes selected employees", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await apiRequest("POST", "/wfm/employees", {
        token: admin.accessToken,
        body: {
          email: `bulk.${i}@dejoiy.com`,
          fullName: `Bulk ${i}`,
          employeeId: `EMP-B${i}`
        }
      });
      ids.push((res.body as { id: string }).id);
    }
    const bulk = await apiRequest("POST", "/wfm/bulk-lifecycle", {
      token: admin.accessToken,
      body: { userIds: ids, action: "activate", reason: "test" }
    });
    expect(bulk.status).toBe(200);
    expect((bulk.body as { processed: number }).processed).toBe(2);
  });

  it("WFM agent cannot manage employees (no wfm.employee.manage)", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "employee", email: "agent.1@dejoiy.com", fullName: "Agent One",
        password: TEST_PASSWORD, roles: ["WFM_AGENT"]
      }
    });
    expect(created.status).toBe(200);

    const agent = await loginAs("agent.1@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("GET", "/wfm/employees", { token: agent.accessToken });
    expect(res.status).toBe(403);
  });
});

describe("session lifecycle", () => {
  it("admin can force logout another user", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "employee", email: "victim.1@dejoiy.com", fullName: "Victim",
        password: TEST_PASSWORD, roles: ["EMPLOYEE"]
      }
    });
    const victim = await loginAs("victim.1@dejoiy.com", TEST_PASSWORD);
    expect(victim.accessToken).toBeTruthy();

    const userId = (created.body as { id: string }).id;
    const force = await apiRequest("POST", `/users/${userId}/force-logout`, {
      token: admin.accessToken,
      body: {}
    });
    expect(force.status).toBe(200);

    const me = await apiRequest("GET", "/auth/me", { token: victim.accessToken });
    expect(me.status).toBe(401);
  });
});
