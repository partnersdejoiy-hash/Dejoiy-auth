import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getConfig } from "../config.js";
import { authenticate } from "../plugins/auth.js";
import { buildUserPayload } from "../services/auth.js";
import {
  getClientByClientId, verifyClientSecret, validateRedirectUri, getApplicationScopes,
  issueAuthorizationCode, exchangeAuthorizationCode, exchangeClientCredentials, pkceChallenge
} from "../services/oauth.js";
import { getJWKS } from "../services/jwt.js";
import { errors } from "../errors.js";
import { randomToken } from "../crypto.js";

const authorizeQuerySchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  response_type: z.enum(["code"]),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(["S256", "plain"]).optional(),
  nonce: z.string().optional()
});

const tokenBodySchema = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token", "client_credentials"]),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional()
});

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  // Discovery document
  app.get("/oidc/.well-known/openid-configuration", async () => {
    const cfg = getConfig();
    const base = `${cfg.OIDC_ISSUER_URL}/api/v1/oidc`;
    return {
      issuer: cfg.OIDC_ISSUER_URL,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      userinfo_endpoint: `${base}/userinfo`,
      jwks_uri: `${base}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256", "plain"],
      scopes_supported: ["openid", "profile", "email"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
      claims_supported: ["sub", "name", "email", "role", "userNumber"]
    };
  });

  // Authorization endpoint (browser redirect flow)
  app.get("/oidc/authorize", { preHandler: [authenticate] }, async (request, reply) => {
    const q = authorizeQuerySchema.parse(request.query);
    const client = await getClientByClientId(q.client_id);
    if (!client) throw errors.unauthorized("Unknown client_id");

    const appScopes = await getApplicationScopes(client.application_id);
    const requestedScopes = (q.scope ?? "openid").split(" ").filter(Boolean);
    if (requestedScopes.some((s) => !appScopes.includes(s) && s !== "openid")) {
      return reply.redirect(`${q.redirect_uri}?error=invalid_scope&state=${q.state ?? ""}`);
    }
    if (!(await validateRedirectUri(client.application_id, q.redirect_uri))) {
      throw errors.badRequest("redirect_uri is not registered for this client");
    }
    if (q.code_challenge_method === "plain" && !q.code_challenge) {
      throw errors.badRequest("code_challenge required for S256/plain");
    }

    const code = await issueAuthorizationCode({
      userId: request.auth!.userId,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      scope: requestedScopes,
      codeChallenge: q.code_challenge ?? null,
      nonce: q.nonce ?? null
    });

    const params = new URLSearchParams({ code });
    if (q.state) params.set("state", q.state);
    return reply.redirect(`${q.redirect_uri}?${params.toString()}`);
  });

  // Token endpoint
  app.post("/oidc/token", async (request, reply) => {
    const body = tokenBodySchema.parse(request.body);
    const clientId = body.client_id ?? basicAuthClientId(request);
    if (!clientId) throw errors.unauthorized("client_id required");
    const client = await getClientByClientId(clientId);
    if (!client) throw errors.unauthorized("Unknown client_id");

    const secret = body.client_secret ?? basicAuthSecret(request);
    if (client.client_secret_hash && !(await verifyClientSecret(client, secret ?? ""))) {
      throw errors.unauthorized("Invalid client credentials");
    }

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.redirect_uri) throw errors.badRequest("code and redirect_uri required");
      const result = await exchangeAuthorizationCode({
        code: body.code,
        client,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier ?? null
      });
      return reply.send(result);
    }

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) throw errors.badRequest("refresh_token required");
      const { refresh } = await import("../services/auth.js");
      const result = await refresh(body.refresh_token, {
        ip: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
        correlationId: request.correlationId ?? null
      });
      return reply.send({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: "Bearer",
        expires_in: getConfig().ACCESS_TOKEN_TTL_SECONDS
      });
    }

    if (body.grant_type === "client_credentials") {
      const scope = (body.scope ?? "").split(" ").filter(Boolean);
      return reply.send(await exchangeClientCredentials({ client, scope }));
    }

    throw errors.badRequest("Unsupported grant_type");
  });

  app.get("/oidc/userinfo", { preHandler: [authenticate] }, async (request) => {
    const user = await buildUserPayload(request.auth!.userId);
    return {
      sub: user.userNumber,
      name: user.fullName,
      email: user.email,
      role: user.roles[0] ?? "CUSTOMER",
      userNumber: user.userNumber
    };
  });

  // JWKS — asymmetric Ed25519 public keys for external token verification
  app.get("/oidc/jwks", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return getJWKS();
  });

  // Rotate signing keys (admin-only — requires system.config.update permission)
  app.post("/oidc/rotate-keys", { preHandler: [authenticate] }, async (_request, reply) => {
    const { rotateSigningKeys } = await import("../services/jwt.js");
    const result = await rotateSigningKeys();
    reply.status(200);
    return { rotated: true, previousKid: result.oldKid, currentKid: result.newKid };
  });

  // PKCE helper (dev convenience)
  app.post("/oidc/pkce", async (request) => {
    const { verifier } = z.object({ verifier: z.string().min(43).max(128) }).parse(request.body);
    return { code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" };
  });

  // Dev: generate a PKCE verifier
  app.get("/oidc/pkce/new", async () => ({
    verifier: randomToken(32),
    code_challenge_method: "S256"
  }));
}

function basicAuthClientId(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded.split(":")[0];
}

function basicAuthSecret(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded.split(":").slice(1).join(":");
}
