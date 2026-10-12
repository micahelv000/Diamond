// Edge cases for the generated Fastify routes: the authorization matrix, tenant isolation, hostile
// bodies, error hygiene and route tagging.
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { crudRoutes } from '../../src/fastify/index.ts';
import { createRepository, createService, requireAuth, requireRole, UnauthorizedError, type AuthorizeRule } from '../../src/index.ts';
import { postEntity, userEntity } from '../fixtures/entities.ts';
import { posts } from '../fixtures/schema.ts';
import { useTestDb } from '../helpers/db.ts';
import { as, captureLogs, useServer, type TestUser } from '../helpers/server.ts';

const { db } = useTestDb();

const HASH = 'server-side-hash-value';
const userService = createService(createRepository(db, userEntity), {
  hooks: { beforeCreate: ({ input }) => ({ ...input, passwordHash: HASH }) },
});
const postService = createService<typeof postEntity, TestUser>(createRepository(db, postEntity), {
  hooks: {
    beforeCreate: ({ input, ctx }) => {
      if (!ctx.auth) throw new UnauthorizedError();
      return { ...input, orgId: ctx.auth.orgId };
    },
  },
});

const alice: TestUser = { id: 1, orgId: 10, roles: ['admin'] };
const dave: TestUser = { id: 4, orgId: 10, roles: ['member'] };
const carol: TestUser = { id: 3, orgId: 20, roles: ['admin'] };
const tenantScope: AuthorizeRule<TestUser> = ({ ctx }) => (ctx ? eq(posts.orgId, ctx.orgId) : false);
const denyAll: AuthorizeRule<TestUser> = () => false;
const GENERIC_500 = { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' };

const logs = captureLogs();
const app = useServer({
  logger: logs.logger,
  register: async (app) => {
    app.get('/host-route', () => {
      throw new Error('host failure');
    });
    await app.register(
      crudRoutes({
        service: postService,
        context: (request) => request.user ?? undefined,
        authorize: { '*': tenantScope, delete: requireRole('admin') },
      }),
      { prefix: '/posts' },
    );
    await app.register(
      crudRoutes({
        service: userService,
        context: (request) => request.user ?? undefined,
        authorize: { '*': requireAuth },
        logRequestBody: false,
        extend: (scope) => {
          scope.get('/boom', { config: { crudOperation: 'list' } }, () => {
            throw new Error('connect failed: password=hunter2');
          });
          scope.post('/sent', { config: { crudOperation: 'create' } }, (_request, reply) => reply.send({ ok: true }));
        },
      }),
      { prefix: '/users' },
    );
    await app.register(
      crudRoutes({
        service: postService,
        context: (request) => request.user ?? undefined,
        authorize: { '*': denyAll },
        extend: (scope) => {
          scope.get('/health', { config: { crudPublic: true } }, () => ({ ok: true }));
        },
      }),
      { prefix: '/locked' },
    );
  },
});

const newUser = (overrides: Record<string, unknown> = {}) => ({ email: 'ann@x.io', name: 'Ann', orgId: 10, ...overrides });

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
  // User 1 and post 1 belong to org 10.
  await db.execute(sql`insert into users (email, name, password_hash, org_id) values ('seed@x.io', 'Seed', 'h', 10)`);
  await db.execute(sql`insert into posts (author_id, org_id, title) values (1, 10, 'Org 10 post')`);
});

describe('authorization matrix', () => {
  type Row = [string, 'GET' | 'POST' | 'PATCH' | 'DELETE', string, TestUser | undefined, number];
  test.each<Row>([
    ['anonymous lists', 'GET', '/posts', undefined, 401],
    ['anonymous reads', 'GET', '/posts/1', undefined, 401],
    ['anonymous creates', 'POST', '/posts', undefined, 401],
    ['anonymous deletes', 'DELETE', '/posts/1', undefined, 401],
    ['another tenant reads', 'GET', '/posts/1', carol, 404],
    ['another tenant updates', 'PATCH', '/posts/1', carol, 404],
    ['another tenant admin deletes', 'DELETE', '/posts/1', carol, 404],
    ['the same tenant with the wrong role deletes', 'DELETE', '/posts/1', dave, 403],
    ['the same tenant reads', 'GET', '/posts/1', dave, 200],
    ['the same tenant updates', 'PATCH', '/posts/1', dave, 200],
    ['the same tenant admin deletes', 'DELETE', '/posts/1', alice, 204],
  ])('%s → %i', async (_label, method, url, caller, status) => {
    const payload = method === 'POST' ? { authorId: 1, title: 't' } : method === 'PATCH' ? { title: 'changed' } : undefined;
    const response = await app().inject({ method, url, headers: caller ? as(caller) : {}, ...(payload && { payload }) });
    expect(response.statusCode).toBe(status);
  });

  test("another tenant's list is empty, not an error", async () => {
    const response = await app().inject({ method: 'GET', url: '/posts?total=true', headers: as(carol) });
    expect(response.json()).toMatchObject({ items: [], total: 0 });
  });

  test("a '*' scope doesn't block create: the row is stamped with the caller's tenant, whatever the body says", async () => {
    const response = await app().inject({ method: 'POST', url: '/posts', headers: as(carol), payload: { authorId: 1, title: 't', orgId: 10 } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ orgId: 20 });
  });

  test("another tenant's failed update leaves the row unchanged", async () => {
    await app().inject({ method: 'PATCH', url: '/posts/1', headers: as(carol), payload: { title: 'stolen' } });
    const [row] = await db.select({ title: posts.title }).from(posts).where(eq(posts.id, 1));
    expect(row?.title).toBe('Org 10 post');
  });
});

describe('cross-tenant id guessing', () => {
  test.each(['GET', 'PATCH', 'DELETE'] as const)('%s on another tenant\'s id answers exactly like a missing id', async (method) => {
    const payload = method === 'PATCH' ? { title: 'x' } : undefined;
    const foreign = await app().inject({ method, url: '/posts/1', headers: as(carol), ...(payload && { payload }) });
    const missing = await app().inject({ method, url: '/posts/999', headers: as(carol), ...(payload && { payload }) });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
  });
});

describe('hostile requests', () => {
  test.each<[string, { body: string | object; type: string }, number]>([
    ['a text/plain body', { body: 'email=x', type: 'text/plain' }, 400],
    ['an unsupported content type', { body: '<x/>', type: 'application/xml' }, 415],
    ['a JSON array body', { body: '[]', type: 'application/json' }, 400],
    ['a JSON null body', { body: 'null', type: 'application/json' }, 400],
    ['an empty JSON body', { body: '', type: 'application/json' }, 400],
    ['a body over the 1 MiB limit', { body: JSON.stringify(newUser({ name: 'x'.repeat(1_100_000) })), type: 'application/json' }, 413],
  ])('%s is rejected with the error shape', async (_label, { body, type }, status) => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: { ...as(alice), 'content-type': type }, payload: body });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });

  test.each([
    ['__proto__', '{"email":"p@x.io","name":"P","orgId":10,"__proto__":{"isAdmin":true}}'],
    ['constructor.prototype', '{"email":"p@x.io","name":"P","orgId":10,"constructor":{"prototype":{"isAdmin":true}}}'],
  ])('a %s key in the body is rejected and pollutes nothing', async (_label, body) => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: { ...as(alice), 'content-type': 'application/json' }, payload: body });
    expect(response.statusCode).toBe(400);
    expect(Reflect.get({}, 'isAdmin')).toBeUndefined();
  });

  test('a __proto__ key in the querystring is a 400', async () => {
    const response = await app().inject({ method: 'GET', url: '/users?__proto__=x', headers: as(alice) });
    expect(response.statusCode).toBe(400);
  });

  test.each(['abc', '99999999999'])('the id %j is a 400, not a 500', async (id) => {
    expect((await app().inject({ method: 'GET', url: `/posts/${id}`, headers: as(alice) })).statusCode).toBe(400);
  });
});

describe('error hygiene', () => {
  test('error bodies never echo the hidden column or the conflicting value', async () => {
    const created = await app().inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser() });
    expect(created.statusCode).toBe(201);
    const conflict = await app().inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser({ passwordHash: 'client-hash' }) });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toMatch(/ann@x\.io|passwordHash|client-hash|server-side-hash/);
  });

  test('a 500 hides the error message from the body and the logs', async () => {
    const before = logs.lines.length;
    const response = await app().inject({ method: 'GET', url: '/users/boom', headers: as(alice) });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(GENERIC_500);
    expect(JSON.stringify(logs.lines.slice(before))).not.toContain('hunter2');
  });

  test('a NUL character in a text field is a 400', async () => {
    const response = await app().inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser({ name: 'a\u0000b' }) });
    expect(response.statusCode).toBe(400);
  });

  test('the NUL-character failure leaks the submitted value into neither the body nor the logs', async () => {
    const before = logs.lines.length;
    const response = await app().inject({ method: 'POST', url: '/users', headers: as(alice), payload: newUser({ name: 'nul-secret\u0000' }) });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain('nul-secret');
    expect(JSON.stringify(logs.lines.slice(before))).not.toContain('nul-secret');
  });
});

describe('route tagging', () => {
  test("a crudPublic route answers while '*' denies every tagged route in the same scope", async () => {
    expect((await app().inject({ method: 'GET', url: '/locked/health' })).json()).toEqual({ ok: true });
    expect((await app().inject({ method: 'GET', url: '/locked' })).statusCode).toBe(401);
    expect((await app().inject({ method: 'GET', url: '/locked', headers: as(alice) })).statusCode).toBe(403);
  });

  test("a host route outside the plugin keeps Fastify's own error handling", async () => {
    const response = await app().inject({ method: 'GET', url: '/host-route' });
    expect(response.statusCode).toBe(500);
    expect(z.object({ message: z.string() }).parse(response.json()).message).toBe('host failure');
  });

  test('reply.send() in a transactional route is a generic 500, and the next request still gets the connection', async () => {
    const sent = await app().inject({ method: 'POST', url: '/users/sent', headers: as(alice) });
    expect(sent.statusCode).toBe(500);
    expect(sent.json()).toEqual(GENERIC_500);
    expect((await app().inject({ method: 'GET', url: '/users/1', headers: as(alice) })).statusCode).toBe(200);
  }, 5_000);
});
