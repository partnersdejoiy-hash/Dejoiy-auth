import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bootstrapSuperAdmin } from "../services/bootstrap.js";

const bootstrapSchema = z.object({
  email: z.string().email(),
  bootstrapSecret: z.string().min(8),
  password: z.string().min(8).max(512),
  fullName: z.string().max(200).optional()
});

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.post("/bootstrap/super-admin", async (request) => {
    const input = bootstrapSchema.parse(request.body);
    return bootstrapSuperAdmin(input);
  });
}
