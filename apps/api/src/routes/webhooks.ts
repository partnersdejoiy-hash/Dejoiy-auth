import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../plugins/auth.js";
import {
  createEndpoint, updateEndpoint, deleteEndpoint, rotateSecret,
  listEndpoints, getDeliveryHistory, WEBHOOK_EVENTS, verifySignature
} from "../services/webhook.js";
import { errors } from "../errors.js";

const createEndpointSchema = z.object({
  url: z.string().url(),
  description: z.string().optional(),
  events: z.array(z.string()).min(1),
  applicationId: z.string().uuid().optional()
});

const updateEndpointSchema = z.object({
  url: z.string().url().optional(),
  description: z.string().optional(),
  events: z.array(z.string()).optional(),
  is_active: z.boolean().optional()
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // List webhook endpoints
  app.get("/webhooks", { preHandler: [authenticate] }, async (request) => {
    const q = z.object({ applicationId: z.string().uuid().optional() }).parse(request.query);
    return listEndpoints(q.applicationId);
  });

  // List available event types
  app.get("/webhooks/events", { preHandler: [authenticate] }, async () => ({
    events: WEBHOOK_EVENTS
  }));

  // Create webhook endpoint
  app.post("/webhooks", { preHandler: [authenticate] }, async (request, reply) => {
    const body = createEndpointSchema.parse(request.body);
    const result = await createEndpoint({
      url: body.url,
      description: body.description,
      events: body.events,
      applicationId: body.applicationId,
      createdBy: request.auth!.userId
    });
    reply.status(201);
    return result; // secret returned only on creation
  });

  // Update webhook endpoint
  app.patch("/webhooks/:id", { preHandler: [authenticate] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = updateEndpointSchema.parse(request.body);
    return updateEndpoint(id, body);
  });

  // Delete webhook endpoint
  app.delete("/webhooks/:id", { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await deleteEndpoint(id);
    reply.status(204);
  });

  // Rotate webhook secret
  app.post("/webhooks/:id/rotate-secret", { preHandler: [authenticate] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return rotateSecret(id);
  });

  // Get delivery history for an endpoint
  app.get("/webhooks/:id/deliveries", { preHandler: [authenticate] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z.object({
      limit: z.coerce.number().int().positive().default(50),
      offset: z.coerce.number().int().nonnegative().default(0)
    }).parse(request.query);
    return getDeliveryHistory(id, q.limit, q.offset);
  });

  // Test delivery — send a test event to an endpoint
  app.post("/webhooks/:id/test", { preHandler: [authenticate] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { dispatchEvent } = await import("../services/webhook.js");
    await dispatchEvent("security.alert", {
      test: true,
      message: "This is a test webhook delivery",
      timestamp: new Date().toISOString()
    });
    return { sent: true, endpointId: id };
  });

  // Verify webhook signature (utility endpoint for integrators)
  app.post("/webhooks/verify-signature", { preHandler: [authenticate] }, async (request) => {
    const body = z.object({
      secret: z.string(),
      payload: z.string(),
      signature: z.string()
    }).parse(request.body);
    return { valid: verifySignature(body.secret, body.payload, body.signature) };
  });
}
