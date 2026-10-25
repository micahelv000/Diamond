import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConflictError, CrudFactoryError } from '../errors.ts';

/** The JSON body of every error response from the CRUD routes. */
export interface ErrorBody {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

interface ValidationIssue {
  instancePath: string;
  message?: string;
}

function validationIssues(error: unknown): ValidationIssue[] | undefined {
  if (!(error instanceof Error) || !('validation' in error) || !Array.isArray(error.validation)) return undefined;
  return error.validation;
}

// Fastify's own errors for bad requests carry a 4xx status.
function clientErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('statusCode' in error) || typeof error.statusCode !== 'number') return undefined;
  return error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : undefined;
}

/** Turns library and validation errors into an error body, and hides any other error behind a 500. */
export function crudErrorHandler(error: unknown, _request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const send = (status: number, body: ErrorBody) => reply.status(status).send(body);

  if (error instanceof CrudFactoryError) {
    // Only conflicts raised by the database have a constraint name to report.
    const constraint = error instanceof ConflictError ? error.constraint : undefined;
    return send(error.statusCode, { code: error.code, message: error.message, ...(constraint !== undefined && { data: { constraint } }) });
  }

  const issues = validationIssues(error);
  if (issues && error instanceof Error) {
    const data = { issues: issues.map(({ instancePath, message }) => ({ path: instancePath, message })) };
    return send(400, { code: 'BAD_REQUEST', message: error.message, data });
  }

  const status = clientErrorStatus(error);
  if (status !== undefined && error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'BAD_REQUEST';
    return send(status, { code, message: error.message });
  }

  return send(500, { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' });
}
