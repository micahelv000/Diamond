import { count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { crudRoutes } from '../src/fastify/index.ts';
import { BadRequestError, ConflictError, createRepository, createService, defineEntity, requireAuth, type Logger } from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import { users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';
import { as, useServer, type TestUser } from './helpers/server.ts';

const { db } = useTestDb();
const repo = createRepository(db, userEntity);
const service = createService<typeof userEntity, TestUser>(repo, {
  hooks: { beforeCreate: ({ input }) => ({ ...input, passwordHash: 'hashed' }) },
});

function fakeLogger() {
  const entries: { details: object; message: string | undefined }[] = [];
  const log: Logger = {
    debug: (details, message) => entries.push({ details, message }),
    warn: (details, message) => entries.push({ details, message }),
  };
  return { log, entries };
}

const names = (result: { items: { name: string }[] }) => result.items.map((item) => item.name);
const day = (date: string) => new Date(`${date}T00:00:00Z`);
// The generated finders on a repository or service (`findById` is the built-in).
const finderKeys = (target: object) => Object.keys(target).filter((key) => key.startsWith('findBy') && key !== 'findById').sort();

// The fixture's `filterable`: status ['eq', 'in'], name ['ilike'], createdAt ['gte', 'lte'], orgId ['eq'].
// Its defaultSort is '-createdAt' and its pagination is { defaultLimit: 2, maxLimit: 3 }.
beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
  const seed = (name: string, status: 'active' | 'invited' | 'banned', createdAt: string, orgId = 1) =>
    repo.create({ email: `${name}@x.io`, name, status, orgId, passwordHash: 'h', createdAt: day(createdAt) });
  await seed('Alice', 'active', '2026-01-01');
  await seed('Bob', 'invited', '2026-02-01');
  await seed('Carol', 'banned', '2026-03-01', 2);
  await seed('Alfred', 'active', '2026-04-01');
});

describe('repository finders', () => {
  test('one method per declared operator, plus Between, and no findBy<PrimaryKey>', () => {
    expect(finderKeys(repo)).toEqual(finderKeys(service));
    expect(finderKeys(repo)).toEqual([
      'findByCreatedAtBetween', 'findByCreatedAtFrom', 'findByCreatedAtUntil', 'findByNameContaining',
      'findByOrgId', 'findByStatus', 'findByStatusIn',
    ]);
  });

  test('every operator returns the right rows, in defaultSort order (-createdAt)', async () => {
    expect(names(await repo.findByStatus('active'))).toEqual(['Alfred', 'Alice']);
    expect(names(await repo.findByStatusIn(['invited', 'banned']))).toEqual(['Carol', 'Bob']);
    expect(names(await repo.findByNameContaining('AL'))).toEqual(['Alfred', 'Alice']);
    expect(names(await repo.findByCreatedAtFrom(day('2026-03-01')))).toEqual(['Alfred', 'Carol']);
    expect(names(await repo.findByCreatedAtUntil(day('2026-02-01')))).toEqual(['Bob', 'Alice']);
    expect(names(await repo.findByCreatedAtBetween(day('2026-02-01'), day('2026-03-01')))).toEqual(['Carol', 'Bob']);
    expect(names(await repo.findByOrgId(2))).toEqual(['Carol']);
  });

  test('ilike treats % and _ literally, as findMany does', async () => {
    await repo.create({ email: 'p@x.io', name: '100% done', orgId: 1, passwordHash: 'h' });
    expect(names(await repo.findByNameContaining('%'))).toEqual(['100% done']);
  });

  test('sort: the caller\'s sort wins, else defaultSort; any visible column, ties broken by the primary key', async () => {
    expect(names(await repo.findByOrgId(1, { limit: 3 }))).toEqual(['Alfred', 'Bob', 'Alice']);
    expect(names(await repo.findByOrgId(1, { sort: ['name'], limit: 3 }))).toEqual(['Alfred', 'Alice', 'Bob']);
    // `status` isn't in `sortable`; the enum sorts in declaration order (active, invited, banned).
    expect(names(await repo.findByOrgId(1, { sort: ['-status'], limit: 3 }))).toEqual(['Bob', 'Alice', 'Alfred']);
  });

  test('options: columns, limit, offset and withTotal work as in findMany', async () => {
    const page = await repo.findByOrgId(1, { columns: ['id', 'name'], sort: ['name'], limit: 1, offset: 1, withTotal: true });
    expect(page).toEqual({ items: [{ id: 1, name: 'Alice' }], limit: 1, offset: 1, nextCursor: expect.any(String), total: 3 });
    // The fixture's defaultLimit (2) and maxLimit (3) apply too.
    expect((await repo.findByOrgId(1)).items).toHaveLength(2);
    expect((await repo.findByOrgId(1, { limit: 50 })).limit).toBe(3);
  });

  test('an extra where, filter object or SQL, is ANDed with the finder\'s condition', async () => {
    expect(names(await repo.findByOrgId(1, { where: { status__eq: 'active' }, limit: 3 }))).toEqual(['Alfred', 'Alice']);
    expect(names(await repo.findByOrgId(1, { where: sql`length(${users.name}) = 3` }))).toEqual(['Bob']);
    // The same key in both is ANDed, not overwritten.
    expect(names(await repo.findByStatusIn(['active', 'invited'], { where: { status__in: ['invited', 'banned'] } }))).toEqual(['Bob']);
  });

  test('an extra where with a key outside filterable is a BadRequestError', async () => {
    // @ts-expect-error -- email is not filterable
    await expect(repo.findByOrgId(1, { where: { email__eq: 'x' } })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('scope and soft delete apply', async () => {
    expect(names(await repo.findByStatus('active', { scope: eq(users.orgId, 2) }))).toEqual([]);
    await repo.delete(4);
    expect(names(await repo.findByStatus('active'))).toEqual(['Alice']);
  });

  test('Between exists only when the column declares both gte and lte', async () => {
    const onlyFrom = createRepository(db, defineEntity(users, { primaryKey: 'id', filterable: { createdAt: ['gte'] } }));
    expect(finderKeys(onlyFrom)).toEqual(['findByCreatedAtFrom']);
    expect(names(await onlyFrom.findByCreatedAtFrom(day('2026-04-01')))).toEqual(['Alfred']);
  });

  test('the primary key\'s eq generates no finder: findById stays the built-in', async () => {
    const byId = createRepository(db, defineEntity(users, { primaryKey: 'id', filterable: { id: ['eq', 'in'] } }));
    expect(finderKeys(byId)).toEqual(['findByIdIn']);
    expect(await byId.findById(2, { columns: ['name'] })).toEqual({ name: 'Bob' });
    expect(names(await byId.findByIdIn([1, 3]))).toEqual(['Alice', 'Carol']);
  });
});

describe('service finders', () => {
  test('return the same rows through ctx and log like findMany', async () => {
    const { log, entries } = fakeLogger();
    expect(names(await service.findByStatusIn(['invited', 'banned'], { log }))).toEqual(['Carol', 'Bob']);
    expect(names(await service.findByCreatedAtBetween(day('2026-02-01'), day('2026-03-01'), { log }, { sort: ['name'] }))).toEqual(['Bob', 'Carol']);
    const page = await service.findByNameContaining('al', { log }, { columns: ['name'], limit: 1 });
    expect(page.items).toEqual([{ name: 'Alfred' }]);
    const calls = entries.filter((entry) => entry.message === 'repository call');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.details).toEqual({ entity: 'users', op: 'findMany', id: undefined, durationMs: expect.any(Number) });
    expect(entries.filter((entry) => entry.message === 'sql')).toHaveLength(3);
  });

  test('honour ctx.scope and soft delete', async () => {
    const { log } = fakeLogger();
    expect(names(await service.findByStatus('active', { log, scope: eq(users.orgId, 2) }))).toEqual([]);
    expect(names(await service.findByOrgId(2, { log, scope: eq(users.orgId, 2) }))).toEqual(['Carol']);
    await service.delete(1, { log });
    expect(names(await service.findByStatus('active', { log }))).toEqual(['Alfred']);
  });

  test('a bad extra where rejects through the service', async () => {
    const { log } = fakeLogger();
    // @ts-expect-error -- name only allows ilike
    await expect(service.findByOrgId(1, { log }, { where: { name__eq: 'Bob' } })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('a finder called with undefined', () => {
  // A missing optional query param often arrives as undefined; it must not turn into "match every row".
  type Call = (log: Logger) => Promise<unknown>;
  const calls: Record<'repository' | 'service', Record<string, Call>> = {
    repository: {
      // @ts-expect-error -- undefined is not a valid value
      findByStatus: (log) => repo.findByStatus(undefined, { log }),
      // @ts-expect-error -- undefined is not a valid value
      findByStatusIn: (log) => repo.findByStatusIn(undefined, { log }),
      // @ts-expect-error -- undefined is not a valid value
      'findByCreatedAtBetween (from)': (log) => repo.findByCreatedAtBetween(undefined, day('2026-03-01'), { log }),
      // @ts-expect-error -- undefined is not a valid value
      'findByCreatedAtBetween (to)': (log) => repo.findByCreatedAtBetween(day('2026-02-01'), undefined, { log }),
    },
    service: {
      // @ts-expect-error -- undefined is not a valid value
      findByStatus: (log) => service.findByStatus(undefined, { log }),
      // @ts-expect-error -- undefined is not a valid value
      findByStatusIn: (log) => service.findByStatusIn(undefined, { log }),
      // @ts-expect-error -- undefined is not a valid value
      'findByCreatedAtBetween (from)': (log) => service.findByCreatedAtBetween(undefined, day('2026-03-01'), { log }),
      // @ts-expect-error -- undefined is not a valid value
      'findByCreatedAtBetween (to)': (log) => service.findByCreatedAtBetween(day('2026-02-01'), undefined, { log }),
    },
  };

  for (const [label, finders] of Object.entries(calls)) {
    for (const [finder, call] of Object.entries(finders)) {
      test(`${label} ${finder} rejects with BadRequestError without querying`, async () => {
        const { log, entries } = fakeLogger();
        // Calling must not throw synchronously; the error arrives as a rejection.
        const result = call(log);
        const error = await result.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BadRequestError);
        expect((error as Error).message).toContain(finder.split(' ')[0]);
        expect(entries.filter((entry) => entry.message === 'sql')).toHaveLength(0);
      });
    }
  }

  test('null still means IS NULL for an eq finder', async () => {
    // @ts-expect-error -- null is not in the finder's type, but untyped callers can pass it
    expect(names(await repo.findByStatus(null))).toEqual([]);
  });
});

describe('service finders in a route transaction', () => {
  const app = useServer({
    register: (instance) =>
      instance.register(
        crudRoutes({
          service,
          context: (request) => request.user ?? undefined,
          authorize: { '*': requireAuth },
          extend: (scope, { service: users, serviceContext }) => {
            // Creates a row, finds it with a finder in the same transaction, then fails.
            scope.post('/create-then-find', { config: { crudOperation: 'create' } }, async (request) => {
              const ctx = serviceContext(request);
              await users.create({ email: 'new@x.io', name: 'Newbie', orgId: 1 }, ctx);
              const found = await users.findByNameContaining('newbie', ctx, { columns: ['name'] });
              throw new ConflictError(`found ${found.items.map((item) => item.name).join(',')}`);
            });
          },
        }),
        { prefix: '/users' },
      ),
  });

  test('see the request\'s own uncommitted writes and roll back with it', async () => {
    const admin: TestUser = { id: 1, orgId: 1, roles: ['admin'] };
    const response = await app().inject({ method: 'POST', url: '/users/create-then-find', headers: as(admin) });
    expect(response.json()).toEqual({ code: 'CONFLICT', message: 'found Newbie' });
    expect((await db.select({ n: count() }).from(users).where(eq(users.name, 'Newbie')))[0]?.n).toBe(0);
  });
});
