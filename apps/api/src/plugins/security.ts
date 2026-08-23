import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { getConfig, corsOrigins } from "../config.js";
import type { FastifyInstance } from "fastify";

/**
 * Defense-in-depth HTTP layer:
 * - strict security headers (CSP, HSTS, frame-ancestors, nosniff, referrer, permissions)
 * - strict CORS allow-list
 * - Redis-backed rate limiting (global + route-specific buckets)
 */
export const securityPlugin = fp(async (app: FastifyInstance) => {
  const cfg = getConfig();

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: cfg.CSP_FRAME_ANCESTORS === "none" ? ["'none'"] : [cfg.CSP_FRAME_ANCESTORS],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: {
      maxAge: cfg.HSTS_MAX_AGE,
      includeSubDomains: true,
      preload: false
    },
    xFrameOptions: { action: "deny" },
    noSniff: true
  });

  // Permissions-Policy (not exposed by @fastify/helmet, set manually)
  app.addHook("onSend", async (_request, reply) => {
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow non-browser clients (curl, service accounts) without an Origin.
      if (!origin) return cb(null, true);
      // Disallowed origins get no CORS headers (browser blocks them); the
      // request itself is not rejected, avoiding error-path confusion.
      return cb(null, corsOrigins(cfg).includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-Id"]
  });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    redis: app.redisClient as never,
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." }
    })
  });
});
