import { count, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { crudRoutes, type CrudRoutesOptions } from '../src/fastify/index.ts';
import { ConflictError, createRepository, createService, requireRole, type QueryOptions, type ServiceContext } from '../src/index.ts';
import { postEntity, userEntity } from './fixtures/entities.ts';
import { posts, users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';
import { as, captureLogs, useServer, type TestUser } from './helpers/server.ts';

const { db } = useTestDb();

const userRepo = createRepository(db, userEntity);
const userService = createService<typeof userEntity, TestUser>(userRepo, {
  hooks: {
    // Writes a row of its own, then fails for one name: the hook's write must be rolled back too.
    beforeCreate: async ({ input, context }) => {
      if (input.name === 'Hook fails') {
        await userRepo.create({ ...input, email: `audit-${input.email}`, passwordHash: 'h' }, { tx: context.tx, log: context.log });
        throw new ConflictError('Rejected after a write');
      }
      return { ...input, passwordHash: 'secret-hash' };
    },
  },
});
// A custom method: a plain function over `base.update`, so it joins whatever transaction `context` carries.
const extendedUserService = userService.extend((base) => ({
  rename: (id: number, name: string, context: ServiceContext<TestUser>) => base.update(id, { name }, context),
}));
// A custom query that writes through `scoped(options).db`, so it joins whatever transaction the options carry.
const customUserRepo = userRepo.extend(({ scoped, table }) => ({
  insertDirectly: async (email: string, options: QueryOptions) => {
    const query = scoped(options);
    await query.run(query.db.insert(table).values({ ...newUser(email), passwordHash: 'h' }));
  },
}));
const postService = createService<typeof postEntity, TestUser>(createRepository(db, postEntity), {
  hooks: { beforeCreate: ({ input }) => ({ ...input, orgId: 10 }) },
});

const admin: TestUser = { id: 1, orgId: 10, roles: ['admin'] };
const member: TestUser = { id: 2, orgId: 10, roles: ['member'] };
const newUser = (email: string, name = 'Ann') => ({ email, name, orgId: 10 });

const countUsers = async () => (await db.select({ n: count() }).from(users))[0]?.n;
const countPosts = async () => (await db.select({ n: count() }).from(posts))[0]?.n;

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The same user routes with `transaction` on or off, plus custom routes that write more than once. */
function userRoutes(transaction: boolean | undefined) {
  const options: CrudRoutesOptions<typeof userEntity, TestUser, typeof extendedUserService> = {
    service: extendedUserService,
    transaction,
    context: (request) => request.user ?? undefined,
    authorize: { '*': () => true, delete: requireRole('admin') },
    extend: (scope, { service, serviceContext }) => {
      // Two creates; the second one reuses the email, so it fails with a 409 after the first succeeded.
      scope.post('/pair', { config: { crudOperation: 'create' } }, async (request) => {
        const context = serviceContext(request);
        await service.create(newUser('first@x.io', 'First'), context);
        return service.create(newUser('first@x.io', 'Second'), context);
      });
      // Writes to two entities through their own services, then fails.
      scope.post('/with-post', { config: { crudOperation: 'create' } }, async (request) => {
        const context = serviceContext(request);
        const user = await service.create(newUser('author@x.io'), context);
        await postService.create({ authorId: user.id, title: 'Hello' }, context);
        throw new ConflictError('Failed after both writes');
      });
      // Renames through the custom service method, then fails: the rename must be rolled back.
      scope.post('/:id/rename', { config: { crudOperation: 'update' }, schema: { params: userEntity.schemas.params } }, async (request) => {
        await service.rename(request.params.id, 'Renamed', serviceContext(request));
        throw new ConflictError('Failed after the rename');
      });
      // Writes through a custom repository query, then fails: the write must be rolled back.
      scope.post('/custom-query', { config: { crudOperation: 'create' } }, async (request) => {
        await customUserRepo.insertDirectly('custom@x.io', serviceContext(request));
        throw new ConflictError('Failed after the custom query');
      });
      // Sends the reply itself: rejected inside the transaction, allowed without one.
      scope.post('/sent', { config: { crudOperation: 'create' } }, async (request, reply) => {
        const row = await service.create(newUser('sent@x.io'), serviceContext(request));
        return reply.status(201).send({ id: row.id });
      });
    },
  };
  return crudRoutes(options);
}

describe('transaction: true (default)', () => {
  const logs = captureLogs();
  const app = useServer({
    logger: logs.logger,
    register: (app) => app.register(userRoutes(undefined), { prefix: '/users' }),
  });

  test('a custom route that fails on its second write rolls back the first', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/pair', headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONFLICT' });
    expect(await countUsers()).toBe(0);
  });

  test('writes to two entities in one route roll back together', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/with-post', headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'CONFLICT', message: 'Failed after both writes' });
    expect([await countUsers(), await countPosts()]).toEqual([0, 0]);
  });

  test('a custom service method rolls back with the request transaction when the route then throws', async () => {
    const [user] = await db.insert(users).values({ ...newUser('r@x.io'), passwordHash: 'h' }).returning({ id: users.id });
    const response = await app().inject({ method: 'POST', url: `/users/${user?.id}/rename`, headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'CONFLICT', message: 'Failed after the rename' });
    expect((await db.select({ name: users.name }).from(users))[0]?.name).toBe('Ann');
  });

  test('a custom query written with scoped(context) rolls back with the request transaction', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/custom-query', headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'CONFLICT', message: 'Failed after the custom query' });
    expect(await countUsers()).toBe(0);
  });

  test('a service hook that writes and then throws rolls its write back', async () => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('h@x.io', 'Hook fails') });
    expect(response.statusCode).toBe(409);
    expect(await countUsers()).toBe(0);
  });

  test('a generated route commits: the row is readable in a later request', async () => {
    const created = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('c@x.io') });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: number }>();
    const got = await app().inject({ method: 'GET', url: `/users/${id}`, headers: as(admin) });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id, email: 'c@x.io' });
    expect((await app().inject({ method: 'DELETE', url: `/users/${id}`, headers: as(admin) })).statusCode).toBe(204);
  });

  test('reply.send() inside the handler is a generic 500 and its write rolls back', async () => {
    const before = logs.lines.length;
    const response = await app().inject({ method: 'POST', url: '/users/sent', headers: as(admin) });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' });
    expect(await countUsers()).toBe(0);
    const logged = logs.lines.slice(before).find((line) => line.msg === 'unhandled error in CRUD route');
    expect(logged).toMatchObject({ error: { name: 'ReplySentInTransactionError' } });
  });

  test('the generated create still sets 201 with reply.status() and returns the row', async () => {
    await app().inject({ method: 'POST', url: '/users/sent', headers: as(admin) });
    const created = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('next@x.io') });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: 'next@x.io' });
  });

  test('a 403 never opens a transaction or runs SQL', async () => {
    const created = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('d@x.io') });
    const { id } = created.json<{ id: number }>();
    const transaction = vi.spyOn(userRepo.db, 'transaction');
    const before = logs.lines.length;

    const denied = await app().inject({ method: 'DELETE', url: `/users/${id}`, headers: as(member) });
    expect(denied.statusCode).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(logs.lines.slice(before).some((line) => line.msg === 'sql')).toBe(false);

    // The same request by an admin does open one, so the spy is watching the right database.
    expect((await app().inject({ method: 'DELETE', url: `/users/${id}`, headers: as(admin) })).statusCode).toBe(204);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('unknown paths still get the not-found handler', async () => {
    const response = await app().inject({ method: 'GET', url: '/users/1/nope', headers: as(admin) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'NOT_FOUND', message: 'Route GET /users/1/nope not found' });
  });
});

describe('transaction: false', () => {
  const app = useServer({ register: (app) => app.register(userRoutes(false), { prefix: '/users' }) });

  test('each statement commits on its own: the first write survives the failure', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/pair', headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(await countUsers()).toBe(1);
  });

  test('a custom service method\'s write survives the failure after it', async () => {
    const [user] = await db.insert(users).values({ ...newUser('s@x.io'), passwordHash: 'h' }).returning({ id: users.id });
    const response = await app().inject({ method: 'POST', url: `/users/${user?.id}/rename`, headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect((await db.select({ name: users.name }).from(users))[0]?.name).toBe('Renamed');
  });

  test('a custom query\'s write survives the failure after it', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/custom-query', headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(await countUsers()).toBe(1);
  });

  test('a handler may send the reply itself, and its write commits', async () => {
    const response = await app().inject({ method: 'POST', url: '/users/sent', headers: as(admin) });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 1 });
    expect(await countUsers()).toBe(1);
  });

  test('no transaction is opened', async () => {
    const transaction = vi.spyOn(userRepo.db, 'transaction');
    expect((await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('e@x.io') })).statusCode).toBe(201);
    expect(transaction).not.toHaveBeenCalled();
  });
});

// After hooks that fail for one name, to show that a failing after hook undoes the write it follows.
const failAfter = (name: string) => {
  if (name === 'After fails') throw new ConflictError('After hook failed');
};
const afterHookService = createService<typeof userEntity, TestUser>(userRepo, {
  hooks: {
    beforeCreate: ({ input }) => ({ ...input, passwordHash: 'h' }),
    afterCreate: ({ row }) => failAfter(row.name),
    afterUpdate: ({ row }) => failAfter(row.name),
    afterDelete: ({ row }) => failAfter(row.name),
  },
});
const afterHookRoutes = (transaction: boolean) =>
  crudRoutes<typeof userEntity, TestUser>({ service: afterHookService, transaction, context: (request) => request.user ?? undefined, authorize: { '*': () => true } });
const insertUser = async (name: string) =>
  (await db.insert(users).values({ ...newUser('u@x.io', name), passwordHash: 'h' }).returning({ id: users.id }))[0]?.id;
const storedUser = async () => (await db.select({ name: users.name, deletedAt: users.deletedAt }).from(users))[0];

describe('after hooks with transaction: true', () => {
  const app = useServer({ register: (app) => app.register(afterHookRoutes(true), { prefix: '/users' }) });

  test('afterCreate that throws leaves no row', async () => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('a@x.io', 'After fails') });
    expect(response.statusCode).toBe(409);
    expect(await countUsers()).toBe(0);
  });

  test('afterUpdate that throws leaves the old values', async () => {
    const id = await insertUser('Ann');
    const response = await app().inject({ method: 'PATCH', url: `/users/${id}`, headers: as(admin), payload: { name: 'After fails' } });
    expect(response.statusCode).toBe(409);
    expect(await storedUser()).toEqual({ name: 'Ann', deletedAt: null });
  });

  test('afterDelete that throws leaves the row in place', async () => {
    const id = await insertUser('After fails');
    const response = await app().inject({ method: 'DELETE', url: `/users/${id}`, headers: as(admin) });
    expect(response.statusCode).toBe(409);
    expect(await storedUser()).toEqual({ name: 'After fails', deletedAt: null });
  });
});

describe('after hooks with transaction: false', () => {
  const app = useServer({ register: (app) => app.register(afterHookRoutes(false), { prefix: '/users' }) });

  test('the write survives an afterCreate that throws', async () => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: as(admin), payload: newUser('a@x.io', 'After fails') });
    expect(response.statusCode).toBe(409);
    expect(await countUsers()).toBe(1);
  });
});
