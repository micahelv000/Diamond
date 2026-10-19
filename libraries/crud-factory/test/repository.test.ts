import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  BadRequestError, ConflictError, createRepository, defineEntity, mapDatabaseError, NotFoundError, type EntityConfig,
  type QueryOptions, type SortSpec,
} from '../src/index.ts';
import { postEntity, userEntity } from './fixtures/entities.ts';
import { posts, users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';

const testDb = useTestDb();
const { db } = testDb;
const userRepository = createRepository(db, userEntity);
const postRepository = createRepository(db, postEntity);

function newUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return { email: `${suffix}@example.com`, name: `User ${suffix}`, passwordHash: 'secret', orgId: 1, ...overrides };
}

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});

describe('CRUD round trip', () => {
  test('create, read, update, delete', async () => {
    const created = await userRepository.create(newUser({ name: 'Ada' }));
    expect(created).toMatchObject({ id: 1, name: 'Ada', status: 'invited' });
    expect(created).not.toHaveProperty('passwordHash');

    expect(await userRepository.findById(created.id)).toEqual(created);

    const updated = await userRepository.update(created.id, { name: 'Ada L.', status: 'active' });
    expect(updated).toMatchObject({ name: 'Ada L.', status: 'active' });

    await userRepository.delete(created.id);
    expect(await userRepository.findById(created.id)).toBeNull();
  });

  test('a missing id is null on read and NotFound on write', async () => {
    expect(await userRepository.findById(999)).toBeNull();
    await expect(userRepository.update(999, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(userRepository.delete(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  test('an empty patch is a BadRequestError', async () => {
    const created = await userRepository.create(newUser());
    await expect(userRepository.update(created.id, {})).rejects.toBeInstanceOf(BadRequestError);
  });

  test('a unique violation becomes ConflictError with the constraint name', async () => {
    await userRepository.create(newUser({ email: 'dup@example.com' }));
    const error = await userRepository.create(newUser({ email: 'dup@example.com' })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: 'CONFLICT', statusCode: 409, constraint: 'users_email_unique' });
  });

  test('a missing foreign key on create is a 400, a still-referenced row on delete is a 409', async () => {
    await expect(postRepository.create({ authorId: 999, orgId: 1, title: 'Orphan' })).rejects.toMatchObject({ statusCode: 400 });

    // With soft delete turned off, deleting a user that has posts hits the foreign key.
    const hardDeleteUsers = createRepository(db, defineEntity(users, { primaryKey: 'id', softDelete: false }));
    const author = await hardDeleteUsers.create(newUser());
    await postRepository.create({ authorId: author.id, orgId: 1, title: 'Keeps the author' });
    const error = await hardDeleteUsers.delete(author.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ statusCode: 409, message: 'Resource is still referenced' });
  });

  test('soft delete is on by default for a table with a deletedAt column', async () => {
    const defaultUsers = createRepository(db, defineEntity(users, { primaryKey: 'id' }));
    const user = await defaultUsers.create(newUser());

    await defaultUsers.delete(user.id);

    expect(await defaultUsers.findById(user.id)).toBeNull();
    const [stored] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, user.id));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

  test('softDelete: false turns it off, so delete removes the row', async () => {
    const hardDeleteUsers = createRepository(db, defineEntity(users, { primaryKey: 'id', softDelete: false }));
    const user = await hardDeleteUsers.create(newUser());

    await hardDeleteUsers.delete(user.id);

    expect(await db.select().from(users).where(eq(users.id, user.id))).toEqual([]);
  });

  test('ConflictError takes the message first, and defaults it', () => {
    expect(new ConflictError()).toMatchObject({ message: 'Resource already exists', constraint: undefined, statusCode: 409 });
    const cause = new Error('driver');
    expect(new ConflictError('Aircraft busy', { constraint: 'c', cause })).toMatchObject({ message: 'Aircraft busy', constraint: 'c', cause });
  });

  test('out-of-range numbers and dates are a BadRequestError', async () => {
    await expect(postRepository.create({ authorId: 2 ** 31, orgId: 1, title: 'x' })).rejects.toBeInstanceOf(BadRequestError);
    // A JS Date can't express a timestamp Postgres rejects with 22008, so the mapping is checked directly.
    expect(mapDatabaseError({ code: '22008' })).toBeInstanceOf(BadRequestError);
  });

  test('too-long strings and malformed dates are a BadRequestError', () => {
    // No fixture column has a length limit, so the mapping is checked directly.
    expect(mapDatabaseError({ code: '22001' })).toMatchObject({ code: 'BAD_REQUEST', message: 'Value too long' });
    expect(mapDatabaseError({ code: '22007' })).toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid date or time format' });
  });

  test('an exclusion violation is a ConflictError that keeps the constraint', () => {
    const driverError = { code: '23P01', constraint: 'bookings_no_overlap' };
    const error = mapDatabaseError(new Error('wrapped', { cause: driverError }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ statusCode: 409, constraint: 'bookings_no_overlap' });
  });

  test.each(['40001', '40P01'])('%s (concurrent change) is a retryable ConflictError, found through the cause chain', (code) => {
    const driverError = { code };
    const error = mapDatabaseError(new Error('outer', { cause: new Error('drizzle', { cause: driverError }) }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/concurrent change.*retry/), cause: expect.any(Error) });
  });

  test('an already soft-deleted row is a NotFoundError on update and delete', async () => {
    const created = await userRepository.create(newUser());
    await userRepository.delete(created.id);
    await expect(userRepository.update(created.id, { name: 'back' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(userRepository.delete(created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('findMany', () => {
  beforeEach(async () => {
    await userRepository.create(newUser({ name: 'Alice', status: 'active', createdAt: new Date('2026-01-01') }));
    await userRepository.create(newUser({ name: 'Bob', status: 'invited', createdAt: new Date('2026-02-01') }));
    await userRepository.create(newUser({ name: 'Carol', status: 'banned', createdAt: new Date('2026-03-01') }));
    await userRepository.create(newUser({ name: 'Alfred', status: 'active', createdAt: new Date('2026-04-01') }));
  });
  const names = (items: { name: string }[]) => items.map((item) => item.name);

  test('eq, in, ilike and range filters', async () => {
    const big = { limit: 3 };
    expect(names((await userRepository.findMany({ ...big, where: { status__eq: 'active' } })).items)).toEqual(['Alfred', 'Alice']);
    expect(names((await userRepository.findMany({ ...big, where: { status__in: ['invited', 'banned'] } })).items)).toEqual(['Carol', 'Bob']);
    expect(names((await userRepository.findMany({ ...big, where: { name__ilike: 'AL' } })).items)).toEqual(['Alfred', 'Alice']);
    const range = { createdAt__gte: new Date('2026-02-01'), createdAt__lte: new Date('2026-03-01') };
    expect(names((await userRepository.findMany({ ...big, where: range })).items)).toEqual(['Carol', 'Bob']);
  });

  test('a raw SQL chunk works as where', async () => {
    const result = await userRepository.findMany({ where: sql`length(${users.name}) = 3` });
    expect(names(result.items)).toEqual(['Bob']);
  });

  test('limit defaults, clamps to maxLimit, and total uses a count query', async () => {
    expect((await userRepository.findMany()).items).toHaveLength(2);
    const clamped = await userRepository.findMany({ limit: 50, withTotal: true });
    expect(clamped).toMatchObject({ limit: 3, offset: 0, total: 4 });
    expect(clamped.items).toHaveLength(3);
  });

  // The names share a case, so they sort the same under the C and en_US collations.
  test('sorts by default spec, explicit spec, and paginates with offset', async () => {
    expect(names((await userRepository.findMany()).items)).toEqual(['Alfred', 'Carol']);
    expect(names((await userRepository.findMany({ sort: ['name'], limit: 3 })).items)).toEqual(['Alfred', 'Alice', 'Bob']);
    expect(names((await userRepository.findMany({ sort: ['name'], limit: 2, offset: 2 })).items)).toEqual(['Bob', 'Carol']);
  });

  test('code can sort by any visible column, not only sortable ones', async () => {
    // `status` and `email` aren't in `sortable`; the enum sorts in declaration order (active, invited, banned).
    expect(names((await userRepository.findMany({ sort: ['status', '-name'], limit: 3 })).items)).toEqual(['Alice', 'Alfred', 'Bob']);
  });

  test('internals.orderBy gives a custom query the caller\'s sort, else defaultSort, with the primary key last', async () => {
    const repository = createRepository(db, userEntity).extend(({ scoped, table, project, orderBy }) => ({
      listNames: async ({ sort, ...options }: QueryOptions & { sort?: readonly SortSpec<typeof userEntity>[] } = {}) => {
        const query = scoped(options);
        return query.run(query.db.select(project(['name'])).from(table).where(query.where()).orderBy(...orderBy(sort)));
      },
      clauses: orderBy,
    }));
    // No sort: defaultSort ('-createdAt').
    expect(names(await repository.listNames())).toEqual(['Alfred', 'Carol', 'Bob', 'Alice']);
    expect(names(await repository.listNames({ sort: ['name'] }))).toEqual(['Alfred', 'Alice', 'Bob', 'Carol']);
    // `status` isn't sortable from the URL; ties (two active users) are broken by the primary key.
    expect(names(await repository.listNames({ sort: ['status'] }))).toEqual(['Alice', 'Alfred', 'Bob', 'Carol']);
    // The primary key is appended once, unless the sort already uses it.
    expect(repository.clauses()).toHaveLength(2);
    expect(repository.clauses(['-id'])).toHaveLength(1);
    // @ts-expect-error -- passwordHash is hidden
    await expect(repository.listNames({ sort: ['passwordHash'] })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('a hidden column can never be sorted on: a type error and a BadRequestError (400)', async () => {
    // @ts-expect-error -- passwordHash is hidden
    const sorted = userRepository.findMany({ sort: ['passwordHash'] });
    await expect(sorted).rejects.toMatchObject({ statusCode: 400, message: 'Cannot sort by "passwordHash"' });
    // @ts-expect-error -- not a column at all
    await expect(userRepository.findMany({ sort: ['-nope'] })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('columns narrows the selected keys', async () => {
    const { items } = await userRepository.findMany({ columns: ['id', 'name'], limit: 1 });
    expect(items).toEqual([{ id: 4, name: 'Alfred' }]);
  });

  test('ilike treats % and _ as literal characters', async () => {
    await userRepository.create(newUser({ name: 'axb' }));
    await userRepository.create(newUser({ name: 'a_b' }));
    await userRepository.create(newUser({ name: '100% done' }));
    expect(names((await userRepository.findMany({ where: { name__ilike: 'a_b' } })).items)).toEqual(['a_b']);
    expect(names((await userRepository.findMany({ where: { name__ilike: '%' } })).items)).toEqual(['100% done']);
  });

  test('soft-deleted rows disappear from reads and the row is kept', async () => {
    await userRepository.delete(1);
    const result = await userRepository.findMany({ withTotal: true });
    expect(result.total).toBe(3);
    const [stored] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, 1));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('list limit', () => {
  // 30 posts: more than any limit used below, so a missing or wrong limit shows up as a wrong count.
  const POST_COUNT = 30;
  beforeEach(async () => {
    const author = await userRepository.create(newUser());
    const rows = Array.from({ length: POST_COUNT }, (_, i) => ({ authorId: author.id, orgId: 1, title: `Post ${i}` }));
    await db.insert(posts).values(rows);
  });
  const postsWith = (pagination: EntityConfig<typeof posts>['pagination']) =>
    createRepository(db, defineEntity(posts, { primaryKey: 'id', softDelete: false, pagination }));

  test('without pagination config, a list defaults to 25 rows', async () => {
    const result = await postRepository.findMany();
    expect(result.items).toHaveLength(25);
    expect(result.limit).toBe(25);
  });

  test('without pagination config, a requested limit is capped at 100', async () => {
    expect((await postRepository.findMany({ limit: POST_COUNT })).items).toHaveLength(POST_COUNT);
    expect((await postRepository.findMany({ limit: 500 })).limit).toBe(100);
  });

  test('without pagination config, offset still pages through the rest', async () => {
    const result = await postRepository.findMany({ offset: 20 });
    expect(result.items).toHaveLength(POST_COUNT - 20);
    expect(result).toMatchObject({ limit: 25, offset: 20 });
  });

  test('maxLimit alone is the default page size and caps larger requests', async () => {
    const repository = postsWith({ maxLimit: 10 });
    expect(await repository.findMany()).toMatchObject({ limit: 10 });
    expect((await repository.findMany()).items).toHaveLength(10);
    expect((await repository.findMany({ limit: 500 })).items).toHaveLength(10);
    expect((await repository.findMany({ limit: 4 })).items).toHaveLength(4);
  });

  test('defaultLimit alone sets the page size and keeps the default cap', async () => {
    const repository = postsWith({ defaultLimit: 5 });
    expect((await repository.findMany()).items).toHaveLength(5);
    expect((await repository.findMany({ limit: 20 })).items).toHaveLength(20);
    expect((await repository.findMany({ limit: 500 })).limit).toBe(100);
  });

  test('defaultLimit and maxLimit together: default when not asked, capped when asked for too many', async () => {
    const repository = postsWith({ defaultLimit: 5, maxLimit: 8 });
    expect((await repository.findMany()).items).toHaveLength(5);
    expect((await repository.findMany({ limit: 100 })).items).toHaveLength(8);
  });

  test('a limit below 1 is raised to 1', async () => {
    expect((await postRepository.findMany({ limit: 0 })).items).toHaveLength(1);
  });
});

describe('scope', () => {
  test('a foreign-tenant row is invisible and cannot be updated or deleted', async () => {
    const foreign = await userRepository.create(newUser({ orgId: 2 }));
    const scope = eq(users.orgId, 1);
    expect(await userRepository.findById(foreign.id, { scope })).toBeNull();
    expect((await userRepository.findMany({ scope, withTotal: true })).total).toBe(0);
    await expect(userRepository.update(foreign.id, { name: 'hijack' }, { scope })).rejects.toBeInstanceOf(NotFoundError);
    await expect(userRepository.delete(foreign.id, { scope })).rejects.toBeInstanceOf(NotFoundError);
    expect(await userRepository.findById(foreign.id)).toMatchObject({ name: foreign.name });
  });
});

describe('hidden columns', () => {
  test('cannot be filtered or sorted on, even when the config check is bypassed', async () => {
    await userRepository.create(newUser({ passwordHash: 'secret' }));
    // Simulates a config that skipped `defineEntity` validation.
    const config: EntityConfig<typeof users> = { ...userEntity.config, filterable: { passwordHash: ['eq'] }, sortable: ['passwordHash'] };
    const leaky = createRepository(db, { ...userEntity, config });
    await expect(leaky.findMany({ where: { passwordHash__eq: 'secret' } })).rejects.toBeInstanceOf(BadRequestError);
    // @ts-expect-error -- hidden columns aren't sortable in the types either
    await expect(leaky.findMany({ sort: ['passwordHash'] })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('are absent from the generated SQL and results', async () => {
    const { db: loggedDb, queries } = recordingDb();
    const repository = createRepository(loggedDb, userEntity);
    const created = await repository.create(newUser());
    await repository.findMany();
    await repository.findById(created.id);
    await repository.update(created.id, { name: 'renamed' });
    await repository.delete(created.id);
    expect(created).not.toHaveProperty('passwordHash');
    const selects = queries.filter((query) => /select|returning/i.test(query));
    expect(selects.length).toBeGreaterThanOrEqual(5);
    for (const query of selects) {
      const projection = query.replace(/^insert into "users" \([^)]*\)/i, '');
      expect(projection).not.toContain('password_hash');
    }
  });
});

describe('transactions', () => {
  test('tx option runs inside the transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        await userRepository.create(newUser({ name: 'Rolled back' }), { tx });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await userRepository.findMany({ withTotal: true })).total).toBe(0);
  });
});

describe('extend', () => {
  test('a join query through scoped(options) hides soft-deleted rows and rows outside the scope', async () => {
    const repository = createRepository(db, userEntity).extend(({ scoped, table, project }) => ({
      findWithPostCounts: (options: QueryOptions = {}) => {
        const query = scoped(options);
        return query.run(query.db
          .select({ ...project(['id', 'name']), postCount: sql<number>`count(${posts.id})`.mapWith(Number) })
          .from(table)
          .leftJoin(posts, eq(posts.authorId, table.id))
          .where(query.where())
          .groupBy(table.id)
          .orderBy(table.id));
      },
    }));
    const author = await repository.create(newUser({ name: 'Author' }));
    const reader = await repository.create(newUser({ name: 'Reader' }));
    const deleted = await repository.create(newUser({ name: 'Gone' }));
    const otherTenant = await repository.create(newUser({ name: 'Other org', orgId: 2 }));
    await postRepository.create({ authorId: author.id, orgId: 1, title: 'One' });
    await postRepository.create({ authorId: author.id, orgId: 1, title: 'Two' });
    await repository.delete(deleted.id);

    const authorAndReader = [
      { id: author.id, name: 'Author', postCount: 2 },
      { id: reader.id, name: 'Reader', postCount: 0 },
    ];
    expect(await repository.findWithPostCounts()).toEqual([...authorAndReader, { id: otherTenant.id, name: 'Other org', postCount: 0 }]);
    expect(await repository.findWithPostCounts({ scope: eq(users.orgId, 1) })).toEqual(authorAndReader);
    // The built-in findMany sees the same rows under the same scope.
    const scoped = await repository.findMany({ columns: ['name'], sort: ['name'], scope: eq(users.orgId, 1) });
    expect(scoped.items).toEqual([{ name: 'Author' }, { name: 'Reader' }]);
  });
});

describe('extend safety nets', () => {
  // Plain `async` methods with no `run`: only the automatic wrapping can map their errors.
  const rawPosts = createRepository(db, postEntity).extend(({ scoped, table }) => ({
    insertRaw: async (authorId: number) => {
      await scoped().db.insert(table).values({ authorId, orgId: 1, title: 'Raw' });
    },
  }));
  const rawUsers = createRepository(db, userEntity).extend(({ scoped, table }) => ({
    insertRaw: async (email: string) => {
      await scoped().db.insert(table).values(newUser({ email }));
    },
  }));

  test('a foreign key violation in a custom method is a BadRequestError', async () => {
    await expect(rawPosts.insertRaw(999)).rejects.toBeInstanceOf(BadRequestError);
  });

  test('a unique violation in a custom method is a ConflictError with the constraint name', async () => {
    await rawUsers.insertRaw('dup@example.com');
    const error = await rawUsers.insertRaw('dup@example.com').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ statusCode: 409, constraint: 'users_email_unique' });
  });

  test('scoped(options).run runs the query and maps errors', async () => {
    // Called directly, not from an extend method, so the automatic wrapping can't do `run`'s job for it.
    const repository = createRepository(db, userEntity).extend((internals) => ({ internals: () => internals }));
    const { scoped, table } = repository.internals();
    const query = scoped();
    const created = await repository.create(newUser({ email: 'secret@example.com' }));

    const ids = await query.run(query.db.select({ id: table.id }).from(table).where(query.where(eq(table.email, 'secret@example.com'))));
    expect(ids).toEqual([{ id: created.id }]);

    const duplicate = query.run(query.db.insert(table).values(newUser({ email: 'secret@example.com' })));
    await expect(duplicate).rejects.toBeInstanceOf(ConflictError);
  });
});

function recordingDb() {
  const queries: string[] = [];
  const loggedDb = drizzle({ client: testDb.client, logger: { logQuery: (query) => queries.push(query) } });
  return { db: loggedDb, queries };
}
