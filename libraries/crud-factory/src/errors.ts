/** Base class for errors this library throws on purpose. Match on `code`, which is stable. */
export class CrudFactoryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends CrudFactoryError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', 404, message);
  }
}

/**
 * The request conflicts with existing data (409). The repository throws it for unique violations,
 * and you can throw it for your own business rules.
 */
export class ConflictError extends CrudFactoryError {
  /** The violated database constraint. Unset when your own code throws the error. */
  readonly constraint: string | undefined;

  /**
   * @param message The message sent to the client. Defaults to `'Resource already exists'`.
   * @param options `constraint` is the violated database constraint, sent to the client.
   *   `cause` is the original error, kept for logs.
   */
  constructor(message = 'Resource already exists', options: { constraint?: string; cause?: unknown } = {}) {
    super('CONFLICT', 409, message, options);
    this.constraint = options.constraint;
  }
}

export class BadRequestError extends CrudFactoryError {
  constructor(message: string, options?: ErrorOptions) {
    super('BAD_REQUEST', 400, message, options);
  }
}

export class UnauthorizedError extends CrudFactoryError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class ForbiddenError extends CrudFactoryError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', 403, message);
  }
}

export interface PostgresErrorFields {
  code: string;
  constraint?: string;
}

// Drivers use their own error classes and drizzle wraps them, so search the `cause` chain
// for a 5-character SQLSTATE code.
export function findPostgresError(error: unknown): PostgresErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      const constraint = 'constraint' in current && typeof current.constraint === 'string' ? current.constraint : undefined;
      return { code: current.code, constraint };
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Maps a driver error to a `CrudFactoryError` by SQLSTATE code; returns anything else unchanged. */
export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof CrudFactoryError) return error;
  const pgError = findPostgresError(error);
  switch (pgError?.code) {
    case '23505':
      return new ConflictError(undefined, { constraint: pgError.constraint, cause: error });
    case '23502':
      return new BadRequestError('A required value is missing', { cause: error });
    case '23503':
      return new BadRequestError('Referenced resource does not exist', { cause: error });
    case '23514':
      return new BadRequestError('Value violates a check constraint', { cause: error });
    case '22P02':
      return new BadRequestError('Invalid value format', { cause: error });
    case '22003':
      return new BadRequestError('Numeric value out of range', { cause: error });
    case '22008':
      return new BadRequestError('Date or time value out of range', { cause: error });
    case '22007':
      return new BadRequestError('Invalid date or time format', { cause: error });
    case '22001':
      return new BadRequestError('Value too long', { cause: error });
    case '22021':
      return new BadRequestError('Invalid characters in a text value', { cause: error });
    case '22000':
      return new BadRequestError('Invalid value', { cause: error });
    case '23P01':
      return new ConflictError('Resource conflicts with an existing one', { constraint: pgError.constraint, cause: error });
    // Serialization failures and deadlocks are transient, so the client can retry.
    case '40001':
    case '40P01':
      return new ConflictError('The request conflicted with a concurrent change; retry it', { cause: error });
    default:
      return error;
  }
}
