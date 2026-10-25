import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { z } from 'zod';
import { beforeEach, describe, expect, test } from 'vitest';
import { crudRoutes } from '../src/fastify/index.ts';
import { createRepository, createService, requireAuth } from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import { users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';
import { as, useServer, type TestUser } from './helpers/server.ts';

const { db } = useTestDb();

// Clients can't send hidden columns, so the hook sets the one the table requires.
const userService = createService(createRepository(db, userEntity), {
  hooks: { create: ({ input, run }) => run({ ...input, passwordHash: 'secret-hash' }) },
});
const alice: TestUser = { id: 1, orgId: 10, roles: ['admin'] };

const openRoutes = crudRoutes({ service: userService });
const guardedRoutes = crudRoutes({ service: userService, context: (request) => request.user ?? undefined, authorize: { '*': requireAuth } });

const idSchema = z.object({ id: z.number() });
const pageSchema = z.object({ items: z.array(z.object({ name: z.string() })), nextCursor: z.string().nullable() });

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});

describe('crudRoutes(...) route methods', () => {
  // The requests below go through the plugins, so the app itself is never used directly.
  useServer({
    register: async (app) => {
      await app.register(openRoutes, { prefix: '/users' });
      await app.register(guardedRoutes, { prefix: '/guarded' });
    },
  });

  test('each method calls its route under the prefix', async () => {
    const created = await openRoutes.create({ email: 'ann@example.com', name: 'Ann', orgId: 10 });
    expect(created.raw.req.method).toBe('POST');
    expect(created.raw.req.url).toBe('/users');
    expect(created.statusCode).toBe(201);
    const { id } = idSchema.parse(created.json());

    const got = await openRoutes.get(id, { fields: ['id', 'name'] });
    expect(got.raw.req.url).toBe(`/users/${id}?fields=id,name`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ id, name: 'Ann' });

    const listed = await openRoutes.list();
    expect(listed.raw.req.url).toBe('/users');
    expect(listed.json()).toMatchObject({ items: [{ id }] });

    const updated = await openRoutes.update(id, { status: 'active' });
    expect(updated.raw.req.method).toBe('PATCH');
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id, status: 'active' });

    const deleted = await openRoutes.delete(id);
    expect(deleted.raw.req.method).toBe('DELETE');
    expect(deleted.statusCode).toBe(204);
    expect((await openRoutes.get(id)).statusCode).toBe(404);
  });

  test('list queries round-trip: an __in array, a date range, sort, fields and a cursor walk', async () => {
    const names = ['Dan', 'Ann', 'Cat', 'Bob'];
    for (const [index, name] of names.entries()) {
      const response = await openRoutes.create({ email: `${name}@example.com`, name, orgId: 10, status: index === 3 ? 'banned' : 'active' });
      expect(response.statusCode).toBe(201);
    }
    // Dan is outside the date range and Bob has the wrong status, so only Ann and Cat match.
    await db.update(users).set({ createdAt: new Date('2026-01-01T00:00:00Z') });
    await db.update(users).set({ createdAt: new Date('2025-06-01T00:00:00Z') }).where(eq(users.name, 'Dan'));

    // Written inline, so the query object is checked against the entity's filters.
    const listPage = (cursor?: string) =>
      openRoutes.list({
        status__in: ['active', 'invited'],
        createdAt__gte: new Date('2025-12-01T00:00:00Z'),
        createdAt__lte: new Date('2026-02-01T00:00:00Z'),
        sort: ['name'],
        fields: ['name'],
        limit: 1,
        cursor,
      });
    const first = await listPage();
    expect(first.raw.req.url).toBe(
      '/users?status__in=active,invited&createdAt__gte=2025-12-01T00%3A00%3A00.000Z&createdAt__lte=2026-02-01T00%3A00%3A00.000Z&sort=name&fields=name&limit=1',
    );
    const firstPage = pageSchema.parse(first.json());
    expect(firstPage.items).toEqual([{ name: 'Ann' }]);
    if (firstPage.nextCursor === null) throw new Error('expected a second page');

    const second = pageSchema.parse((await listPage(firstPage.nextCursor)).json());
    expect(second).toEqual({ items: [{ name: 'Cat' }], nextCursor: null });
  });

  test('headers are forwarded', async () => {
    expect((await guardedRoutes.list()).statusCode).toBe(401);
    expect((await guardedRoutes.list({}, { headers: as(alice) })).statusCode).toBe(200);
  });
});

describe('route methods before and after registration', () => {
  test('calling before registration throws a clear error', async () => {
    const routes = crudRoutes({ service: userService });
    await expect(routes.list()).rejects.toThrow('users: register the crudRoutes plugin before calling its routes');
  });

  test('a plugin registered twice calls the last registration', async () => {
    const routes = crudRoutes({ service: userService });
    const app = Fastify();
    await app.register(routes, { prefix: '/first' });
    await app.register(routes, { prefix: '/second' });
    const response = await routes.list();
    expect(response.raw.req.url).toBe('/second');
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
