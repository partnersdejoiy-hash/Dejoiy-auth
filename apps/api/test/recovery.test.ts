import { describe, expect, it } from "vitest";
import { useTestServer, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";
import { evaluatePassword } from "../src/services/password.js";

useTestServer();

describe("password recovery", () => {
  it("forgot-password returns a uniform response (no enumeration)", async () => {
    const existing = await apiRequest("POST", "/auth/forgot-password", {
      body: { email: "test.admin@dejoiy.com" }
    });
    const ghost = await apiRequest("POST", "/auth/forgot-password", {
      body: { email: "nobody@dejoiy.com" }
    });
    expect(existing.status).toBe(200);
    expect(ghost.status).toBe(200);
  });

  it("reset token can be used exactly once", async () => {
    // Create a dedicated user so Redis reset rate-limit keys from earlier tests don't collide
    const { query } = await import("../src/db/pool.js");
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        userType: "employee", email: "recovery.user@dejoiy.com", fullName: "Recovery User",
        password: TEST_PASSWORD, roles: ["EMPLOYEE"]
      }
    });
    expect(created.status).toBe(200);

    // Issue a reset token directly through the service (fresh email → no rate-limit key)
    const { forgotPassword } = await import("../src/services/auth.js");
    await forgotPassword("recovery.user@dejoiy.com", { ip: "127.0.0.1", userAgent: null, correlationId: null });

    const { randomToken, hashToken } = await import("../src/crypto.js");
    const { findUserByEmail } = await import("../src/services/user.js");
    const user = await findUserByEmail("recovery.user@dejoiy.com");
    const token = randomToken(32);
    await query(
      `INSERT INTO password_resets (user_id, token_hash, reset_type, expires_at)
       VALUES ($1,$2,'self', now() + interval '15 minutes')`,
      [user!.id, hashToken(token)]
    );

    const newPassword = "New#Secure2026!Vault";
    const first = await apiRequest("POST", "/auth/reset-password", {
      body: { token, password: newPassword }
    });
    expect(first.status).toBe(200);

    // Second use of the same token → rejected
    const second = await apiRequest("POST", "/auth/reset-password", {
      body: { token, password: TEST_PASSWORD }
    });
    expect(second.status).toBe(401);

    // New password works
    const login = await loginAs("recovery.user@dejoiy.com", newPassword);
    expect(login.accessToken).toBeTruthy();
  });

  it("resetting a password revokes other sessions", async () => {
    const session = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const { query } = await import("../src/db/pool.js");
    const { randomToken, hashToken } = await import("../src/crypto.js");
    const { findUserByEmail } = await import("../src/services/user.js");
    const user = await findUserByEmail("test.admin@dejoiy.com");
    const token = randomToken(32);
    await query(
      `INSERT INTO password_resets (user_id, token_hash, reset_type, expires_at)
       VALUES ($1,$2,'self', now() + interval '15 minutes')`,
      [user!.id, hashToken(token)]
    );
    await apiRequest("POST", "/auth/reset-password", {
      body: { token, password: "Another#Secure2026!Vault" }
    });

    const me = await apiRequest("GET", "/auth/me", { token: session.accessToken });
    expect(me.status).toBe(401);
  });
});

describe("password policy", () => {
  it("rejects weak passwords", () => {
    const check = evaluatePassword("short");
    expect(check.ok).toBe(false);
    expect(check.errors.length).toBeGreaterThan(0);
  });

  it("rejects common passwords", () => {
    expect(evaluatePassword("Password123!").ok).toBe(false);
  });

  it("rejects company-name passwords", () => {
    expect(evaluatePassword("Dejoiy#Secure2026!").ok).toBe(false);
  });

  it("rejects sequential and repeated patterns", () => {
    expect(evaluatePassword("Abcd1234!Wxyz5678").ok).toBe(false);
    expect(evaluatePassword("AAAABbbb!Cccc1111").ok).toBe(false);
  });

  it("accepts a strong password", () => {
    const check = evaluatePassword("Xy9#Secure2026!Vault");
    expect(check.ok).toBe(true);
  });
});
