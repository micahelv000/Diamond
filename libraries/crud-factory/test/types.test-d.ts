import { drizzle } from 'drizzle-orm/pglite';
import { describe, expectTypeOf, test } from 'vitest';
import {
  createRepository,
  createService,
  type CreateInput,
  type CrudRepository,
  type CrudService,
  type Filter,
  type Insert,
  type Patch,
  type Row,
  type ServiceContext,
  type SortSpec,
  type UpdateInput,
  type VisibleKey,
} from '../src/index.ts';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { defineEntity } from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import type { users } from './fixtures/schema.ts';

type UserEntity = typeof userEntity;
type UserSelect = typeof users.$inferSelect;
const repository = createRepository(drizzle(), userEntity);

describe('row types', () => {
  test('hidden and soft-delete keys are absent', () => {
    expectTypeOf<Row<UserEntity>>().toEqualTypeOf<Omit<UserSelect, 'passwordHash' | 'deletedAt'>>();
    expectTypeOf<Row<UserEntity>>().not.toHaveProperty('passwordHash');
    expectTypeOf<Row<UserEntity>>().not.toHaveProperty('deletedAt');
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
        activate: (id: number, context: ServiceContext<{ orgId: number }>) => base.update(id, { status: 'active' }, context),
      }))
      .extend((base) => {
        // Inside the second factory, `base` already has the first extension's method.
        expectTypeOf(base.activate).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
        return { activateAll: (ids: number[], context: ServiceContext<{ orgId: number }>) => Promise.all(ids.map((id) => base.activate(id, context))) };
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

describe('internals.scoped', () => {
  test('scoped resolves to the query result type', () => {
    const extended = repository.extend(({ scoped, table }) => ({
      ids: () => scoped({}, ({ database, visible }) => database.select({ id: table.id }).from(table).where(visible())),
    }));
    expectTypeOf(extended.ids).returns.resolves.toEqualTypeOf<{ id: number }[]>();
  });

  test('the raw database, baseWhere and run are no longer reachable from extend', () => {
    repository.extend((internals) => {
      // @ts-expect-error -- use the database scoped gives, which joins the caller's transaction
      void internals.db;
      // @ts-expect-error -- use the where scoped gives, which always applies soft delete and scope
      void internals.baseWhere;
      // @ts-expect-error -- scoped runs the query itself, mapping its errors
      void internals.run;
      return {};
    });
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

  test('context.auth is typed and create takes the API input', () => {
    const service = createService<UserEntity, { orgId: number }>(repository, {
      hooks: {
        create: ({ input, context, run }) => {
          expectTypeOf(context.auth).toEqualTypeOf<{ orgId: number } | undefined>();
          // Hidden columns aren't in the API input, so the hook passes them to run().
          return run({ ...input, passwordHash: 'hashed', orgId: context.auth?.orgId ?? 0 });
        },
      },
    });
    expectTypeOf(service.create).parameter(0).toEqualTypeOf<CreateInput<UserEntity>>();
  });

  test('each hook gets the client values, the typed context and a run() that returns the saved row', () => {
    createService<UserEntity, { orgId: number }>(repository, {
      hooks: {
        create: async ({ input, context, run }) => {
          expectTypeOf(input).toEqualTypeOf<CreateInput<UserEntity>>();
          expectTypeOf(context.auth).toEqualTypeOf<{ orgId: number } | undefined>();
          expectTypeOf(run).parameter(0).toEqualTypeOf<Insert<UserEntity> | undefined>();
          expectTypeOf(run).returns.resolves.toEqualTypeOf<Row<UserEntity>>();
          return run();
        },
        update: async ({ id, patch, run }) => {
          expectTypeOf(id).toBeNumber();
          expectTypeOf(patch).toEqualTypeOf<UpdateInput<UserEntity>>();
          expectTypeOf(run).parameter(0).toEqualTypeOf<Patch<UserEntity> | undefined>();
          return run();
        },
        delete: async ({ id, context, run }) => {
          expectTypeOf(id).toBeNumber();
          expectTypeOf(context).toEqualTypeOf<ServiceContext<{ orgId: number }>>();
          expectTypeOf(run).parameters.toEqualTypeOf<[]>();
          return run();
        },
      },
    });
  });

  test('hooks get the repository with its custom methods typed', () => {
    const extended = repository.extend(() => ({ countActive: async () => 1 }));
    createService(extended, {
      hooks: {
        delete: async ({ repository, run }) => {
          expectTypeOf(repository).toEqualTypeOf<typeof extended>();
          expectTypeOf(repository.countActive).returns.resolves.toBeNumber();
          return run();
        },
      },
    });
    createService<UserEntity, { orgId: number }>(repository, {
      hooks: {
        delete: async ({ repository, run }) => {
          expectTypeOf(repository).toEqualTypeOf<CrudRepository<UserEntity>>();
          return run();
        },
      },
    });
  });

  test('a hook must return the row, so forgetting to return run() is a compile error', () => {
    createService(repository, {
      hooks: {
        // @ts-expect-error -- the hook returns nothing
        update: async ({ run }) => {
          await run();
        },
      },
    });
  });

  test('run() rejects a row that is missing a required hidden column', () => {
    createService(repository, {
      hooks: {
        create: ({ input, run }) => {
          // @ts-expect-error -- passwordHash is required in the insert
          return run({ ...input, orgId: 1 });
        },
      },
    });
  });
});

describe('soft delete by default', () => {
  const notes = pgTable('notes', { id: integer().primaryKey(), body: text().notNull() });

  test('a table without deletedAt must set softDelete', () => {
    // @ts-expect-error -- soft delete is on by default, and this table has no deletedAt column
    defineEntity(notes, { primaryKey: 'id' });
    defineEntity(notes, { primaryKey: 'id', softDelete: false });
  });

  test('the default deletedAt column is not accepted from clients', () => {
    const defaultEntity = defineEntity(userEntity.table, { primaryKey: 'id', create: { omit: ['id', 'createdAt'] } });
    expectTypeOf<CreateInput<typeof defaultEntity>>().not.toHaveProperty('deletedAt');
    expectTypeOf<UpdateInput<typeof defaultEntity>>().not.toHaveProperty('deletedAt');
  });
});
