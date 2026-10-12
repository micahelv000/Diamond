import { drizzle } from 'drizzle-orm/pglite';
import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expectTypeOf, test } from 'vitest';
import {
  createRepository,
  createService,
  type CreateInput,
  type CrudRepository,
  type CrudService,
  type Filter,
  type Logger,
  type Row,
  type ServiceContext,
  type SortSpec,
  type UpdateInput,
  type VisibleKey,
} from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import type { users } from './fixtures/schema.ts';

type UserEntity = typeof userEntity;
type UserSelect = typeof users.$inferSelect;
const repository = createRepository(drizzle(), userEntity);

describe('row types', () => {
  test('hidden keys are absent', () => {
    expectTypeOf<Row<UserEntity>>().toEqualTypeOf<Omit<UserSelect, 'passwordHash'>>();
    expectTypeOf<Row<UserEntity>>().not.toHaveProperty('passwordHash');
  });

  test('columns narrows the return type', async () => {
    const { items } = await repository.findMany({ columns: ['id', 'email'] });
    expectTypeOf(items).toEqualTypeOf<{ id: number; email: string }[]>();
    const one = await repository.findById(1, { columns: ['name'] });
    expectTypeOf(one).toEqualTypeOf<{ name: string } | null>();
    // @ts-expect-error -- hidden columns can't be requested
    await repository.findMany({ columns: ['passwordHash'] });
  });

  test('create input is $inferInsert minus create.omit; update is partial minus update.omit and pk; neither has hidden or soft-delete columns', () => {
    type ServerOnly = 'passwordHash' | 'deletedAt';
    expectTypeOf<CreateInput<UserEntity>>().toEqualTypeOf<Omit<typeof users.$inferInsert, 'id' | 'createdAt' | ServerOnly>>();
    expectTypeOf<UpdateInput<UserEntity>>().toEqualTypeOf<
      Omit<Partial<Omit<typeof users.$inferInsert, 'id'>>, 'email' | 'createdAt' | ServerOnly>
    >();
    expectTypeOf(userEntity.schemas.create.parse).returns.toEqualTypeOf<CreateInput<UserEntity>>();
  });
});

describe('filters and sort', () => {
  test('filter keys come from filterable with per-operator values', () => {
    expectTypeOf<Filter<UserEntity>['status__in']>().toEqualTypeOf<('active' | 'invited' | 'banned')[] | undefined>();
    expectTypeOf<Filter<UserEntity>['createdAt__gte']>().toEqualTypeOf<Date | undefined>();
    // @ts-expect-error -- name only allows ilike
    void repository.findMany({ where: { name__eq: 'x' } });
    // @ts-expect-error -- email is not filterable
    void repository.findMany({ where: { email__eq: 'x' } });
  });

  test('code-level sort accepts any visible column, never a hidden one', () => {
    void repository.findMany({ sort: ['-createdAt', 'name'] });
    // `email` isn't in `sortable`: that only limits the URL's `?sort=`.
    void repository.findMany({ sort: ['email', '-status'] });
    expectTypeOf<SortSpec<UserEntity>>().toEqualTypeOf<VisibleKey<UserEntity> | `-${VisibleKey<UserEntity>}`>();
    // @ts-expect-error -- passwordHash is hidden
    void repository.findMany({ sort: ['passwordHash'] });
    // @ts-expect-error -- hidden, descending
    void repository.findMany({ sort: ['-passwordHash'] });
  });
});

describe('extend', () => {
  test('adds methods but cannot override a base method', () => {
    const extended = repository.extend(() => ({ countActive: async () => 1 }));
    expectTypeOf(extended.countActive).returns.resolves.toBeNumber();
    expectTypeOf(extended.findById).toEqualTypeOf(repository.findById);
    // @ts-expect-error -- findMany is a base method
    repository.extend(() => ({ findMany: async () => 1 }));
  });
});

describe('chained extend', () => {
  test('a second repository extend keeps the first one\'s methods, and both are typed', () => {
    const chained = repository
      .extend(() => ({ countActive: async () => 1 }))
      .extend(() => ({ label: (id: number) => `user ${id}` }));
    expectTypeOf(chained.countActive).returns.resolves.toBeNumber();
    expectTypeOf(chained.label).toEqualTypeOf<(id: number) => string>();
    expectTypeOf(chained).toEqualTypeOf<CrudRepository<UserEntity, { countActive: () => Promise<number> } & { label: (id: number) => string }>>();
    repository.extend(() => ({ countActive: async () => 1 })).extend(() => ({
      // @ts-expect-error -- create is a base method, also on a chained extend
      create: async () => 1,
    }));
  });

  test('service extend: base is fully typed, chained extends keep both sets of methods', () => {
    const service = createService<UserEntity, { orgId: number }>(repository);
    const extended = service
      .extend((base) => ({
        activate: (id: number, ctx: ServiceContext<{ orgId: number }>) => base.update(id, { status: 'active' }, ctx),
      }))
      .extend((base) => {
        // Inside the second factory, `base` already has the first extension's method.
        expectTypeOf(base.activate).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
        return { activateAll: (ids: number[], ctx: ServiceContext<{ orgId: number }>) => Promise.all(ids.map((id) => base.activate(id, ctx))) };
      });
    expectTypeOf(extended.activate).parameters.toEqualTypeOf<[number, ServiceContext<{ orgId: number }>]>();
    expectTypeOf(extended.activateAll).returns.resolves.toEqualTypeOf<Row<UserEntity>[]>();
    // Built-ins, `entity` and `repository` are unchanged.
    expectTypeOf(extended.update).toEqualTypeOf(service.update);
    expectTypeOf(extended.entity).toEqualTypeOf<UserEntity>();
    expectTypeOf(extended.repository).toEqualTypeOf<CrudRepository<UserEntity>>();
  });

  test('a service extension cannot reuse a built-in name', () => {
    const service = createService(repository);
    service.extend(() => ({
      // @ts-expect-error -- update is a built-in service method
      update: async () => 1,
    }));
    service.extend(() => ({
      // @ts-expect-error -- repository is a built-in service field
      repository: 1,
    }));
    service.extend(() => ({ a: 1 })).extend(() => ({
      // @ts-expect-error -- extend is built in, also on a chained extend
      extend: () => 1,
    }));
  });

  test('a service over an extended repository keeps the repository methods after extend', () => {
    const repo = repository.extend(() => ({ countActive: async () => 1 }));
    const extended = createService(repo).extend(() => ({ hello: () => 'hi' }));
    expectTypeOf(extended.repository.countActive).returns.resolves.toBeNumber();
    expectTypeOf(extended.repository).toEqualTypeOf(repo);
    expectTypeOf(extended).toExtend<CrudService<UserEntity, unknown, typeof repo, { hello: () => string }>>();
  });
});

describe('internals.run', () => {
  test('resolves to the query result type', () => {
    const extended = repository.extend(({ db, table, run }) => ({ ids: () => run(db.select({ id: table.id }).from(table)) }));
    expectTypeOf(extended.ids).returns.resolves.toEqualTypeOf<{ id: number }[]>();
  });
});

describe('service', () => {
  test('service.repository keeps the repository type, including extend methods', () => {
    const extended = repository.extend(() => ({ countActive: async () => 1 }));
    const inferred = createService(extended);
    expectTypeOf(inferred.entity).toEqualTypeOf<UserEntity>();
    expectTypeOf(inferred.repository).toEqualTypeOf(extended);
    expectTypeOf(inferred.repository.countActive).returns.resolves.toBeNumber();

    const explicit = createService<UserEntity, { orgId: number }, typeof extended>(extended);
    expectTypeOf(explicit.repository.countActive).returns.resolves.toBeNumber();

    // With only the first two type arguments, `R` falls back to the base repository.
    const base = createService<UserEntity, { orgId: number }>(extended);
    expectTypeOf(base.repository).toEqualTypeOf<CrudRepository<UserEntity>>();
  });

  test('pino and Fastify loggers satisfy Logger', () => {
    expectTypeOf(pino()).toExtend<Logger>();
    expectTypeOf<FastifyBaseLogger>().toExtend<Logger>();
  });

  test('ctx.auth is typed and create takes the API input', () => {
    const service = createService<UserEntity, { orgId: number }>(repository, {
      hooks: {
        beforeCreate: ({ input, ctx }) => {
          expectTypeOf(ctx.auth).toEqualTypeOf<{ orgId: number } | undefined>();
          // Hidden columns aren't in the API input, so the hook supplies them.
          return { ...input, passwordHash: 'hashed', orgId: ctx.auth?.orgId ?? 0 };
        },
      },
    });
    expectTypeOf(service.create).parameter(0).toEqualTypeOf<CreateInput<UserEntity>>();
  });
  test('after and delete hooks get the saved row, the client values and the typed ctx', () => {
    createService<UserEntity, { orgId: number }>(repository, {
      hooks: {
        afterCreate: ({ row, input, ctx }) => {
          expectTypeOf(row).toEqualTypeOf<Row<UserEntity>>();
          expectTypeOf(input).toEqualTypeOf<CreateInput<UserEntity>>();
          expectTypeOf(ctx.auth).toEqualTypeOf<{ orgId: number } | undefined>();
        },
        afterUpdate: ({ id, row, patch }) => {
          expectTypeOf(id).toBeNumber();
          expectTypeOf(row).toEqualTypeOf<Row<UserEntity>>();
          expectTypeOf(patch).toEqualTypeOf<UpdateInput<UserEntity>>();
        },
        beforeDelete: async ({ id, ctx }) => {
          expectTypeOf(id).toBeNumber();
          expectTypeOf(ctx).toEqualTypeOf<ServiceContext<{ orgId: number }>>();
        },
        afterDelete: ({ row }) => expectTypeOf(row).toEqualTypeOf<Row<UserEntity>>(),
      },
    });
  });

  test('after hooks may return a value, which the service ignores', () => {
    const service = createService(repository, {
      hooks: { afterCreate: async ({ row }) => row.name, afterUpdate: () => 1, afterDelete: ({ row }) => row },
    });
    expectTypeOf(service.create).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
    expectTypeOf(service.update).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
    expectTypeOf(service.delete).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
  });
});
