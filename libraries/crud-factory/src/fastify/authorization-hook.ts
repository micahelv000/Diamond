import type { SQL } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { evaluateAuthorization } from '../auth/evaluate.ts';
import type { AuthorizeMap, Operation } from '../auth/types.ts';
import { ForbiddenError, UnauthorizedError } from '../errors.ts';

/** The authorization result stored on `request.crudContext`. */
export interface CrudContext {
  /** The current user returned by the `context` mapper. */
  auth: unknown;
  /** The row filter from a rule that returned SQL, if any. */
  scope: SQL | undefined;
}

/** Returns the current user for a request, or `undefined` for an anonymous caller. May be async. */
export type ContextMapper<TCtx> = (request: FastifyRequest) => TCtx | undefined | Promise<TCtx | undefined>;

/** Options for `createAuthorizationHook`. */
export interface AuthorizationHookOptions<TCtx> {
  /** Returns the current user. If `undefined`, every caller is anonymous. */
  context: ContextMapper<TCtx> | undefined;
  /** The rules to check. If `undefined`, every request is allowed. */
  authorize: AuthorizeMap<TCtx> | undefined;
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

function paramId(params: unknown): number | undefined {
  return typeof params === 'object' && params !== null && 'id' in params && typeof params.id === 'number' ? params.id : undefined;
}

/**
 * Builds the preHandler that checks `authorize` on routes with `config.crudOperation`.
 * It throws 401 or 403 when a rule blocks the request, otherwise it stores the result on `request.crudContext`.
 */
export function createAuthorizationHook<TCtx>(options: AuthorizationHookOptions<TCtx>): preHandlerAsyncHookHandler {
  const { context, authorize } = options;

  return async function authorizeCrudOperation(request) {
    const op = request.routeOptions.config.crudOperation;
    if (op === undefined) return;

    const auth = await context?.(request);
    const result = await evaluateAuthorization({
      rules: authorize,
      op,
      ctx: auth,
      id: paramId(request.params),
      input: op === 'create' || op === 'update' ? request.body : undefined,
    });
    // Logs only the outcome, because the user and the body may hold personal data.
    request.log.debug({ op, decision: result.kind, auth}, 'authorization');

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
