import type { Problem, ProblemCode } from '@credforge/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType, z } from 'zod';

/** An error with an RFC 9457 problem response. Thrown by `/api/v1` handlers. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  toProblem(): Problem {
    return {
      type: `https://credforge.app/problems/${this.code.replace(/_/g, '-')}`,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail && { detail: this.detail }),
      ...(this.errors && { errors: this.errors }),
    };
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);

export const forbidden = (detail = "Your role doesn't allow this.") =>
  new ApiError(403, 'forbidden', 'Not allowed', detail);

export const conflict = (detail: string) => new ApiError(409, 'conflict', 'Conflict', detail);

/** Parses input with a Zod schema; failures become a 400 `validation_failed` with field errors. */
export function parse<S extends ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '(body)';
    errors[path] ??= issue.message;
  }
  throw new ApiError(400, 'validation_failed', 'Check the highlighted fields', undefined, errors);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id must be a UUID; anything else can't exist, so it is a 404 rather than a SQL error. */
export function uuidParam(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw notFound(what);
  return value.toLowerCase();
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function sendProblem(reply: FastifyReply, error: ApiError) {
  return reply.code(error.status).type('application/problem+json').send(error.toProblem());
}

/** Error handler for `/api/v1`: every error becomes `application/problem+json`. */
export function problemErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ApiError) return sendProblem(reply, error);
  const status = (error as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    // Fastify's own client errors: malformed JSON, body too large, unsupported content type.
    return sendProblem(
      reply,
      new ApiError(status, status === 400 ? 'validation_failed' : 'forbidden', error.message),
    );
  }
  request.log.error({ err: error }, 'unhandled API error');
  return sendProblem(reply, new ApiError(500, 'internal_error', 'Something went wrong'));
}
