import { drizzle } from 'drizzle-orm/pglite';
import { describe, expectTypeOf, test } from 'vitest';
import {
  createRepository,
  createService,
  defineEntity,
  type CrudRepositoryMethods,
  type ListResult,
  type Row,
  type ServiceContext,
} from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import { users } from './fixtures/schema.ts';

type UserEntity = typeof userEntity;
type Status = 'active' | 'invited' | 'banned';
const repository = createRepository(drizzle(), userEntity);
const service = createService<UserEntity, { orgId: number }>(repository);
declare const ctx: ServiceContext<{ orgId: number }>;

describe('repository finders', () => {
  test('one typed method per declared operator, returning a findMany page', () => {
    expectTypeOf(repository.findByStatus).parameter(0).toEqualTypeOf<Status>();
    expectTypeOf(repository.findByStatusIn).parameter(0).toEqualTypeOf<Status[]>();
    expectTypeOf(repository.findByNameContaining).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(repository.findByCreatedAtFrom).parameter(0).toEqualTypeOf<Date>();
    expectTypeOf(repository.findByCreatedAtUntil).parameter(0).toEqualTypeOf<Date>();
    expectTypeOf(repository.findByOrgId).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(repository.findByCreatedAtBetween).parameter(0).toEqualTypeOf<Date>();
    expectTypeOf(repository.findByCreatedAtBetween).parameter(1).toEqualTypeOf<Date>();
    expectTypeOf(repository.findByStatusIn(['active'])).resolves.toEqualTypeOf<ListResult<UserEntity>>();
  });

  test('columns narrows the items, as in findMany', async () => {
    const { items } = await repository.findByStatusIn(['active'], { columns: ['id', 'name'] });
    expectTypeOf(items).toEqualTypeOf<{ id: number; name: string }[]>();
    const between = await repository.findByCreatedAtBetween(new Date(), new Date(), { columns: ['email'] });
    expectTypeOf(between.items).toEqualTypeOf<{ email: string }[]>();
  });

  test('options: sort takes any visible column, where is a typed filter or SQL', () => {
    void repository.findByStatus('active', { sort: ['email', '-createdAt'], limit: 10, offset: 0, withTotal: true, where: { orgId__eq: 1 } });
    // @ts-expect-error -- passwordHash is hidden
    void repository.findByStatus('active', { sort: ['passwordHash'] });
    // @ts-expect-error -- email is not filterable
    void repository.findByStatus('active', { where: { email__eq: 'x' } });
    // @ts-expect-error -- hidden columns can't be selected
    void repository.findByStatus('active', { columns: ['passwordHash'] });
  });

  test('a wrong value type is an error', () => {
    // @ts-expect-error -- not a status
    void repository.findByStatus('ghost');
    // @ts-expect-error -- `in` takes an array
    void repository.findByStatusIn('active');
    // @ts-expect-error -- a Date, not a string
    void repository.findByCreatedAtFrom('2026-01-01');
    // @ts-expect-error -- Between takes both ends
    void repository.findByCreatedAtBetween(new Date());
  });

  test('undeclared finders do not exist', () => {
    expectTypeOf(repository).not.toHaveProperty('findByEmail');
    expectTypeOf(repository).not.toHaveProperty('findByNameIn');
    expectTypeOf(repository).not.toHaveProperty('findByName');
    expectTypeOf(repository).not.toHaveProperty('findByCreatedAt');
    expectTypeOf(repository).not.toHaveProperty('findByStatusBetween');
    expectTypeOf(repository).not.toHaveProperty('findByPasswordHash');
  });

  test('Between exists only with both gte and lte', () => {
    const onlyFrom = createRepository(drizzle(), defineEntity(users, { primaryKey: 'id', filterable: { createdAt: ['gte'] } }));
    expectTypeOf(onlyFrom).toHaveProperty('findByCreatedAtFrom');
    expectTypeOf(onlyFrom).not.toHaveProperty('findByCreatedAtBetween');
  });

  test('the primary key gets no eq finder: findById stays the built-in', () => {
    const entity = defineEntity(users, { primaryKey: 'id', filterable: { id: ['eq', 'in'] } });
    const byId = createRepository(drizzle(), entity);
    expectTypeOf(byId.findById).toEqualTypeOf<CrudRepositoryMethods<typeof entity>['findById']>();
    expectTypeOf(byId.findByIdIn).parameter(0).toEqualTypeOf<number[]>();
  });

  test('reusing a finder name in extend is a compile error', () => {
    repository.extend(() => ({
      // @ts-expect-error -- findByStatusIn is generated from filterable
      findByStatusIn: async () => 1,
    }));
    repository.extend(() => ({ a: 1 })).extend(() => ({
      // @ts-expect-error -- also on a chained extend
      findByCreatedAtBetween: async () => 1,
    }));
  });

  test('internals.orderBy takes visible sort specs only', () => {
    repository.extend(({ orderBy }) => {
      void orderBy();
      void orderBy(['-email', 'name']);
      // @ts-expect-error -- passwordHash is hidden
      void orderBy(['passwordHash']);
      return {};
    });
  });
});

describe('service finders', () => {
  test('the same names, with ctx after the value(s)', async () => {
    expectTypeOf(service.findByStatusIn).parameter(0).toEqualTypeOf<Status[]>();
    expectTypeOf(service.findByStatusIn).parameter(1).toEqualTypeOf<ServiceContext<{ orgId: number }>>();
    expectTypeOf(service.findByCreatedAtBetween).parameter(2).toEqualTypeOf<ServiceContext<{ orgId: number }>>();
    const { items } = await service.findByNameContaining('ann', ctx, { columns: ['name'], sort: ['-email'] });
    expectTypeOf(items).toEqualTypeOf<{ name: string }[]>();
    expectTypeOf(service.findByOrgId(1, ctx)).resolves.toEqualTypeOf<ListResult<UserEntity>>();
    // @ts-expect-error -- the ctx is required
    void service.findByStatus('active', { columns: ['id'] });
    // @ts-expect-error -- the ctx's auth type must match the service's
    void service.findByStatus('active', { log: console, auth: { orgId: 'one' } });
  });

  test('extended services keep the finders, and an extension cannot reuse a finder name', () => {
    const extended = service.extend((base) => ({
      activeIn: (orgId: number, context: ServiceContext<{ orgId: number }>) =>
        base.findByOrgId(orgId, context, { where: { status__eq: 'active' }, sort: ['name'] }),
    }));
    expectTypeOf(extended.activeIn).returns.resolves.toEqualTypeOf<ListResult<UserEntity>>();
    expectTypeOf(extended.findByStatus).toEqualTypeOf(service.findByStatus);
    service.extend(() => ({
      // @ts-expect-error -- findByStatus is generated from filterable
      findByStatus: () => 1,
    }));
  });

  test('a finder page holds visible rows', async () => {
    const { items } = await service.findByStatus('active', ctx);
    expectTypeOf(items).toEqualTypeOf<Row<UserEntity>[]>();
  });
});
