import { eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import type { FastifyContextConfig, FastifyPluginAsync } from 'fastify';
import { describe, expectTypeOf, test } from 'vitest';
import { crudRoutes, type CrudRoutesOptions, type CrudRoutesPlugin } from '../src/fastify/index.ts';
import {
  createRepository, createService, defineEntity, requireAuth, requireRole, type CreateInput, type CrudService, type Database, type QueryOptions,
  type ServiceContext,
} from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import type { TestUser } from './helpers/server.ts';

const repository = createRepository(drizzle(), userEntity);
const service = createService(repository);

describe('crudRoutes types', () => {
  test('TContext is inferred from `context` and flows into authorize rules and extend', () => {
    const plugin = crudRoutes({
      service,
      context: (request) => request.user ?? undefined,
      authorize: {
        '*': requireAuth,
        delete: requireRole('admin'),
        list: ({ context }) => {
          expectTypeOf(context).toEqualTypeOf<TestUser | undefined>();
          return true;
        },
        update: ({ id }) => {
          expectTypeOf(id).toEqualTypeOf<number | undefined>();
          return true;
        },
      },
      extend: (scope, { serviceContext }) => {
        expectTypeOf(serviceContext).returns.toEqualTypeOf<ServiceContext<TestUser>>();
        scope.get('/:id/echo', { config: { crudOperation: 'get' }, schema: { params: userEntity.schemas.params } }, (request) => {
          expectTypeOf(request.params.id).toEqualTypeOf<number>();
          return request.params;
        });
      },
    });
    expectTypeOf(plugin).toExtend<FastifyPluginAsync>();
    expectTypeOf(plugin).toEqualTypeOf<CrudRoutesPlugin<typeof userEntity>>();
  });

  test('extend sees service.repository with its custom methods, and TContext is still inferred', () => {
    const extendedRepo = repository.extend(({ scoped, table }) => ({
      idsByName: (name: string, options: QueryOptions = {}) =>
        scoped(options, ({ database, visible }) => database.select({ id: table.id }).from(table).where(visible(eq(table.name, name)))),
    }));
    crudRoutes({
      service: createService(extendedRepo),
      context: (request) => request.user ?? undefined,
      extend: (scope, { service, serviceContext }) => {
        expectTypeOf(serviceContext).returns.toEqualTypeOf<ServiceContext<TestUser>>();
        expectTypeOf(service.repository.idsByName).returns.resolves.toEqualTypeOf<{ id: number }[]>();
        scope.get('/by-name', { config: { crudOperation: 'list' } }, (request) => service.repository.idsByName('Ann', serviceContext(request)));
      },
    });

    // An explicit auth type needs the repository type third, to keep the custom methods.
    const typed = createService<typeof userEntity, TestUser, typeof extendedRepo>(extendedRepo);
    crudRoutes({
      service: typed,
      context: (request) => request.user ?? undefined,
      authorize: { '*': requireAuth },
      extend: (_scope, { service }) => {
        expectTypeOf(service).toEqualTypeOf<CrudService<typeof userEntity, TestUser, typeof extendedRepo>>();
        expectTypeOf(service.repository.idsByName).returns.resolves.toEqualTypeOf<{ id: number }[]>();
      },
    });
  });

  test('an extended service is accepted, and its methods are typed inside extend', () => {
    const extendedRepo = repository.extend(() => ({ countActive: async () => 1 }));
    const userService = createService<typeof userEntity, TestUser, typeof extendedRepo>(extendedRepo).extend((base) => ({
      activate: (id: number, context: ServiceContext<TestUser>) => base.update(id, { status: 'active' }, context),
    }));
    crudRoutes({
      service: userService,
      context: (request) => request.user ?? undefined,
      authorize: {
        '*': requireAuth,
        update: requireRole('admin'),
        list: ({ context }) => {
          expectTypeOf(context).toEqualTypeOf<TestUser | undefined>();
          return true;
        },
      },
      extend: (scope, { service, entity, serviceContext }) => {
        // `TContext` is still inferred from `context`.
        expectTypeOf(serviceContext).returns.toEqualTypeOf<ServiceContext<TestUser>>();
        expectTypeOf(service).toEqualTypeOf(userService);
        expectTypeOf(service.activate).parameters.toEqualTypeOf<[number, ServiceContext<TestUser>]>();
        expectTypeOf(service.repository.countActive).returns.resolves.toBeNumber();
        scope.post('/:id/activate', { config: { crudOperation: 'update' }, schema: { params: entity.schemas.params } }, (request) =>
          service.activate(request.params.id, serviceContext(request)));
      },
    });
  });

  test('an extended service whose auth type does not match context fails to compile', () => {
    const orgService = createService<typeof userEntity, { orgId: number }>(repository).extend(() => ({ hello: () => 'hi' }));
    crudRoutes({ service: orgService, context: () => ({ orgId: 1 }) });
    // @ts-expect-error -- the service expects `{ orgId: number }`
    crudRoutes({ service: orgService, context: () => ({ orgId: 'one' }) });
  });

  test('a context without roles rejects requireRole', () => {
    crudRoutes({ service, authorize: { '*': requireAuth } });
    crudRoutes({
      service,
      // @ts-expect-error -- requireRole needs `roles` on the context
      context: () => ({ id: 1 }),
      authorize: { delete: requireRole('admin') },
    });
  });

  test('a wrong option key fails to compile', () => {
    crudRoutes({
      service,
      // @ts-expect-error -- typo of `authorize`
      autorize: { '*': requireAuth },
    });
    // @ts-expect-error -- not an operation
    crudRoutes({ service, operations: { except: ['remove'] } });
  });

  test('a context that does not match the service auth type fails to compile', () => {
    const orgService = createService<typeof userEntity, { orgId: number }>(repository);
    crudRoutes({ service: orgService, context: () => ({ orgId: 1 }) });
    // @ts-expect-error -- the service expects `{ orgId: number }`
    crudRoutes({ service: orgService, context: () => ({ orgId: 'one' }) });
  });

  test('a rule\'s id has the type of the entity\'s primary key', () => {
    const tags = pgTable('tags', { id: uuid().primaryKey(), name: text().notNull() });
    const tagService = createService(createRepository(drizzle(), defineEntity(tags, { primaryKey: 'id', softDelete: false })));
    crudRoutes({
      service: tagService,
      authorize: {
        delete: ({ id }) => {
          expectTypeOf(id).toEqualTypeOf<string | undefined>();
          return true;
        },
      },
    });
  });

  test('route config accepts crudPublic as an optional boolean', () => {
    expectTypeOf<FastifyContextConfig['crudPublic']>().toEqualTypeOf<boolean | undefined>();
    crudRoutes({
      service,
      extend: (scope) => {
        scope.get('/health', { config: { crudPublic: true } }, () => ({ ok: true }));
        // @ts-expect-error -- a boolean, not a string
        scope.get('/status', { config: { crudPublic: 'yes' } }, () => ({ ok: true }));
      },
    });
  });

  test('transaction is an optional boolean (default true) and opens on the repository db', () => {
    expectTypeOf<CrudRoutesOptions<typeof userEntity, undefined>['transaction']>().toEqualTypeOf<boolean | undefined>();
    crudRoutes({ service, transaction: false });
    // @ts-expect-error -- a boolean, not a string
    crudRoutes({ service, transaction: 'off' });
    expectTypeOf(service.repository.db).toEqualTypeOf<Database>();
  });

  test('hooks accept every Fastify request hook and nothing else', () => {
    crudRoutes({
      service,
      hooks: {
        onRequest: async () => {},
        preParsing: async (_request, _reply, payload) => payload,
        preValidation: [async () => {}],
        preHandler: async () => {},
        preSerialization: async (_request, _reply, payload) => payload,
        onSend: async (_request, _reply, payload) => payload,
        onResponse: async () => {},
        onTimeout: async () => {},
        onError: async () => {},
        onRequestAbort: async () => {},
      },
    });
    // @ts-expect-error -- `onReady` is an application hook, not a request hook
    crudRoutes({ service, hooks: { onReady: async () => {} } });
    // An async hook that also takes Fastify's `done` callback would be refused at startup, so it is a type error.
    // @ts-expect-error -- `done` is not allowed in an async hook
    crudRoutes({ service, hooks: { onRequest: async (_request, _reply, _done) => {} } });
    // @ts-expect-error -- `done` is not allowed in an async hook
    crudRoutes({ service, hooks: { onSend: async (_request, _reply, _payload, _done) => {} } });
    // @ts-expect-error -- a hook that doesn't return a promise would never finish without `done`
    crudRoutes({ service, hooks: { onRequest: (_request: unknown) => undefined } });
  });

  describe('route methods', () => {
    const routes = crudRoutes({ service });

    test('create needs the required fields, allows leaving out optional ones and rejects unknown ones', () => {
      expectTypeOf(routes.create).parameter(0).toEqualTypeOf<CreateInput<typeof userEntity>>();
      void routes.create({ email: 'a@x.io', name: 'Ann', orgId: 1 });
      void routes.create({ email: 'a@x.io', name: 'Ann', orgId: 1, status: 'active' });
      // @ts-expect-error -- `orgId` is required
      void routes.create({ email: 'a@x.io', name: 'Ann' });
      // @ts-expect-error -- not a column
      void routes.create({ email: 'a@x.io', name: 'Ann', orgId: 1, nickname: 'A' });
    });

    test('update takes a partial and rejects omitted, hidden and primary key fields', () => {
      void routes.update(1, { name: 'Bo' });
      // @ts-expect-error -- `email` is in update.omit
      void routes.update(1, { email: 'b@x.io' });
      // @ts-expect-error -- `passwordHash` is hidden
      void routes.update(1, { passwordHash: 'x' });
      // @ts-expect-error -- the primary key can't be changed
      void routes.update(1, { id: 2 });
      // @ts-expect-error -- the id is a number
      void routes.update('1', { name: 'Bo' });
    });

    test('list accepts declared filters and sortable columns only', () => {
      void routes.list({ status__in: ['active'], createdAt__gte: new Date(), sort: ['-createdAt'], total: true });
      // @ts-expect-error -- `email` is not filterable
      void routes.list({ email__eq: 'a@x.io' });
      // @ts-expect-error -- `email` is not sortable
      void routes.list({ sort: ['email'] });
    });
  });
});
