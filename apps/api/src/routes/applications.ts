import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { randomToken } from "../crypto.js";
import { createOAuthClient, getClientByClientId } from "../services/oauth.js";
import { authenticate, requirePermissions } from "../plugins/auth.js";
import { recordAudit } from "../services/audit.js";
import { emitEvent } from "../services/events.js";
import { errors } from "../errors.js";

const applicationSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(["web", "spa", "native", "service"]).default("web"),
  description: z.string().max(1000).optional(),
  redirectUris: z.array(z.string().url()).default([]),
  allowedOrigins: z.array(z.string().url()).default([]),
  defaultScopes: z.array(z.string()).default(["openid", "profile", "email"])
});

export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/applications",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["application.read"] })] },
    async () => {
      const { rows } = await query(
        `SELECT a.*, c.client_id FROM applications a
           LEFT JOIN oauth_clients c ON c.application_id = a.id
          WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC`
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        redirectUris: r.redirect_uris,
        allowedOrigins: r.allowed_origins,
        defaultScopes: r.default_scopes,
        status: r.status,
        clientId: r.client_id,
        createdAt: r.created_at
      }));
    }
  );

  app.post(
    "/applications",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["application.create"] })] },
    async (request) => {
      const input = applicationSchema.parse(request.body);
      const clientSecret = randomToken(32);
      const clientId = `dj_${randomToken(12)}`;

      const { rows } = await query<{ id: string }>(
        `INSERT INTO applications (name, type, description, redirect_uris, allowed_origins, default_scopes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.name,
          input.type,
          input.description ?? null,
          JSON.stringify(input.redirectUris),
          JSON.stringify(input.allowedOrigins),
          JSON.stringify(input.defaultScopes),
          request.auth!.userId
        ]
      );
      const appRow = rows[0]!;
      await createOAuthClient({
        applicationId: appRow.id,
        clientId,
        clientSecret,
        grantTypes: input.type === "service" ? ["client_credentials"] : ["authorization_code", "refresh_token"]
      });

      await recordAudit({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.roles[0],
        action: "APPLICATION_CREATED",
        targetType: "application",
        targetId: appRow.id,
        targetLabel: input.name,
        correlationId: request.correlationId,
        ip: request.ip,
        after: { type: input.type, clientId }
      });
      await emitEvent("application.created", {
        applicationId: appRow.id,
        name: input.name,
        type: input.type,
        clientId
      }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
      await emitEvent("oauth.client.created", {
        applicationId: appRow.id,
        name: input.name,
        clientId
      }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });

      return { id: appRow.id, clientId, clientSecret };
    }
  );

  app.patch(
    "/applications/:id",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["application.update"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = z.object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1000).nullable().optional(),
        redirectUris: z.array(z.string().url()).optional(),
        allowedOrigins: z.array(z.string().url()).optional(),
        defaultScopes: z.array(z.string()).optional(),
        status: z.enum(["active", "disabled"]).optional()
      }).parse(request.body);

      const { rows } = await query(
        `UPDATE applications SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           redirect_uris = COALESCE($4::jsonb, redirect_uris),
           allowed_origins = COALESCE($5::jsonb, allowed_origins),
           default_scopes = COALESCE($6::jsonb, default_scopes),
           status = COALESCE($7, status)
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [
          id,
          body.name ?? null,
          body.description === undefined ? null : body.description,
          body.redirectUris ? JSON.stringify(body.redirectUris) : null,
          body.allowedOrigins ? JSON.stringify(body.allowedOrigins) : null,
          body.defaultScopes ? JSON.stringify(body.defaultScopes) : null,
          body.status ?? null
        ]
      );
      if (rows.length === 0) throw errors.notFound("Application not found");
      await recordAudit({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.roles[0],
        action: "APPLICATION_UPDATED",
        targetType: "application",
        targetId: id,
        correlationId: request.correlationId,
        ip: request.ip
      });
      await emitEvent(
        body.status === "disabled" ? "application.disabled" : "application.updated",
        {
          applicationId: id,
          name: rows[0]?.name ?? null,
          status: body.status ?? "active"
        },
        { correlationId: request.correlationId, actorUserId: request.auth!.userId }
      );
      return { ok: true };
    }
  );

  app.delete(
    "/applications/:id",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["application.delete"] })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { rows: deleted } = await query<{ name: string }>(
        "UPDATE applications SET deleted_at = now() WHERE id = $1 RETURNING name", [id]
      );
      if (deleted.length === 0) throw errors.notFound("Application not found");
      await recordAudit({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.roles[0],
        action: "APPLICATION_DELETED",
        targetType: "application",
        targetId: id,
        correlationId: request.correlationId,
        ip: request.ip
      });
      await emitEvent("application.disabled", {
        applicationId: id,
        name: deleted[0]!.name,
        deleted: true
      }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
      return { ok: true };
    }
  );

  // Rotate a client secret
  app.post(
    "/oauth/clients/:clientId/rotate-secret",
    { preHandler: [authenticate, async (r) => requirePermissions(r, { permissions: ["oauth.client.manage"] })] },
    async (request) => {
      const { clientId } = request.params as { clientId: string };
      const client = await getClientByClientId(clientId);
      if (!client) throw errors.notFound("OAuth client not found");
      const { hashToken } = await import("../crypto.js");
      const newSecret = randomToken(32);
      await query("UPDATE oauth_clients SET client_secret_hash = $1 WHERE id = $2", [hashToken(newSecret), client.id]);
      await recordAudit({
        actorUserId: request.auth!.userId,
        actorRole: request.auth!.roles[0],
        action: "OAUTH_SECRET_ROTATED",
        targetType: "oauth_client",
        targetId: client.id,
        correlationId: request.correlationId,
        ip: request.ip
      });
      await emitEvent("oauth.client.secret_rotated", {
        clientId,
        applicationId: client.application_id
      }, { correlationId: request.correlationId, actorUserId: request.auth!.userId });
      return { clientId, clientSecret: newSecret };
    }
  );
}
