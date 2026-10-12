import type { FastifyPluginAsync, FastifyRequest, RouteOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import type { Operation } from '../auth/types.ts';
import { NotFoundError } from '../errors.ts';
import type { CrudService, ServiceContext } from '../service/create-service.ts';
import type { Database } from '../types.ts';
import { createAuthorizationHook } from './authorization-hook.ts';
import { crudErrorHandler, type ErrorBody } from './error-handler.ts';
import type { CrudEntity, CrudRoutesOptions } from './options.ts';
import { isOperationEnabled } from './utils.ts';

// Fastify's request part types can't be resolved while the entity is generic. The validator has already
// parsed the value with this schema before the handler runs, so the cast is safe.
function validated<T>(_schema: z.ZodType<T, unknown>, value: unknown): T {
  return value as T;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The request's transaction while a `crudRoutes` handler runs, or `null` otherwise. */
    crudTx: Database | null;
  }
}

// Thrown in place of `reply.send()` inside a transactional handler. Named so the 500 log, which leaves out
// error messages, still says what went wrong.
class ReplySentInTransactionError extends Error {
  override name = 'ReplySentInTransactionError';
}

function rejectSend(): never {
  throw new ReplySentInTransactionError('Return the response instead of calling reply.send() inside a transactional crudRoutes handler');
}

// Runs for every route in the plugin scope, including `extend` routes and the HEAD routes Fastify adds for
// GET routes, which share the GET route's config. The not-found handler never reaches `onRoute`.
function assertAuthorizationChoice({ method, url, config }: RouteOptions): void {
  const where = `${[method].flat().join(',')} ${url}`;
  if (config?.crudOperation === undefined && config?.crudPublic !== true) {
    throw new Error(`${where}: crudRoutes routes need config.crudOperation, or config.crudPublic: true to skip authorize`);
  }
  if (config.crudOperation !== undefined && config.crudPublic === true) {
    throw new Error(`${where}: config.crudOperation and config.crudPublic can't both be set`);
  }
}

// Wraps the handler in a transaction stored on `request.crudTx`.
function wrapHandlerInTransaction(db: Database, routeOptions: RouteOptions): void {
  const { handler } = routeOptions;
  routeOptions.handler = function handleInTransaction(request, reply) {
    return db.transaction(async (tx) => {
      request.crudTx = tx;
      // Sending here would flush the response before COMMIT, so a failed commit would still look like a
      // success. `send` lives on Fastify's reply prototype, so an own property hides it for this reply only.
      const ownSend = Object.getOwnPropertyDescriptor(reply, 'send');
      reply.send = rejectSend;
      try {
        // Handlers may use `this` as the Fastify instance.
        return await handler.call(this, request, reply);
      } finally {
        // Restored before the transaction settles, so Fastify can send the result or the error response.
        if (ownSend) Object.defineProperty(reply, 'send', ownSend);
        else Reflect.deleteProperty(reply, 'send');
        // Cleared so later hooks can't write through a finished transaction.
        request.crudTx = null;
      }
    });
  };
}

/**
 * Builds an encapsulated Fastify plugin with list, get, create, update and delete routes for one entity.
 * Register it with a prefix.
 */
export function crudRoutes<E extends CrudEntity<E>, TCtx = undefined, S = CrudService<E, TCtx>>(
  options: CrudRoutesOptions<E, TCtx, S>,
): FastifyPluginAsync {
  const { service, context, authorize, operations, hooks = {}, extend, logRequestBody = true, transaction = true } = options;
  const { schemas } = service.entity;

  const serviceContext = (request: FastifyRequest): ServiceContext<TCtx> => {
    const tx = request.crudTx ?? undefined;
    if (request.crudContext) {
      return {
        log: request.log,
        // Only this scope's preHandler sets `crudContext`, using this scope's `context` mapper,
        // so `auth` is a `TCtx`.
        auth: request.crudContext.auth as TCtx | undefined,
        scope: request.crudContext.scope,
        tx,
      };
    }
    if (request.routeOptions.config.crudPublic === true) return { log: request.log, tx };
    // No rule ran, for example on a route outside this scope, so fail rather than run without a row scope.
    throw new Error(`${request.routeOptions.url ?? request.url}: no authorize check ran for this route`);
  };
  const idOf = (request: FastifyRequest) => validated(schemas.params, request.params).id;
  const route = (op: Operation) => ({ config: { crudOperation: op } });

  return async function crudRoutesPlugin(instance) {
    // Added first so it sees every route below, including the `extend` ones.
    instance.addHook('onRoute', (routeOptions) => {
      assertAuthorizationChoice(routeOptions);
      if (transaction) wrapHandlerInTransaction(service.repository.db, routeOptions);
    });
    // Scoped to this plugin, so the host app needs no setup.
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler(crudErrorHandler);
    // Unknown paths under the prefix get the same error body as the other routes.
    instance.setNotFoundHandler((request, reply) => {
      const body: ErrorBody = { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` };
      return reply.status(404).send(body);
    });
    if (!instance.hasRequestDecorator('crudContext')) instance.decorateRequest('crudContext', null);
    if (!instance.hasRequestDecorator('crudTx')) instance.decorateRequest('crudTx', null);
    // Added before authorization so denied requests are logged too. It runs after validation,
    // so it logs the parsed body.
    if (logRequestBody) {
      instance.addHook('preHandler', async (request) => {
        if (request.body !== undefined) request.log.debug({ body: request.body }, 'request body');
      });
    }
    instance.addHook('preHandler', createAuthorizationHook({ context, authorize }));
    // Added on the scope so they also run on `extend` routes, after authorization.
    for (const hook of [hooks.onRequest ?? []].flat()) instance.addHook('onRequest', hook);
    for (const hook of [hooks.preHandler ?? []].flat()) instance.addHook('preHandler', hook);

    const where = instance.prefix || '/';
    if (!authorize) instance.log.warn(`${where} routes registered without authorize`);
    if (authorize && !context) {
      instance.log.warn(`${where} routes have authorize but no context: every request is anonymous (401)`);
    }

    if (isOperationEnabled('list', operations)) {
      instance.get(
        '/',
        { ...route('list'), schema: { querystring: schemas.listQuery, response: { 200: schemas.listResult } } },
        (request) => service.findMany(validated(schemas.listQuery, request.query), serviceContext(request)),
      );
    }

    if (isOperationEnabled('get', operations)) {
      instance.get(
        '/:id',
        {
          ...route('get'),
          schema: { params: schemas.params, querystring: schemas.getQuery, response: { 200: schemas.readPartial } },
        },
        async (request) => {
          const query = validated(schemas.getQuery, request.query);
          const row = await service.findById(idOf(request), query, serviceContext(request));
          // Matches the repository's message when a row is not found.
          if (row === null) throw new NotFoundError(`${service.entity.name} not found`);
          return row;
        },
      );
    }

    if (isOperationEnabled('create', operations)) {
      instance.post(
        '/',
        { ...route('create'), schema: { body: schemas.create, response: { 201: schemas.read } } },
        async (request, reply) => {
          const row = await service.create(validated(schemas.create, request.body), serviceContext(request));
          // Returned instead of sent, so the response goes out after the transaction commits.
          reply.status(201);
          return row;
        },
      );
    }

    if (isOperationEnabled('update', operations)) {
      instance.patch(
        '/:id',
        { ...route('update'), schema: { params: schemas.params, body: schemas.update, response: { 200: schemas.read } } },
        (request) => service.update(idOf(request), validated(schemas.update, request.body), serviceContext(request)),
      );
    }

    if (isOperationEnabled('delete', operations)) {
      instance.delete('/:id', { ...route('delete'), schema: { params: schemas.params } }, async (request, reply) => {
        await service.delete(idOf(request), serviceContext(request));
        // Fastify sends the empty response once this resolves, after the commit.
        reply.status(204);
        return undefined;
      });
    }

    await extend?.(instance.withTypeProvider<ZodTypeProvider>(), { service, entity: service.entity, serviceContext });
  };
}
