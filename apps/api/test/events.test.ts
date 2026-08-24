import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { useTestServer, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";

useTestServer();

interface Delivery {
  body: Record<string, unknown>;
  signature: string;
  eventId: string;
}

let deliveries: Delivery[] = [];
let server: http.Server;
let url = "";

beforeAll(async () => {
  deliveries = [];
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      deliveries.push({
        body: JSON.parse(data) as Record<string, unknown>,
        signature: String(req.headers["x-dejoiy-signature"] ?? ""),
        eventId: String(req.headers["x-dejoiy-event-id"] ?? "")
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"ok\":true}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("event bus (Phases 20-23)", () => {
  it("emits user.created to subscribed webhooks with an HMAC signature", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const res = await apiRequest("POST", "/webhooks", {
      token: admin.accessToken,
      body: { url, description: "event test", events: ["user.created"] }
    });
    expect(res.status).toBe(201);
    const secret = (res.body as { secret: string }).secret;

    const before = deliveries.length;
    const created = await apiRequest("POST", "/users", {
      token: admin.accessToken,
      body: {
        email: "event.user@dejoiy.com",
        userType: "employee",
        fullName: "Event User",
        password: TEST_PASSWORD
      }
    });
    expect(created.status).toBe(200);

    await wait(400);
    const delivery = deliveries.slice(before).find((d) => d.body.event === "user.created");
    expect(delivery).toBeTruthy();
    expect(delivery!.body.event_id).toBeTruthy();
    expect((delivery!.body.data as Record<string, unknown>).email).toBe("event.user@dejoiy.com");
    expect(delivery!.eventId).toBe(delivery!.body.event_id);

    const { verifySignature } = await import("../src/services/webhook.js");
    expect(verifySignature(secret, JSON.stringify(delivery!.body), delivery!.signature)).toBe(true);
  });

  it("persists events to the event log with sanitized payloads", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    const events = await apiRequest("GET", "/events?limit=50", { token: admin.accessToken });
    expect(events.status).toBe(200);
    const list = (events.body as { rows: Array<{ event_type: string; payload: Record<string, unknown> }> }).rows;
    expect(list.some((e) => e.event_type === "user.created")).toBe(true);
    // Sanitization: secrets never persisted to the event log.
    expect(JSON.stringify(list)).not.toContain("password_hash");
  });

  it("delivers login.success on successful login", async () => {
    const admin = await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    await apiRequest("POST", "/webhooks", {
      token: admin.accessToken,
      body: { url, description: "login events", events: ["login.success"] }
    });

    const before = deliveries.length;
    await loginAs("test.admin@dejoiy.com", TEST_PASSWORD);
    await wait(400);
    const delivery = deliveries.slice(before).find((d) => d.body.event === "login.success");
    expect(delivery).toBeTruthy();
    expect((delivery!.body.data as Record<string, unknown>).userNumber).toBeTruthy();
  });
});
