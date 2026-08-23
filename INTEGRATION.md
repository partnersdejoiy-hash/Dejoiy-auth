# DEJOIY AUTH — Integration Guide

How a DEJOIY application connects to DEJOIY AUTH.

## 1. Flow

```
DEJOIY App ──▶ DEJOIY AUTH ──▶ Access token ──▶ User + Roles + Permissions ──▶ DEJOIY App
```

## 2. Register your application

Admin panel → Access → Applications → Create, or:

```
POST /api/v1/applications
{
  "name": "DEJOIY Marketplace",
  "type": "web",                       // web | spa | native | service
  "redirectUris": ["https://marketplace.dejoiy.com/callback"],
  "scopes": ["openid", "profile", "email"],
  "allowedOrigins": ["https://marketplace.dejoiy.com"]
}
```

You receive a `clientId` and (for confidential clients) a `clientSecret`. Store the secret server-side.

## 3. OIDC Authorization Code + PKCE (browser apps)

1. Redirect the user to:
   `{AUTH}/api/v1/oidc/authorize?client_id=...&redirect_uri=...&response_type=code&scope=openid%20profile%20email&code_challenge=...&code_challenge_method=S256&state=...`
2. DEJOIY AUTH authenticates the user (and performs MFA when required) then redirects back with `code`.
3. Exchange the code server-side:
   `POST /api/v1/oidc/token` with `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`,
   `client_secret` (confidential clients).
4. You receive `access_token`, `refresh_token`, `id_token`.

## 4. Identity payload (example)

```json
{
  "sub": "DJY-EMP-000428",
  "role": "customer_service_associate",
  "permissions": ["customer.read", "ticket.read", "ticket.update"],
  "email": "asha.k@dejoiy.com",
  "name": "Asha K",
  "department": "Support",
  "employeeId": "EMP-000428"
}
```

Decode scopes/claims from the JWT or from `/api/v1/oidc/userinfo`.

## 5. Service-to-service (API clients)

- `grant_type=client_credentials` with `client_id` + `client_secret` for machine tokens.
- Tokens are scoped to the application's scopes and carry no human identity.
- Rotate secrets periodically; revoke from the admin panel.

## 6. Using the SDK

```ts
import { DejoiyAuthClient } from "@dejoiy/auth-sdk";

const auth = new DejoiyAuthClient({
  baseUrl: "https://auth.dejoiy.com",
  clientId: "...",
  clientSecret: "...",   // confidential clients only
});

// Exchange an authorization code (server-side)
const { accessToken, refreshToken, idToken } = await auth.exchangeCode(code, verifier);

// Validate + introspect a token from an incoming request
const identity = await auth.verifyToken(accessToken);   // { sub, role, permissions, ... }
```

## 7. Security requirements for integrators

- Validate `state` to prevent CSRF on the callback.
- Validate `redirect_uri` exactly (registered, no wildcard suffixes).
- Keep `client_secret` server-side; never ship it in a browser bundle.
- Verify the `iss` and `aud` claims of JWTs you accept.
- Treat `access_token` as short-lived; use `refresh_token` rotation.
