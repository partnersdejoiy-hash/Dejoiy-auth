# DEJOIY AUTH — OIDC / OAuth2 Reference

DEJOIY AUTH implements OpenID Connect and OAuth2 for identity federation across the DEJOIY ecosystem.

## Standards

| Feature | Implementation |
| --- | --- |
| Protocol | OpenID Connect Core 1.0, OAuth 2.1 |
| Signing algorithm | EdDSA (Ed25519) — asymmetric |
| PKCE | S256 only in production |
| Token format | JWT (access, ID), opaque (refresh) |
| Discovery | `/.well-known/openid-configuration` |
| JWKS | `GET /api/v1/oidc/jwks` |
| Discovery endpoint | `GET /api/v1/oidc/.well-known/openid-configuration` |

## Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/v1/oidc/.well-known/openid-configuration` | GET | OIDC discovery document |
| `/api/v1/oidc/jwks` | GET | JSON Web Key Set (public Ed25519 keys) |
| `/api/v1/oidc/authorize` | GET | Authorization endpoint (browser redirect) |
| `/api/v1/oidc/token` | POST | Token endpoint (code exchange, refresh, client_credentials) |
| `/api/v1/oidc/userinfo` | GET | UserInfo endpoint (requires access token) |
| `/api/v1/oidc/rotate-keys` | POST | Rotate JWT signing keys (admin only) |

## Authorization Code + PKCE Flow

```
┌─────────────┐                              ┌──────────────────┐
│  DEJOIY App │                              │   DEJOIY AUTH    │
│  (browser)  │                              │                  │
└──────┬──────┘                              └────────┬─────────┘
       │ 1. Generate PKCE verifier + challenge       │
       │                                              │
       │ 2. Redirect to authorize endpoint            │
       │─────────────────────────────────────────────>│
       │    ?client_id=...                            │
       │    &redirect_uri=...                         │
       │    &response_type=code                       │
       │    &scope=openid profile email               │
       │    &code_challenge=...                       │
       │    &code_challenge_method=S256               │
       │    &state=...                                │
       │                                              │
       │ 3. User authenticates + MFA (if enrolled)    │
       │                                              │
       │ 4. Redirect back with code                   │
       │<─────────────────────────────────────────────│
       │    ?code=...&state=...                       │
       │                                              │
       │ 5. Exchange code for tokens (server-side)    │
       │─────────────────────────────────────────────>│
       │    POST /oidc/token                          │
       │    grant_type=authorization_code             │
       │    code=...                                  │
       │    redirect_uri=...                          │
       │    client_id=...                             │
       │    code_verifier=...                         │
       │                                              │
       │ 6. Return tokens                             │
       │<─────────────────────────────────────────────│
       │    { access_token, refresh_token, id_token } │
```

## ID Token Claims

```json
{
  "iss": "https://auth.dejoiy.com",
  "sub": "uuid",
  "aud": "dejoiy-auth",
  "exp": 1705315800,
  "iat": 1705314900,
  "userNumber": "DJY-EMP-000428",
  "role": "customer_service_associate",
  "email": "user@dejoiy.com",
  "name": "John Doe"
}
```

## Access Token Claims

```json
{
  "iss": "https://auth.dejoiy.com",
  "sub": "uuid",
  "aud": "https://marketplace.dejoiy.com",
  "exp": 1705315800,
  "iat": 1705314900,
  "type": "access",
  "sid": "session-uuid",
  "userNumber": "DJY-EMP-000428",
  "role": "customer_service_associate",
  "permissions": ["customer.read", "ticket.read"]
}
```

## Client Types

| Type | Auth Method | PKCE | Use Case |
| --- | --- | --- | --- |
| **Confidential (web)** | `client_secret_basic` or `client_secret_post` | Required | Server-side apps |
| **Public (SPA)** | `none` | Required | Browser-only apps |
| **Service** | `client_secret_basic` | N/A | Server-to-server |

## PKCE Enforcement

In production (`NODE_ENV=production`):
- `code_challenge_method=S256` is the only accepted method
- `plain` is rejected
- PKCE verifier is mandatory for all authorization code exchanges

## Refresh Token Rotation

Every token refresh produces a new refresh token. The previous token is invalidated.
If a previously-rotated token is reused:
- The entire token family is revoked
- All sessions for that user are revoked
- A `login.suspicious` security event is recorded

## JWKS

Public Ed25519 keys are published at `GET /api/v1/oidc/jwks`:

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "...",
      "kid": "dejoiy-auth-key-1",
      "alg": "EdDSA",
      "use": "sig"
    }
  ]
}
```

Key rotation:
- `POST /api/v1/oidc/rotate-keys` (admin only)
- Previous keys remain valid during rotation grace period
- JWKS endpoint includes both current and previous keys
- Cache headers: `Cache-Control: public, max-age=3600`

## External Application Integration

1. Register your application in Admin → Access → Applications
2. Receive `clientId` and `clientSecret`
3. Configure redirect URIs (exact match required)
4. Use the SDK or implement the OIDC flow directly

See `INTEGRATION.md` and `packages/sdk` for implementation examples.
