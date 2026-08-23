import { randomToken, sha256 } from "../crypto.js";
import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { redisSetEx, redisGet, redisDel } from "../redis.js";
import { errors } from "../errors.js";
import { issueAccessToken, issueIdToken } from "./jwt.js";
import { buildUserPayload } from "./auth.js";
import { getPermissionsForUser } from "./rbac.js";
import { createSession } from "./session.js";

export interface OAuthClientRow {
  id: string;
  application_id: string;
  client_id: string;
  client_secret_hash: string | null;
  grant_types: string[];
  token_endpoint_auth_method: string;
}

export async function createOAuthClient(input: {
  applicationId: string;
  clientId: string;
  clientSecret: string;
  grantTypes?: string[];
}): Promise<{ clientId: string; clientSecret: string }> {
  const { hashToken } = await import("../crypto.js");
  await query(
    `INSERT INTO oauth_clients
       (application_id, client_id, client_secret_hash, grant_types)
     VALUES ($1,$2,$3,$4)`,
    [
      input.applicationId,
      input.clientId,
      hashToken(input.clientSecret),
      JSON.stringify(input.grantTypes ?? ["authorization_code", "refresh_token"])
    ]
  );
  return { clientId: input.clientId, clientSecret: input.clientSecret };
}

export async function getClientByClientId(clientId: string): Promise<OAuthClientRow | null> {
  const { rows } = await query<OAuthClientRow & { grant_types: unknown }>(
    `SELECT * FROM oauth_clients WHERE client_id = $1`,
    [clientId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { ...row, grant_types: row.grant_types as string[] };
}

export async function verifyClientSecret(client: OAuthClientRow, secret: string): Promise<boolean> {
  if (!client.client_secret_hash) return false;
  const { hashToken } = await import("../crypto.js");
  return hashToken(secret) === client.client_secret_hash;
}

export async function validateRedirectUri(applicationId: string, redirectUri: string): Promise<boolean> {
  const { rows } = await query<{ redirect_uris: string[] }>(
    `SELECT redirect_uris FROM applications WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [applicationId]
  );
  const uris = rows[0]?.redirect_uris ?? [];
  return uris.includes(redirectUri);
}

export async function getApplicationScopes(applicationId: string): Promise<string[]> {
  const { rows } = await query<{ default_scopes: string[] }>(
    `SELECT default_scopes FROM applications WHERE id = $1`,
    [applicationId]
  );
  return rows[0]?.default_scopes ?? [];
}

const AUTH_CODE_TTL = 300;

/** Issue an authorization code bound to user + client + PKCE verifier hash. */
export async function issueAuthorizationCode(input: {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge?: string | null;
  nonce?: string | null;
}): Promise<string> {
  const cfg = getConfig();
  const code = randomToken(32);
  const payload = {
    sub: input.userId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    codeChallenge: input.codeChallenge ?? null,
    nonce: input.nonce ?? null
  };
  await redisSetEx(`oauth:code:${code}`, AUTH_CODE_TTL, JSON.stringify(payload));
  return code;
}

interface AuthCodePayload {
  sub: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge: string | null;
  nonce: string | null;
}

export async function consumeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier?: string | null;
}): Promise<AuthCodePayload> {
  const raw = await redisGet(`oauth:code:${input.code}`);
  if (!raw) throw errors.unauthorized("Invalid authorization code");
  const payload = JSON.parse(raw) as AuthCodePayload;
  if (payload.clientId !== input.clientId) throw errors.unauthorized("Code/client mismatch");
  if (payload.redirectUri !== input.redirectUri) throw errors.unauthorized("Redirect URI mismatch");
  if (payload.codeChallenge) {
    if (!input.codeVerifier) throw errors.unauthorized("PKCE verifier required");
    const challenge = base64url(sha256(input.codeVerifier));
    if (challenge !== payload.codeChallenge) throw errors.unauthorized("PKCE verification failed");
  }
  await redisDel(`oauth:code:${input.code}`);
  return payload;
}

export function pkceChallenge(verifier: string): string {
  return base64url(sha256(verifier));
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  client: OAuthClientRow;
  redirectUri: string;
  codeVerifier?: string | null;
}): Promise<{
  access_token: string;
  refresh_token: string | null;
  id_token?: string;
  expires_in: number;
  scope: string[];
  user: Awaited<ReturnType<typeof buildUserPayload>>;
}> {
  const payload = await consumeAuthorizationCode({
    code: input.code,
    clientId: input.client.client_id,
    redirectUri: input.redirectUri,
    codeVerifier: input.codeVerifier
  });

  const user = await buildUserPayload(payload.sub);
  const permissions = await getPermissionsForUser(payload.sub);
  const session = await createOAuthSession(payload.sub, input.client.client_id);

  const accessToken = await issueAccessToken({
    userId: payload.sub,
    userNumber: user.userNumber,
    role: user.roles[0] ?? "CUSTOMER",
    permissions: [...permissions],
    sessionId: session.sessionId
  });

  const idToken = payload.scope.includes("openid")
    ? await issueIdToken({
        userId: payload.sub,
        userNumber: user.userNumber,
        email: user.email,
        name: user.fullName,
        role: user.roles[0] ?? "CUSTOMER"
      })
    : undefined;

  return {
    access_token: accessToken,
    refresh_token: session.refreshToken,
    id_token: idToken,
    expires_in: getConfig().ACCESS_TOKEN_TTL_SECONDS,
    scope: payload.scope,
    user
  };
}

async function createOAuthSession(userId: string, clientId: string) {
  return createSession({ userId, userAgent: `oauth:${clientId}` });
}

/** Client-credentials grant for service accounts. */
export async function exchangeClientCredentials(input: {
  client: OAuthClientRow;
  scope: string[];
}): Promise<{ access_token: string; expires_in: number; scope: string[] }> {
  const appScopes = await getApplicationScopes(input.client.application_id);
  const scope = input.scope.length > 0 ? input.scope.filter((s) => appScopes.includes(s)) : appScopes;
  const session = await createOAuthSession("00000000-0000-0000-0000-000000000000", input.client.client_id);
  const accessToken = await issueAccessToken({
    userId: "00000000-0000-0000-0000-000000000000",
    userNumber: "DJY-SVC-000000",
    role: "SERVICE_ACCOUNT",
    permissions: scope,
    sessionId: session.sessionId
  });
  return { access_token: accessToken, expires_in: getConfig().ACCESS_TOKEN_TTL_SECONDS, scope };
}
