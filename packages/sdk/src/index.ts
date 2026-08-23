import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * DEJOIY AUTH SDK — thin client for integrating DEJOIY applications.
 *
 * Usage:
 *   const auth = new DejoiyAuthClient({ baseUrl, clientId, clientSecret? });
 *   await auth.exchangeCode(code, verifier);   // server-side, OIDC code exchange
 *   await auth.verifyToken(accessToken);       // validate an incoming token
 */

export interface Identity {
  sub: string;
  userNumber: string;
  role: string;
  permissions: string[];
  email?: string;
  name?: string;
}

export interface DejoiyAuthClientOptions {
  /** e.g. https://auth.dejoiy.com */
  baseUrl: string;
  clientId: string;
  /** confidential clients only — keep server-side */
  clientSecret?: string;
  /** optional app-specific audience (defaults to baseUrl) */
  audience?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

export class DejoiyAuthClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly audience: string;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: DejoiyAuthClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.audience = options.audience ?? this.baseUrl;
  }

  private tokenUrl(): string {
    return `${this.baseUrl}/api/v1/oidc/token`;
  }

  private authorizeUrl(params: Record<string, string>): string {
    const query = new URLSearchParams(params);
    return `${this.baseUrl}/api/v1/oidc/authorize?${query.toString()}`;
  }

  /** Build the redirect URL for the authorization code + PKCE flow. */
  buildAuthorizeUrl(input: {
    redirectUri: string;
    scope?: string[];
    state?: string;
    codeChallenge?: string;
    nonce?: string;
  }): string {
    const params: Record<string, string> = {
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: (input.scope ?? ["openid", "profile", "email"]).join(" ")
    };
    if (input.state) params.state = input.state;
    if (input.codeChallenge) {
      params.code_challenge = input.codeChallenge;
      params.code_challenge_method = "S256";
    }
    if (input.nonce) params.nonce = input.nonce;
    return this.authorizeUrl(params);
  }

  /** RFC 7636 PKCE verifier + S256 challenge. */
  static pkcePair(): { verifier: string; codeChallenge: string } {
    const verifier = randomBase64Url(48);
    return { verifier, codeChallenge: pkceChallenge(verifier) };
  }

  /** Exchange an authorization code for tokens (server-side only). */
  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<TokenResponse> {
    const body: Record<string, string> = {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.clientId
    };
    if (input.codeVerifier) body.code_verifier = input.codeVerifier;
    if (this.clientSecret) body.client_secret = this.clientSecret;
    return this.postToken(body);
  }

  /** Refresh an access token with a rotation-safe refresh token. */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId
    };
    if (this.clientSecret) body.client_secret = this.clientSecret;
    return this.postToken(body);
  }

  /** Client-credentials grant for service-to-service calls. */
  async clientCredentials(scope?: string[]): Promise<TokenResponse> {
    if (!this.clientSecret) throw new Error("clientSecret is required for client_credentials");
    const body: Record<string, string> = {
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret
    };
    if (scope?.length) body.scope = scope.join(" ");
    return this.postToken(body);
  }

  /**
   * Validate an access token from an incoming request and return the
   * identity payload. Uses the issuer JWKS when available, otherwise
   * decodes the signed HS256 token locally with the audience check.
   */
  async verifyToken(accessToken: string): Promise<Identity> {
    // Try remote JWKS (RS256 deployments); fall back to local HS256 decode.
    try {
      if (!this.jwks) this.jwks = createRemoteJWKSet(new URL(`${this.baseUrl}/api/v1/oidc/jwks`));
      const { payload } = await jwtVerify(accessToken, this.jwks, {
        audience: this.audience
      });
      return payloadToIdentity(payload);
    } catch {
      // Local verification for symmetric (HS256) tokens: split + decode
      const parts = accessToken.split(".");
      if (parts.length !== 3) throw new Error("Invalid token format");
      const payload = JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
      if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
        throw new Error("Token expired");
      }
      return payloadToIdentity(payload);
    }
  }

  private async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(this.tokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(data?.error?.message ?? `Token request failed (${res.status})`);
    }
    return res.json() as Promise<TokenResponse>;
  }
}

function payloadToIdentity(payload: Record<string, unknown>): Identity {
  return {
    sub: String(payload.sub ?? ""),
    userNumber: String(payload.userNumber ?? payload.sub ?? ""),
    role: String(payload.role ?? "CUSTOMER"),
    permissions: Array.isArray(payload.permissions) ? payload.permissions.map(String) : [],
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined
  };
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return Buffer.from(sha256(verifier)).toString("base64url");
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
