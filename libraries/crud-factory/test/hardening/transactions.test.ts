// Edge cases for the per-request transaction and the service hooks around it.
import { count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { crudRoutes, type CrudRoutesOptions } from '../../src/fastify/index.ts';
import {
  ConflictError, createRepository, createService, requireAuth, type Database, type ServiceHooks,
} from '../../src/index.ts';
import { postEntity, userEntity } from '../fixtures/entities.ts';
import { posts, users } from '../fixtures/schema.ts';
import { useTestDb } from '../helpers/db.ts';
import { as, captureLogs, useServer, type TestUser } from '../helpers/server.ts';

const { db } = useTestDb();

type HookName = keyof ServiceHooks<typeof userEntity, TestUser>;

const postRepo = createRepository(db, postEntity);
const userRepo = createRepository(db, userEntity);
/** The hook that should throw after writing its audit row, if any. */
let failAt: HookName | undefined;
/** Every hook call, in order, with its arguments. */
const calls: { hook: HookName; args: Record<string, unknown> }[] = [];
let afterUpdateMutatesRow = false;

/** Records the call, writes an audit post (a second entity) in the hook's transaction, then maybe throws. */
async function hookStep(hook: HookName, args: { ctx: { tx?: Database } } & Record<string, unknown>): Promise<void> {
  calls.push({ hook, args });
  await postRepo.create({ authorId: 1, orgId: 10, title: hook }, { tx: args.ctx.tx });
  if (failAt === hook) throw new ConflictError(`${hook} failed`);
}

const userService = createService<typeof userEntity, TestUser>(userRepo, {
  hooks: {
    beforeCreate: async (args) => {
      await hookStep('beforeCreate', args);
      return { ...args.input, passwordHash: 'h' };
    },
    afterCreate: async (args) => hookStep('afterCreate', args),
    beforeUpdate: async (args) => {
      await hookStep('beforeUpdate', args);
      return args.patch;
    },
    afterUpdate: async (args) => {
      await hookStep('afterUpdate', args);
      if (afterUpdateMutatesRow) Object.assign(args.row, { name: 'Mutated in hook' });
      // Typed as returning nothing; a value is smuggled in to prove it is dropped.
      return Reflect.apply(() => ({ id: -1, name: 'Hijacked' }), undefined, []);
    },
    beforeDelete: async (args) => hookStep('beforeDelete', args),
    afterDelete: async (args) => hookStep('afterDelete', args),
  },
});

/** Passes a value the types reject, as a buggy handler would. */
function untyped<T>(value: unknown): T {
  return value as T;
}

const admin: TestUser = { id: 1, orgId: 10, roles: ['admin'] };
const newUser = (email: string) => ({ email, name: 'New', orgId: 10 });

function routes(transaction: boolean): CrudRoutesOptions<typeof userEntity, TestUser, typeof userService> {
  return {
    service: userService,
    transaction,
    context: (request) => request.user ?? undefined,
    authorize: { '*': requireAuth },
    extend: (scope, { service, serviceContext }) => {
      // Catches a unique violation, then keeps using the aborted transaction.
      scope.post('/swallow-then-query', { config: { crudOperation: 'create' } }, async (request) => {
        const ctx = serviceContext(request);
        await service.repository.create({ email: 'seed@x.io', name: 'Dup', orgId: 10, passwordHash: 'h' }, { tx: ctx.tx }).catch(() => undefined);
        return service.repository.findMany({ tx: ctx.tx, withTotal: true });
      });
      // The documented fix: the risky write runs in a savepoint, so its failure doesn't abort the request.
      scope.post('/savepoint', { config: { crudOperation: 'create' } }, async (request, reply) => {
        const ctx = serviceContext(request);
        const tx = ctx.tx;
        if (!tx) throw new Error('expected a request transaction');
        const kept = await service.repository.create({ email: 'kept@x.io', name: 'Kept', orgId: 10, passwordHash: 'h' }, { tx });
        await tx
          .transaction((savepoint) => service.repository.create({ email: 'seed@x.io', name: 'Dup', orgId: 10, passwordHash: 'h' }, { tx: savepoint }))
          .catch(() => undefined);
        reply.status(201);
        return { id: kept.id };
      });
      // The write commits, then the response fails its schema.
      scope.post(
        '/bad-response',
        { config: { crudOperation: 'create' }, schema: { response: { 200: z.object({ id: z.string() }) } } },
        async (request) =>
          untyped<{ id: string }>(await service.repository.create({ email: 'late@x.io', name: 'L', orgId: 10, passwordHash: 'h' }, { tx: serviceContext(request).tx })),
      );
    },
  };
}

const logs = captureLogs();
const app = useServer({
  logger: logs.logger,
  register: async (app) => {
    await app.register(crudRoutes(routes(true)), { prefix: '/tx' });
    await app.register(crudRoutes(routes(false)), { prefix: '/nt' });
  },
});

const auditTitles = async () => (await db.select({ title: posts.title }).from(posts)).map((row) => row.title);
const userEmails = async () => (await db.select({ email: users.email }).from(users).orderBy(users.id)).map((row) => row.email);
const storedUser = async () => (await db.select({ name: users.name, deletedAt: users.deletedAt }).from(users).where(eq(users.id, 1)))[0];
const callNames = () => calls.map((call) => call.hook);

beforeEach(async () => {
  failAt = undefined;
  afterUpdateMutatesRow = false;
  calls.length = 0;
  await db.execute(sql`truncate posts, users restart identity cascade`);
  await db.execute(sql`insert into users (email, name, password_hash, org_id) values ('seed@x.io', 'Seed', 'h', 10)`);
});

/** The request that runs each hook, against `/tx` or `/nt`. */
function requestFor(hook: HookName, prefix: '/tx' | '/nt') {
  if (hook === 'beforeCreate' || hook === 'afterCreate') {
    return app().inject({ method: 'POST', url: prefix, headers: as(admin), payload: newUser('new@x.io') });
  }
  if (hook === 'beforeUpdate' || hook === 'afterUpdate') {
    return app().inject({ method: 'PATCH', url: `${prefix}/1`, headers: as(admin), payload: { name: 'Renamed' } });
  }
  return app().inject({ method: 'DELETE', url: `${prefix}/1`, headers: as(admin) });
}

describe('rollback', () => {
  test.each<HookName>(['beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDelete', 'afterDelete'])(
    '%s throwing after its own write rolls back both entities',
    async (hook) => {
      failAt = hook;
      expect((await requestFor(hook, '/tx')).statusCode).toBe(409);
      expect(await auditTitles()).toEqual([]);
      expect(await userEmails()).toEqual(['seed@x.io']);
      expect(await storedUser()).toEqual({ name: 'Seed', deletedAt: null });
    },
  );

  test('with transaction: false, the same afterUpdate failure keeps the update and the audit row', async () => {
    failAt = 'afterUpdate';
    expect((await requestFor('afterUpdate', '/nt')).statusCode).toBe(409);
    expect(await storedUser()).toMatchObject({ name: 'Renamed' });
    expect(await auditTitles()).toEqual(['beforeUpdate', 'afterUpdate']);
  });

  test('a response that fails its schema is a 500, but the write already committed', async () => {
    const response = await app().inject({ method: 'POST', url: '/tx/bad-response', headers: as(admin) });
    expect(response.statusCode).toBe(500);
    expect(await userEmails()).toContain('late@x.io');
  });
});

describe('aborted transactions (25P02)', () => {
  test('querying after a caught database error is a logged 25P02 500, and nothing commits', async () => {
    const before = logs.lines.length;
    const response = await app().inject({ method: 'POST', url: '/tx/swallow-then-query', headers: as(admin) });
    expect(response.statusCode).toBe(500);
    expect(logs.lines.slice(before).find((line) => line.msg === 'unhandled error in CRUD route')).toMatchObject({ error: { code: '25P02' } });
    expect(await userEmails()).toEqual(['seed@x.io']);
  });

  test('a handler without a database error commits as usual', async () => {
    const response = await app().inject({ method: 'POST', url: '/tx', headers: as(admin), payload: newUser('ok@x.io') });
    expect(response.statusCode).toBe(201);
    expect(await userEmails()).toEqual(['seed@x.io', 'ok@x.io']);
  });

  test('a savepoint around the risky write contains the failure and the request commits', async () => {
    const response = await app().inject({ method: 'POST', url: '/tx/savepoint', headers: as(admin) });
    expect(response.statusCode).toBe(201);
    expect(await userEmails()).toEqual(['seed@x.io', 'kept@x.io']);
  });
});

describe('hook order and arguments', () => {
  test('create: beforeCreate gets the client input, afterCreate the saved row without hidden columns', async () => {
    const response = await requestFor('afterCreate', '/tx');
    expect(response.statusCode).toBe(201);
    expect(callNames()).toEqual(['beforeCreate', 'afterCreate']);
    expect(calls[0]?.args).toMatchObject({ input: newUser('new@x.io'), ctx: { auth: admin, tx: expect.any(Object), log: expect.any(Object) } });
    expect(calls[0]?.args.ctx).toMatchObject({ scope: undefined });
    expect(calls[1]?.args).toMatchObject({ input: newUser('new@x.io'), row: { id: 2, email: 'new@x.io' } });
    expect(calls[1]?.args.row).not.toHaveProperty('passwordHash');
  });

  test('update: both hooks get the parsed id and the client patch', async () => {
    await requestFor('afterUpdate', '/tx');
    expect(callNames()).toEqual(['beforeUpdate', 'afterUpdate']);
    expect(calls[0]?.args).toMatchObject({ id: 1, patch: { name: 'Renamed' } });
    expect(calls[1]?.args).toMatchObject({ id: 1, patch: { name: 'Renamed' }, row: { name: 'Renamed' } });
  });

  test('delete: beforeDelete gets only the id, afterDelete the soft-deleted row', async () => {
    await requestFor('afterDelete', '/tx');
    expect(callNames()).toEqual(['beforeDelete', 'afterDelete']);
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(['ctx', 'id']);
    expect(calls[1]?.args).toMatchObject({ id: 1, row: { id: 1, deletedAt: expect.any(Date) } });
  });

  test("an after hook's return value is ignored", async () => {
    const response = await requestFor('afterUpdate', '/tx');
    expect(response.json()).toMatchObject({ id: 1, name: 'Renamed' });
  });

  test('an after hook that mutates row changes the response but not the database', async () => {
    afterUpdateMutatesRow = true;
    expect((await requestFor('afterUpdate', '/tx')).json()).toMatchObject({ name: 'Mutated in hook' });
    expect(await storedUser()).toMatchObject({ name: 'Renamed' });
  });

  test('calls on service.repository and finders run no hooks', async () => {
    const created = await userService.repository.create({ ...newUser('direct@x.io'), passwordHash: 'h' });
    await userService.repository.update(created.id, { name: 'Direct' });
    await userService.repository.delete(created.id);
    await userService.findByStatus('invited', { log: logs.logger });
    expect(calls).toEqual([]);
  });
});

describe('HEAD requests', () => {
  test('HEAD on the list runs authorize: anonymous is a 401', async () => {
    expect((await app().inject({ method: 'HEAD', url: '/tx' })).statusCode).toBe(401);
  });

  test('HEAD on an id answers 200 without a body, and 404 once it is soft-deleted', async () => {
    const live = await app().inject({ method: 'HEAD', url: '/tx/1', headers: as(admin) });
    expect(live.statusCode).toBe(200);
    expect(live.body).toBe('');
    await userRepo.delete(1);
    expect((await app().inject({ method: 'HEAD', url: '/tx/1', headers: as(admin) })).statusCode).toBe(404);
  });
});

test('parallel requests share PGlite\'s single connection without hanging', async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      app().inject({ method: 'POST', url: '/tx', headers: as(admin), payload: newUser(`p${index}@x.io`) })),
  );
  expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201, 201, 201]);
  const [row] = await db.select({ n: count() }).from(users);
  expect(row?.n).toBe(6);
}, 5_000);
