import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError, newErrorId } from "../errors.js";
import { logger } from "../logger.js";

/**
 * Central error handler.
 * - AppError → mapped status + safe message (no secrets).
 * - ZodError → 422 with field issues.
 * - Everything else → 500 with an error ID; details stay server-side.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler(async (error, request, reply) => {
    const correlationId =
      (request as FastifyRequest & { correlationId?: string }).correlationId ?? null;

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          correlationId
        }
      });
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
          correlationId
        }
      });
    }

    // Fastify built-in errors (e.g. body parse) carry a statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode < 500) {
      const e = error as { code?: string; message: string };
      return reply.status(statusCode).send({
        error: { code: e.code ?? "REQUEST_ERROR", message: e.message, correlationId }
      });
    }

    const errorId = newErrorId();
    logger.error(
      { err: error, errorId, correlationId, path: request.url },
      "unhandled error"
    );
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        errorId,
        correlationId
      }
    });
  });
});
