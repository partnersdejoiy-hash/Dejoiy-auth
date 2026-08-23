import { describe, expect, it } from "vitest";
import { useTestServer, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";

useTestServer();

describe("RBAC enforcement", () => {
  it("super admin can create users", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: { userType: "employee", email: "emp.1@dejoiy.com", fullName: "Emp One", roles: ["EMPLOYEE"] }
    });
    expect(res.status).toBe(200);
  });

  it("customer cannot access user management (403)", async () => {
    // Create a customer account
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "customer", email: "cust.1@dejoiy.com", fullName: "Cust One",
        password: TEST_PASSWORD, roles: ["CUSTOMER"]
      }
    });
    expect(created.status).toBe(200);

    const cust = await loginAs("cust.1@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("GET", "/users", { token: cust.accessToken });
    expect(res.status).toBe(403);

    const res2 = await apiRequest("GET", "/roles", { token: cust.accessToken });
    expect(res2.status).toBe(403);
  });

  it("permission escalation attempt is denied", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "customer", email: "cust.2@dejoiy.com", fullName: "Cust Two",
        password: TEST_PASSWORD, roles: ["CUSTOMER"]
      }
    });
    expect(created.status).toBe(200);

    // Customer tries to assign itself SUPER_ADMIN — needs role.assign
    const cust = await loginAs("cust.2@dejoiy.com", TEST_PASSWORD);
    const escalate = await apiRequest("POST", `/users/${cust.user.id}/roles`, {
      token: cust.accessToken,
      body: { roles: ["SUPER_ADMIN"] }
    });
    expect(escalate.status).toBe(403);
  });

  it("custom role with narrow permissions works", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const roleName = `TICKET_READER_${Date.now()}`;
    const roleRes = await apiRequest("POST", "/roles", {
      token: admin.accessToken,
      body: { name: roleName, description: "Reads tickets only", permissions: ["ticket.read"] }
    });
    expect(roleRes.status).toBe(200);

    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "employee", email: "reader@dejoiy.com", fullName: "Reader",
        password: TEST_PASSWORD, roles: [roleName]
      }
    });
    expect(created.status).toBe(200);

    const reader = await loginAs("reader@dejoiy.com", TEST_PASSWORD);
    // ticket.read exists as a permission but no /tickets route — verify deny on /users
    const users = await apiRequest("GET", "/users", { token: reader.accessToken });
    expect(users.status).toBe(403);
    // Profile endpoints are open to any authenticated user
    const me = await apiRequest("GET", "/auth/me", { token: reader.accessToken });
    expect(me.status).toBe(200);
  });

  it("cannot strip the last super admin role", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("POST", `/users/${admin.user.id}/roles`, {
      token: admin.accessToken,
      body: { roles: [] }
    });
    expect(res.status).toBe(409); // last-super-admin guard
  });
});
