import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteShorthandOptions,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AuthorizeMap, Operation } from '../auth/types.ts';
import type { CrudService, CrudServiceMethods, ServiceContext } from '../service/create-service.ts';
import type { AnyEntity, EntitySchemas } from '../types.ts';
import type { ContextMapper } from './authorization-hook.ts';

/** An entity from `defineEntity`. Its Zod schemas drive validation and serialization. */
export interface CrudEntity<E extends AnyEntity> extends AnyEntity {
  readonly schemas: EntitySchemas<E>;
}

/** The encapsulated Fastify scope that holds the CRUD routes, typed for Zod schemas. */
export type CrudScope = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Tools passed to `extend` so custom routes can reuse the service and the request's authorization. */
export interface CrudExtendTools<E extends CrudEntity<E>, TCtx, S = CrudService<E, TCtx>> {
  /** The service the generated routes use, fully typed, including any methods added with `extend`. */
  service: S;
  /** The entity, so custom routes can reuse its schemas. */
  entity: E;
  /**
   * Builds the context for service and repository calls: logger, current user, row scope and transaction.
   * Pass it to every call so they all commit or roll back together. On a `config.crudPublic` route it has
   * no user and no row scope.
   */
  serviceContext(request: FastifyRequest): ServiceContext<TCtx>;
}

/** Which routes to register. Leave it out to register all of them. */
export interface OperationsConfig {
  /** Register only these routes. */
  only?: readonly Operation[];
  /** Register every route except these. */
  except?: readonly Operation[];
}

/** Fastify hooks added to every route. */
export interface CrudHooksConfig {
  /** Runs first, before the body is read or validated. */
  onRequest?: RouteShorthandOptions['onRequest'];
  /** Runs after validation and the `authorize` check, right before the handler. */
  preHandler?: RouteShorthandOptions['preHandler'];
}

/** Options for `crudRoutes`. Only `service` is required, and `S` is usually inferred. */
export interface CrudRoutesOptions<E extends CrudEntity<E>, TCtx, S = CrudService<E, TCtx>> {
  // `S &` lets TypeScript infer the service's full type into `S`, and `NoInfer` makes `TCtx` come only from
  // `context`. Only the built-in methods are checked, because the generated finder types break `TCtx` inference.
  // The full explanation is in docs/type-inference.md.
  /** The service the routes call. Its entity decides the URL params, the schemas and the allowed sort keys. */
  service: S & CrudServiceMethods<E, NoInfer<TCtx>>;
  /**
   * Returns the current user for a request, or `undefined` for an anonymous caller. The value goes to
   * every `authorize` rule and to the service as `ctx.auth`. This library never reads tokens itself.
   */
  context?: ContextMapper<TCtx>;
  /**
   * Access rules per operation, plus an optional `'*'` rule for all of them. A rule returns `true` to allow,
   * `false` to deny (401 if anonymous, 403 otherwise), or a SQL condition that limits which rows match.
   * If left out, every route is open and a warning is logged at startup.
   */
  authorize?: AuthorizeMap<TCtx>;
  /** Which routes to register. Leave it out to register all five. */
  operations?: OperationsConfig;
  /** Fastify hooks added to every route here, including custom routes from `extend`. */
  hooks?: CrudHooksConfig;
  /**
   * Logs each validated request body at `debug` level on every route here.
   * Turn it off when bodies hold secrets or personal data.
   * @default true
   */
  logRequestBody?: boolean;
  /**
   * Runs each request, including custom routes, in one transaction that commits on success and rolls back
   * on error. Pass `serviceContext(request)` to every call to join it. Authorization and `hooks` run before
   * it opens. Handlers must return their result: `reply.send()` throws inside the transaction, so the
   * response always goes out after the commit.
   * @default true
   */
  transaction?: boolean;
  /**
   * Adds custom routes next to the generated ones, sharing their prefix, error format and `authorize` rules.
   * Give each route `config: { crudOperation }`, or `config: { crudPublic: true }` to skip `authorize`;
   * registration fails without one. Pass `serviceContext(request)` to service calls.
   */
  extend?: (scope: CrudScope, tools: CrudExtendTools<E, TCtx, S>) => void | Promise<void>;
}
