/**
 * Typed application errors with safe HTTP mapping.
 * `details` must never contain secrets — it is returned to clients.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message: string, details?: Record<string, unknown>) =>
    new AppError(400, "BAD_REQUEST", message, details),
  unauthorized: (message = "Authentication required") =>
    new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Insufficient permissions") =>
    new AppError(403, "FORBIDDEN", message),
  notFound: (message = "Resource not found") =>
    new AppError(404, "NOT_FOUND", message),
  conflict: (message: string) => new AppError(409, "CONFLICT", message),
  rateLimited: (message = "Too many requests. Try again later.") =>
    new AppError(429, "RATE_LIMITED", message),
  locked: (message = "Account is temporarily locked. Try again later.") =>
    new AppError(423, "ACCOUNT_LOCKED", message),
  invalidCredentials: (message = "Invalid credentials") =>
    new AppError(401, "INVALID_CREDENTIALS", message),
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(422, "VALIDATION_ERROR", message, details),
  internal: (message = "Internal server error") =>
    new AppError(500, "INTERNAL_ERROR", message)
};

/** Error ID generator for observability (never includes secrets). */
export function newErrorId(): string {
  return `ERR-${randomHex(8).toUpperCase()}`;
}

export function newCorrelationId(): string {
  return `REQ-${randomHex(12).toUpperCase()}`;
}

export function newSecurityEventId(): string {
  return `SEC-${randomHex(8).toUpperCase()}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
