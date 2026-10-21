import type { SQL } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { evaluateAuthorization } from '../auth/evaluate.ts';
import type { AnyId, AuthorizeMap, Operation } from '../auth/types.ts';
import { ForbiddenError, UnauthorizedError } from '../errors.ts';

/** The authorization result stored on `request.crudContext`. */
export interface CrudContext {
  /** The current user returned by the `context` mapper. */
  auth: unknown;
  /** The row filter from a rule that returned SQL, if any. */
  scope: SQL | undefined;
}

/** Returns the current user for a request, or `undefined` for an anonymous caller. May be async. */
export type ContextMapper<TContext> = (request: FastifyRequest) => TContext | undefined | Promise<TContext | undefined>;

/** Options for `createAuthorizationHook`. */
export interface AuthorizationHookOptions<TContext, TId = AnyId> {
  /** Returns the current user. If `undefined`, every caller is anonymous. */
  context: ContextMapper<TContext> | undefined;
  /** The rules to check. If `undefined`, every request is allowed. */
  authorize: AuthorizeMap<TContext, TId> | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authorization result on routes with `config.crudOperation`, or `null` otherwise. */
    crudContext: CrudContext | null;
  }
  interface FastifyContextConfig {
    /** The operation whose `authorize` rule runs before the handler. Every `crudRoutes` route needs it or `crudPublic`. */
    crudOperation?: Operation;
    /**
     * Marks a custom `crudRoutes` route as intentionally public: no `authorize` rule runs, and
     * `serviceContext` gives it no user and no row scope.
     */
    crudPublic?: boolean;
  }
}

// The params validator has already parsed `id` with the primary key's schema, so it has the key's type.
function paramId<TId>(params: unknown): TId | undefined {
  if (typeof params !== 'object' || params === null || !('id' in params)) return undefined;
  const { id } = params;
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') return id as TId;
  return undefined;
}

/**
 * Builds the preHandler that checks `authorize` on routes with `config.crudOperation`.
 * It throws 401 or 403 when a rule blocks the request, otherwise it stores the result on `request.crudContext`.
 */
export function createAuthorizationHook<TContext, TId = AnyId>(options: AuthorizationHookOptions<TContext, TId>): preHandlerAsyncHookHandler {
  const { context, authorize } = options;

  return async function authorizeCrudOperation(request) {
    const op = request.routeOptions.config.crudOperation;
    if (op === undefined) return;

    const auth = await context?.(request);
    const result = await evaluateAuthorization({
      rules: authorize,
      op,
      context: auth,
      id: paramId<TId>(request.params),
      input: op === 'create' || op === 'update' ? request.body : undefined,
    });

    switch (result.kind) {
      case 'unauthenticated':
        throw new UnauthorizedError();
      case 'deny':
        throw new ForbiddenError();
      case 'allow':
        request.crudContext = { auth, scope: undefined };
        return;
      case 'scope':
        request.crudContext = { auth, scope: result.sql };
        return;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  };
}
