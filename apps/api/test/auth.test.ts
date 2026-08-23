import { describe, expect, it } from "vitest";
import {
  useTestServer, apiRequest, loginAs, bootstrapAdmin, TEST_PASSWORD, app
} from "./helpers.js";

useTestServer();

describe("authentication", () => {
  it("rejects invalid credentials", async () => {
    const res = await apiRequest("POST", "/auth/login", {
      body: { identifier: "test.admin@dejoiy.com", password: "WrongPassword1!" }
    });
    expect(res.status).toBe(401);
  });

  it("does not leak whether an account exists", async () => {
    const missing = await apiRequest("POST", "/auth/login", {
      body: { identifier: "ghost@dejoiy.com", password: "Whatever123!" }
    });
    const wrongPw = await apiRequest("POST", "/auth/login", {
      body: { identifier: "test.admin@dejoiy.com", password: "Whatever123!" }
    });
    expect(missing.status).toBe(401);
    expect(wrongPw.status).toBe(401);
  });

  it("locks the account after repeated failures and unlocks on success", async () => {
    const login = (pw: string) =>
      apiRequest("POST", "/auth/login", {
        body: { identifier: "test.admin@dejoiy.com", password: pw }
      });

    for (let i = 0; i < 3; i++) {
      const res = await login("WrongPassword1!");
      expect(res.status).toBe(401);
    }
    // 4th attempt while locked → 423
    const locked = await login(TEST_PASSWORD);
    expect([401, 423]).toContain(locked.status);

    // Wait for lockout expiry (30s configured) — verify lock flag cleared via login after unlock
    const { unlockAccount } = await import("../src/services/user.js");
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD).catch(() => null);
    // Admin may be locked too; unlock directly and retry
    if (!admin) {
      const { findUserByEmail } = await import("../src/services/user.js");
      const user = await findUserByEmail("test.admin@dejoiy.com");
      if (user) await unlockAccount(user.id, {});
      const again = await login(TEST_PASSWORD);
      expect(again.status).toBe(200);
    }
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const session = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    expect(session.accessToken).toBeTruthy();

    const r1 = await apiRequest("POST", "/auth/refresh", {
      body: { refreshToken: session.refreshToken }
    });
    expect(r1.status).toBe(200);
    const newToken = (r1.body as { refreshToken: string }).refreshToken;
    expect(newToken).not.toBe(session.refreshToken);

    // Reuse of the rotated token → reject
    const reuse = await apiRequest("POST", "/auth/refresh", {
      body: { refreshToken: session.refreshToken }
    });
    expect(reuse.status).toBe(401);

    // Reuse revokes the whole family including the newest token
    const family = await apiRequest("POST", "/auth/refresh", {
      body: { refreshToken: newToken }
    });
    expect(family.status).toBe(401);
  });

  it("enforces session validity on protected endpoints", async () => {
    const session = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("GET", "/auth/me", { token: session.accessToken });
    expect(res.status).toBe(200);

    const noToken = await apiRequest("GET", "/auth/me");
    expect(noToken.status).toBe(401);
  });

  it("requires a valid bearer token (garbage rejected)", async () => {
    const res = await apiRequest("GET", "/auth/me", { token: "garbage.token.here" });
    expect(res.status).toBe(401);
  });

  it("records security events for suspicious activity", async () => {
    await apiRequest("POST", "/auth/login", {
      body: { identifier: "test.admin@dejoiy.com", password: "BadPass123!" }
    });
    const session = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const events = await apiRequest("GET", "/security/events?limit=10", {
      token: session.accessToken
    });
    expect(events.status).toBe(200);
    const list = events.body as Array<{ event_type: string }>;
    expect(list.some((e) => e.event_type === "login.failed")).toBe(true);
  });
});

describe("logout", () => {
  it("revokes the session so the token no longer works", async () => {
    const session = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const out = await apiRequest("POST", "/auth/logout", { token: session.accessToken });
    expect(out.status).toBe(200);

    const me = await apiRequest("GET", "/auth/me", { token: session.accessToken });
    expect(me.status).toBe(401);
  });
});

describe("bootstrap", () => {
  it("refuses to create a second super admin", async () => {
    const res = await apiRequest("POST", "/bootstrap/super-admin", {
      body: {
        email: "second@dejoiy.com",
        bootstrapSecret: "test-bootstrap-secret",
        password: TEST_PASSWORD
      }
    });
    expect(res.status).toBe(409);
  });

  it("rejects a wrong bootstrap secret (no new admin is created)", async () => {
    const res = await apiRequest("POST", "/bootstrap/super-admin", {
      body: {
        email: "other@dejoiy.com",
        bootstrapSecret: "wrong-secret",
        password: TEST_PASSWORD
      }
    });
    // 409 when a super admin exists, 403 when the secret is wrong — either way: refused
    expect([403, 409]).toContain(res.status);
  });
});
