import { eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { beforeEach, describe, expect, test } from 'vitest';
import { crudRoutes, type CrudRoutesOptions } from '../src/fastify/index.ts';
import {
  ConflictError, createRepository, createService, requireAuth, requireRole, UnauthorizedError, type AuthorizeRule, type ServiceContext,
} from '../src/index.ts';
import { postEntity, userEntity } from './fixtures/entities.ts';
import { posts, users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';
import { as, captureLogs, useServer, type TestUser } from './helpers/server.ts';

const { db } = useTestDb();

// Clients can't send hidden columns, so the hook sets the one the table requires.
const userService = createService(createRepository(db, userEntity), {
  hooks: { create: ({ input, run }) => run({ ...input, passwordHash: 'secret-hash' }) },
});
// The tenant column is stamped from the caller, never taken from the body.
const postService = createService<typeof postEntity, TestUser>(createRepository(db, postEntity), {
  hooks: {
    create: ({ input, context, run }) => {
      if (!context.auth) throw new UnauthorizedError();
      return run({ ...input, orgId: context.auth.orgId });
    },
  },
});

const alice: TestUser = { id: 1, orgId: 10, roles: ['admin'] };
const bob: TestUser = { id: 2, orgId: 20, roles: ['member'] };
const carol: TestUser = { id: 3, orgId: 20, roles: ['admin'] };
const tenantScope: AuthorizeRule<TestUser> = ({ context }) => (context ? eq(posts.orgId, context.orgId) : false);

const newUser = (overrides: Record<string, unknown> = {}) => ({
  email: 'ann@example.com',
  name: 'Ann',
  passwordHash: 'client-chosen-hash',
  orgId: 10,
  ...overrides,
});

const rowSchema = z.looseObject({ id: z.number() });
const listSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())), limit: z.number(), offset: z.number() });

async function seedUser(app: FastifyInstance, overrides: Record<string, unknown> = {}): Promise<number> {
  const response = await app.inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser(overrides) });
  expect(response.statusCode).toBe(201);
  return rowSchema.parse(response.json()).id;
}

async function storedUser(id: number) {
  const [row] = await db.select({ passwordHash: users.passwordHash, deletedAt: users.deletedAt }).from(users).where(eq(users.id, id));
  return row;
}

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});

describe('open CRUD routes', () => {
  const logs = captureLogs();
  const app = useServer({
    logger: logs.logger,
    register: (app) =>
      app.register(
        crudRoutes({
          service: userService,
          extend: (scope) => {
            // An unmapped database error: the drizzle message and the driver message both hold the value.
            scope.get('/boom', { config: { crudOperation: 'list' } }, () => db.execute(sql`select ${'top-secret-value'}::int`));
          },
        }),
        { prefix: '/users' },
      ),
  });

  test('a soft-deleted row is never returned, and no response shows deletedAt', async () => {
    const keptId = await seedUser(app(), { email: 'kept@example.com' });
    const deletedId = await seedUser(app(), { email: 'gone@example.com' });
    expect((await app().inject({ method: 'DELETE', url: `/users/${deletedId}` })).statusCode).toBe(204);

    // The row is still in the table, stamped.
    expect((await storedUser(deletedId))?.deletedAt).toBeInstanceOf(Date);
    // Every read skips it: get, list, and list with a filter that matches it.
    expect((await app().inject({ method: 'GET', url: `/users/${deletedId}` })).statusCode).toBe(404);
    const listed = await app().inject({ method: 'GET', url: '/users?limit=3&total=true' });
    expect(listed.json()).toMatchObject({ items: [{ id: keptId }], total: 1 });
    const filtered = await app().inject({ method: 'GET', url: '/users?name__ilike=Ann' });
    expect(filtered.json().items.map((row: { id: number }) => row.id)).toEqual([keptId]);
    // Writing to it is a 404 too.
    expect((await app().inject({ method: 'PATCH', url: `/users/${deletedId}`, payload: { name: 'Back' } })).statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: `/users/${deletedId}` })).statusCode).toBe(404);

    // `deletedAt` is never sent: not on a get, a list or a create.
    const kept = await app().inject({ method: 'GET', url: `/users/${keptId}` });
    expect(kept.json()).not.toHaveProperty('deletedAt');
    expect(listed.json().items[0]).not.toHaveProperty('deletedAt');
    expect((await app().inject({ method: 'GET', url: '/users?fields=id,deletedAt' })).statusCode).toBe(400);
  });

  test('create → 201, get/list/update → 200, delete → 204 with an empty body', async () => {
    const id = await seedUser(app());

    const got = await app().inject({ method: 'GET', url: `/users/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id, email: 'ann@example.com', status: 'invited' });

    const listed = await app().inject({ method: 'GET', url: '/users' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ id }], limit: 2, offset: 0 });

    const patched = await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { status: 'active' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id, status: 'active' });

    const deleted = await app().inject({ method: 'DELETE', url: `/users/${id}` });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await app().inject({ method: 'GET', url: `/users/${id}` })).statusCode).toBe(404);
  });

  test('400 for an invalid body, an unknown filter key, an empty patch and malformed JSON', async () => {
    const invalid = await app().inject({ method: 'POST', url: '/users', payload: { name: 'No email' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'BAD_REQUEST', data: { issues: expect.any(Array) } });

    const unknownFilter = await app().inject({ method: 'GET', url: '/users?passwordHash__eq=x' });
    expect(unknownFilter.statusCode).toBe(400);
    expect(unknownFilter.json()).toMatchObject({ code: 'BAD_REQUEST' });

    const id = await seedUser(app());
    const emptyPatch = await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: {} });
    expect(emptyPatch.statusCode).toBe(400);

    const malformed = await app().inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expect(malformed.statusCode).toBe(400);
    // Fastify's own 4xx errors keep Fastify's code.
    expect(malformed.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY', message: expect.any(String) });
  });

  test('404 for a missing id and 409 for a duplicate email', async () => {
    const missing = await app().inject({ method: 'GET', url: '/users/999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'NOT_FOUND', message: 'users not found' });
    expect((await app().inject({ method: 'PATCH', url: '/users/999', payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: '/users/999' })).statusCode).toBe(404);

    await seedUser(app());
    const duplicate = await app().inject({ method: 'POST', url: '/users', payload: newUser() });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      code: 'CONFLICT',
      message: 'Resource already exists',
      data: { constraint: 'users_email_unique' },
    });
  });

  test('?fields= narrows list and get responses', async () => {
    const id = await seedUser(app());
    const got = await app().inject({ method: 'GET', url: `/users/${id}?fields=id,name` });
    expect(got.json()).toEqual({ id, name: 'Ann' });
    const listed = await app().inject({ method: 'GET', url: '/users?fields=email' });
    expect(listSchema.parse(listed.json()).items).toEqual([{ email: 'ann@example.com' }]);
  });

  test('sort, limit and offset come from the querystring', async () => {
    await seedUser(app(), { email: 'c@x.io', name: 'Cleo', status: 'active' });
    await seedUser(app(), { email: 'b@x.io', name: 'Bert', status: 'banned' });
    await seedUser(app(), { email: 'a@x.io', name: 'Abe', status: 'active' });
    await seedUser(app(), { email: 'd@x.io', name: 'Dora', status: 'invited' });

    const names = async (query: string) =>
      listSchema.parse((await app().inject({ method: 'GET', url: `/users?${query}` })).json()).items.map((item) => item.name);

    expect(await names('sort=name&limit=3')).toEqual(['Abe', 'Bert', 'Cleo']);
    expect(await names('sort=-name&limit=3')).toEqual(['Dora', 'Cleo', 'Bert']);
    expect(await names('sort=name&limit=1&offset=1')).toEqual(['Bert']);
    // maxLimit is 3 for the fixture entity.
    expect(await names('sort=name&limit=50')).toHaveLength(3);
    const withTotal = await app().inject({ method: 'GET', url: '/users?total=true&limit=1' });
    expect(withTotal.json()).toMatchObject({ total: 4 });
  });

  test('each declared filter operator works from the querystring, and blank values are ignored', async () => {
    const cleo = await seedUser(app(), { email: 'c@x.io', name: 'Cleo', status: 'active' });
    await seedUser(app(), { email: 'b@x.io', name: 'Bert', status: 'banned' });
    await seedUser(app(), { email: 'a@x.io', name: 'Abe', status: 'invited' });
    await db.update(users).set({ createdAt: new Date('2026-02-01T00:00:00Z') }).where(eq(users.id, cleo));

    const names = async (query: string) =>
      listSchema.parse((await app().inject({ method: 'GET', url: `/users?sort=name&limit=3&${query}` })).json()).items.map((item) => item.name);

    expect(await names('status__eq=active')).toEqual(['Cleo']);
    expect(await names('status__in=active,banned')).toEqual(['Bert', 'Cleo']);
    expect(await names('status__in=active&status__in=invited')).toEqual(['Abe', 'Cleo']);
    expect(await names('name__ilike=B')).toEqual(['Abe', 'Bert']);
    expect(await names('createdAt__gte=2026-01-01T00:00:00Z&createdAt__lte=2026-03-01T00:00:00Z')).toEqual(['Cleo']);
    expect(await names('status__eq=&name__ilike=')).toEqual(['Abe', 'Bert', 'Cleo']);
  });

  test.each([
    ['an invalid enum value', 'status__eq=nope'],
    ['an impossible date', 'createdAt__gte=2026-02-30T00:00:00Z'],
    ['a non-numeric number', 'orgId__eq=abc'],
    ['an undeclared column', 'email__eq=a@x.io'],
    ['an undeclared operator', 'status__ilike=a'],
    ['a hidden column', 'passwordHash__eq=x'],
  ])('a URL filter with %s is a 400', async (_label, query) => {
    const response = await app().inject({ method: 'GET', url: `/users?${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('?sort= is still limited to sortable: a visible but unsortable column is a 400', async () => {
    // Code can sort by `email`; the URL can't, because it isn't in `sortable`.
    const response = await app().inject({ method: 'GET', url: '/users?sort=email' });
    expect(response.statusCode).toBe(400);
    expect((await app().inject({ method: 'GET', url: '/users?sort=passwordHash' })).statusCode).toBe(400);
  });

  test('the hidden passwordHash column never appears in any response', async () => {
    const id = await seedUser(app());
    const responses = await Promise.all([
      app().inject({ method: 'GET', url: '/users' }),
      app().inject({ method: 'GET', url: `/users/${id}` }),
      app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { name: 'Renamed' } }),
      app().inject({ method: 'POST', url: '/users', payload: newUser({ email: 'z@x.io' }) }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
      expect(response.body).not.toContain('passwordHash');
      expect(response.body).not.toContain('secret-hash');
    }
    expect((await app().inject({ method: 'GET', url: `/users/${id}?fields=passwordHash` })).statusCode).toBe(400);
  });

  test('clients cannot write hidden or soft-delete columns', async () => {
    const id = await seedUser(app());
    expect((await storedUser(id))?.passwordHash).toBe('secret-hash');

    const hashPatch = await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { name: 'B', passwordHash: 'evil' } });
    expect(hashPatch.statusCode).toBe(200);
    expect((await storedUser(id))?.passwordHash).toBe('secret-hash');

    const deletePatch = await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { name: 'C', deletedAt: '2020-01-01T00:00:00Z' } });
    expect(deletePatch.statusCode).toBe(200);
    expect((await storedUser(id))?.deletedAt).toBeNull();
    expect((await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { deletedAt: '2020-01-01T00:00:00Z' } })).statusCode).toBe(400);

    const hiddenCreate = await seedUser(app(), { email: 'hidden@x.io', deletedAt: '2020-01-01T00:00:00Z' });
    expect((await app().inject({ method: 'GET', url: `/users/${hiddenCreate}` })).statusCode).toBe(200);
  });

  test('an unmapped database error is a generic 500 that hides its details', async () => {
    const response = await app().inject({ method: 'GET', url: '/users/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' });
    expect(response.body).not.toContain('top-secret-value');
  });

  test('the library writes no log lines of its own, only Fastify does', async () => {
    const before = logs.lines.length;
    const id = await seedUser(app());
    await app().inject({ method: 'GET', url: `/users/${id}` });
    await app().inject({ method: 'GET', url: '/users' });
    await app().inject({ method: 'PATCH', url: `/users/${id}`, payload: { name: 'Bo' } });
    await app().inject({ method: 'DELETE', url: `/users/${id}` });
    await app().inject({ method: 'GET', url: '/users/999' });
    await app().inject({ method: 'GET', url: '/users/boom' });
    const messages = new Set(logs.lines.slice(before).map((line) => line.msg));
    expect([...messages].sort()).toEqual(['incoming request', 'request completed']);
  });
});

describe('authorization', () => {
  const seenInputs: unknown[] = [];
  const app = useServer({
    register: async (app) => {
      await app.register(
        crudRoutes({
          service: userService,
          context: (request) => request.user ?? undefined,
          authorize: { '*': requireAuth, delete: requireRole('admin') },
        }),
        { prefix: '/users' },
      );
      await app.register(
        crudRoutes({
          service: postService,
          // An async mapper, as when the caller is loaded from a session store.
          context: async (request) => request.user ?? undefined,
          // '*' always applies: every operation is limited to the caller's org, and delete also needs admin.
          authorize: {
            '*': tenantScope,
            delete: requireRole('admin'),
            create: ({ input }) => {
              seenInputs.push(input);
              return true;
            },
          },
        }),
        { prefix: '/posts' },
      );
    },
  });

  async function createPost(who: TestUser, payload: Record<string, unknown>) {
    const response = await app().inject({ method: 'POST', url: '/posts', headers: as(who), payload });
    expect(response.statusCode).toBe(201);
    return z.looseObject({ id: z.number(), orgId: z.number() }).parse(response.json());
  }

  test('no user → 401, wrong role → 403', async () => {
    const anonymous = await app().inject({ method: 'GET', url: '/users' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Authentication required' });

    expect((await app().inject({ method: 'POST', url: '/users', payload: newUser() })).statusCode).toBe(401);
    const userId = await seedUser(app());

    const forbidden = await app().inject({ method: 'DELETE', url: `/users/${userId}`, headers: as(bob) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect((await app().inject({ method: 'DELETE', url: `/users/${userId}`, headers: as(alice) })).statusCode).toBe(204);
  });

  test("a SQL scope hides other orgs' rows on list and get, and makes their writes 404", async () => {
    const authorId = await seedUser(app());
    const alicePost = await createPost(alice, { authorId, title: 'Org 10 post' });
    await createPost(bob, { authorId, title: 'Org 20 post' });

    const bobList = await app().inject({ method: 'GET', url: '/posts', headers: as(bob) });
    expect(listSchema.parse(bobList.json()).items.map((item) => item.title)).toEqual(['Org 20 post']);

    const reads = await Promise.all([
      app().inject({ method: 'GET', url: `/posts/${alicePost.id}`, headers: as(bob) }),
      app().inject({ method: 'PATCH', url: `/posts/${alicePost.id}`, headers: as(bob), payload: { title: 'Hijacked' } }),
    ]);
    expect(reads.map((response) => response.statusCode)).toEqual([404, 404]);

    const stillThere = await app().inject({ method: 'GET', url: `/posts/${alicePost.id}`, headers: as(alice) });
    expect(stillThere.json()).toMatchObject({ title: 'Org 10 post' });
  });

  test('a foreign key that does not exist is a 400', async () => {
    const response = await app().inject({ method: 'POST', url: '/posts', headers: as(bob), payload: { authorId: 999, title: 'Orphan' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'BAD_REQUEST', message: 'Referenced resource does not exist' });
  });

  test("'*' and an operation rule both apply: an admin of another org can't delete", async () => {
    const authorId = await seedUser(app());
    const alicePost = await createPost(alice, { authorId, title: 'Org 10 post' });

    const crossTenant = await app().inject({ method: 'DELETE', url: `/posts/${alicePost.id}`, headers: as(carol) });
    expect(crossTenant.statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: `/posts/${alicePost.id}`, headers: as(bob) })).statusCode).toBe(403);
    expect((await app().inject({ method: 'DELETE', url: `/posts/${alicePost.id}`, headers: as(alice) })).statusCode).toBe(204);
  });

  test('the tenant column is stamped on create and cannot be moved by a patch', async () => {
    const authorId = await seedUser(app());
    seenInputs.length = 0;
    const bobPost = await createPost(bob, { authorId, title: 'Mine', orgId: alice.orgId });
    expect(bobPost.orgId).toBe(bob.orgId);
    // The rule saw the parsed body: `orgId` was already stripped.
    expect(seenInputs).toEqual([{ authorId, title: 'Mine' }]);

    const moved = await app().inject({
      method: 'PATCH',
      url: `/posts/${bobPost.id}`,
      headers: as(bob),
      payload: { title: 'Moved?', orgId: alice.orgId },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ title: 'Moved?', orgId: bob.orgId });
  });
});

describe('operations, hooks and extend', () => {
  let responsesSeen = 0;
  const app = useServer({
    register: (app) =>
      app.register(
        crudRoutes({
          service: userService,
          context: (request) => request.user ?? undefined,
          authorize: { '*': requireAuth },
          operations: { except: ['delete'] },
          hooks: {
            onRequest: async (_request, reply) => {
              reply.header('x-on-request', 'yes');
            },
            preValidation: async (_request, reply) => {
              reply.header('x-pre-validation', 'yes');
            },
            preHandler: [
              async (_request, reply) => {
                reply.header('x-pre-handler', 'yes');
              },
            ],
            onSend: async (_request, reply, payload) => {
              reply.header('x-on-send', 'yes');
              return payload;
            },
            onResponse: async () => {
              responsesSeen += 1;
            },
          },
          extend: (scope, { service, entity, serviceContext }) => {
            scope.post(
              '/:id/activate',
              {
                config: { crudOperation: 'update' },
                schema: { params: entity.schemas.params, response: { 200: entity.schemas.read } },
              },
              (request) => service.update(request.params.id, { status: 'active' }, serviceContext(request)),
            );
          },
        }),
        { prefix: '/users' },
      ),
  });

  test('operations.except removes the route', async () => {
    const id = await seedUser(app());
    const response = await app().inject({ method: 'DELETE', url: `/users/${id}`, headers: as(alice) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'NOT_FOUND', message: `Route DELETE /users/${id} not found` });
  });

  test('hooks run on generated and extend routes', async () => {
    const id = await seedUser(app());
    const responses = [
      await app().inject({ method: 'GET', url: '/users', headers: as(alice) }),
      await app().inject({ method: 'POST', url: `/users/${id}/activate`, headers: as(alice) }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'x-on-request': 'yes',
        'x-pre-validation': 'yes',
        'x-pre-handler': 'yes',
        'x-on-send': 'yes',
      });
    }
    expect(responsesSeen).toBeGreaterThanOrEqual(2);
  });

  test('a custom route inherits authorization and the error handler', async () => {
    const id = await seedUser(app());

    expect((await app().inject({ method: 'POST', url: `/users/${id}/activate` })).statusCode).toBe(401);

    const activated = await app().inject({ method: 'POST', url: `/users/${id}/activate`, headers: as(alice) });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ id, status: 'active' });
    expect(activated.body).not.toContain('passwordHash');

    const missing = await app().inject({ method: 'POST', url: '/users/999/activate', headers: as(alice) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'NOT_FOUND', message: 'users not found' });

    const badId = await app().inject({ method: 'POST', url: '/users/abc/activate', headers: as(alice) });
    expect(badId.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('every route must choose crudOperation or crudPublic', () => {
  const registrationError = async (extend: CrudRoutesOptions<typeof userEntity, undefined>['extend']) => {
    const app = Fastify({ logger: false });
    void app.register(crudRoutes({ service: userService, extend }), { prefix: '/users' });
    try {
      await app.ready();
    } catch (error) {
      return error;
    }
    throw new Error('app.ready() should have failed');
  };

  test('an untagged extend route fails at startup with a clear message', async () => {
    const error = await registrationError((scope) => {
      scope.get('/untagged', () => ({ ok: true }));
    });
    expect(error).toMatchObject({
      message: 'GET /users/untagged: crudRoutes routes need config.crudOperation, or config.crudPublic: true to skip authorize',
    });
  });

  test('setting both crudOperation and crudPublic fails at startup', async () => {
    const error = await registrationError((scope) => {
      scope.get('/both', { config: { crudOperation: 'list', crudPublic: true } }, () => ({ ok: true }));
    });
    expect(error).toMatchObject({ message: "GET /users/both: config.crudOperation and config.crudPublic can't both be set" });
  });
});

describe('crudPublic and tagged custom routes', () => {
  let leakedServiceContext: ((request: FastifyRequest) => ServiceContext<TestUser>) | undefined;
  const contextFlags = (context: ServiceContext<TestUser>) => ({
    userId: context.auth?.id ?? null,
    scoped: context.scope !== undefined,
    inTransaction: context.transaction !== undefined,
  });
  const app = useServer({
    register: async (app) => {
      await app.register(
        crudRoutes({
          service: postService,
          context: (request) => request.user ?? undefined,
          authorize: { '*': tenantScope },
          extend: (scope, { service, serviceContext }) => {
            leakedServiceContext = serviceContext;
            scope.get('/public', { config: { crudPublic: true } }, async (request) => {
              const context = serviceContext(request);
              // Unscoped, so it counts every org's posts.
              const { items } = await service.findMany({}, context);
              return { ...contextFlags(context), visiblePosts: items.length };
            });
            scope.get('/tagged', { config: { crudOperation: 'list' } }, (request) => contextFlags(serviceContext(request)));
          },
        }),
        { prefix: '/posts' },
      );
      // A route outside the plugin, where no authorize check runs, that reuses `serviceContext`.
      app.get('/outside', (request) => {
        leakedServiceContext?.(request);
        return { ok: true };
      });
    },
  });

  test('a crudPublic route serves an anonymous caller with no user and no scope', async () => {
    const [author] = await db.insert(users).values({ ...newUser(), passwordHash: 'h' }).returning({ id: users.id });
    const authorId = author?.id ?? 0;
    await db.insert(posts).values([{ authorId, orgId: 10, title: 'A' }, { authorId, orgId: 20, title: 'B' }]);

    const anonymous = await app().inject({ method: 'GET', url: '/posts/public' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ userId: null, scoped: false, inTransaction: false, visiblePosts: 2 });

    // Even a signed-in caller gets no user and no scope on a public route.
    const signedIn = await app().inject({ method: 'GET', url: '/posts/public', headers: as(bob) });
    expect(signedIn.json()).toMatchObject({ userId: null, scoped: false });
  });

  test('a tagged custom route still runs authorize', async () => {
    expect((await app().inject({ method: 'GET', url: '/posts/tagged' })).statusCode).toBe(401);
    const response = await app().inject({ method: 'GET', url: '/posts/tagged', headers: as(bob) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: bob.id, scoped: true, inTransaction: false });
  });

  test('the auto HEAD route of a tagged GET route runs authorize too', async () => {
    expect((await app().inject({ method: 'HEAD', url: '/posts/tagged' })).statusCode).toBe(401);
    expect((await app().inject({ method: 'HEAD', url: '/posts/tagged', headers: as(bob) })).statusCode).toBe(200);
  });

  test('serviceContext still fails closed where no authorize check ran', async () => {
    expect((await app().inject({ method: 'GET', url: '/outside' })).statusCode).toBe(500);
  });
});

describe('a ConflictError thrown by business code', () => {
  const app = useServer({
    register: (app) =>
      app.register(
        crudRoutes({
          service: createService(createRepository(db, userEntity), {
            hooks: {
              create: () => {
                throw new ConflictError('Aircraft busy');
              },
            },
          }),
        }),
        { prefix: '/users' },
      ),
  });

  test('is a 409 with its message and no data', async () => {
    const response = await app().inject({ method: 'POST', url: '/users', payload: newUser() });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ code: 'CONFLICT', message: 'Aircraft busy' });
  });
});

describe('operations.only and authorize without context', () => {
  const app = useServer({
    register: (app) =>
      app.register(crudRoutes({ service: userService, authorize: { '*': requireAuth }, operations: { only: ['get'] } }), {
        prefix: '/users',
      }),
  });

  test('only the listed operations are registered', async () => {
    expect((await app().inject({ method: 'GET', url: '/users/1', headers: as(alice) })).statusCode).toBe(401);
    expect((await app().inject({ method: 'GET', url: '/users', headers: as(alice) })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser() })).statusCode).toBe(404);
  });
});
