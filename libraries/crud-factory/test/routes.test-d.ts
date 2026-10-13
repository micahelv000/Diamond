import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { FastifyContextConfig, FastifyPluginAsync } from 'fastify';
import { describe, expectTypeOf, test } from 'vitest';
import { crudRoutes, type CrudRoutesOptions } from '../src/fastify/index.ts';
import {
  createRepository, createService, requireAuth, requireRole, type CrudService, type Database, type QueryOptions, type ServiceContext,
} from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import type { TestUser } from './helpers/server.ts';

const repository = createRepository(drizzle(), userEntity);
const service = createService(repository);

describe('crudRoutes types', () => {
  test('TCtx is inferred from `context` and flows into authorize rules and extend', () => {
    const plugin = crudRoutes({
      service,
      context: (request) => request.user ?? undefined,
      authorize: {
        '*': requireAuth,
        delete: requireRole('admin'),
        list: ({ ctx }) => {
          expectTypeOf(ctx).toEqualTypeOf<TestUser | undefined>();
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
    expectTypeOf(plugin).toEqualTypeOf<FastifyPluginAsync>();
  });

  test('extend sees service.repository with its custom methods, and TCtx is still inferred', () => {
    const extendedRepo = repository.extend(({ scoped, table }) => ({
      idsByName: (name: string, options: QueryOptions = {}) => {
        const query = scoped(options);
        return query.run(query.db.select({ id: table.id }).from(table).where(query.where(eq(table.name, name))));
      },
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
      activate: (id: number, ctx: ServiceContext<TestUser>) => base.update(id, { status: 'active' }, ctx),
    }));
    crudRoutes({
      service: userService,
      context: (request) => request.user ?? undefined,
      authorize: {
        '*': requireAuth,
        update: requireRole('admin'),
        list: ({ ctx }) => {
          expectTypeOf(ctx).toEqualTypeOf<TestUser | undefined>();
          return true;
        },
      },
      extend: (scope, { service, entity, serviceContext }) => {
        // `TCtx` is still inferred from `context`.
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
});
