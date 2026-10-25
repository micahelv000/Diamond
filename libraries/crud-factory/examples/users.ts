// Run with: npx tsx examples/users.ts
// Users and posts CRUD on an in-memory Postgres, behind a stand-in for your auth plugin.
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { ConflictError, createRepository, createService, defineEntity, requireAuth, requireRole, UnauthorizedError } from '@diamond/crud-factory';
import { crudRoutes } from '@diamond/crud-factory/fastify';

// 1. Tables (normally your existing drizzle schema).
const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text('password_hash').notNull(),
  orgId: integer('org_id').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // soft delete uses it by default
});
const posts = pgTable('posts', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orgId: integer('org_id').notNull(),
  title: text().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

const client = new PGlite();
await client.exec(`
  create table users (id integer primary key generated always as identity, email text not null unique,
    name text not null, password_hash text not null, org_id integer not null, deleted_at timestamptz);
  create table posts (id integer primary key generated always as identity, org_id integer not null, title text not null,
    deleted_at timestamptz);
`);
const db = drizzle({ client });

// 2. Entities: what is hidden, writable, filterable and sortable.
const userEntity = defineEntity(users, {
  primaryKey: 'id',
  hidden: ['passwordHash'],
  create: { omit: ['id'] },
  update: { omit: ['email', 'orgId'] },
  filterable: { name: ['ilike'] },
  sortable: ['name', 'email'],
  defaultSort: 'email',
});
// `orgId` is the tenant column: clients can neither set it on create nor move a row with a patch.
const postEntity = defineEntity(posts, {
  primaryKey: 'id',
  create: { omit: ['id', 'orgId'] },
  update: { omit: ['orgId'] },
  sortable: ['title'],
});

// 3. Services. Hidden columns are never accepted from clients, so a hook sets `passwordHash` (a real
// app would hash a password from an invite flow). The post hook stamps the caller's org.
interface Caller {
  id: number;
  orgId: number;
  roles: string[];
}
const userService = createService(createRepository(db, userEntity), {
  hooks: { create: ({ input, run }) => run({ ...input, passwordHash: 'set-by-invite-flow' }) },
});
const postService = createService<typeof postEntity, Caller>(createRepository(db, postEntity), {
  hooks: {
    create: ({ input, context, run }) => {
      if (!context.auth) throw new UnauthorizedError();
      return run({ ...input, orgId: context.auth.orgId });
    },
  },
});
// Catching a database error from run(). On a taken email this hook pretends the invite worked and returns a
// stand-in row. Without a transaction that's allowed. Inside one, as in every write route, the failed insert
// has aborted the transaction, so the service throws instead of letting the route answer 201 for nothing.
const inviteService = createService(createRepository(db, userEntity), {
  hooks: {
    create: async ({ input, run }) => {
      try {
        return await run({ ...input, passwordHash: 'set-by-invite-flow' });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        return { id: 0, email: input.email, name: input.name, orgId: input.orgId };
      }
    },
  },
});

// 4. The app. Your real auth plugin (e.g. @fastify/jwt) sets request.user; this fake reads a header.
declare module 'fastify' {
  interface FastifyRequest {
    user: Caller | null;
  }
}
const app = Fastify();
app.decorateRequest('user', null);
app.addHook('onRequest', async (request) => {
  const header = request.headers['x-user'];
  request.user = header === 'admin' ? { id: 1, orgId: 10, roles: ['admin'] } : header === 'member' ? { id: 2, orgId: 20, roles: [] } : null;
});

const callerOf = (request: { user: Caller | null }) => request.user ?? undefined;
const userRoutes = crudRoutes({ service: userService, context: callerOf, authorize: { '*': requireAuth, create: requireRole('admin') } });
const postRoutes = crudRoutes({
  service: postService,
  context: callerOf,
  authorize: { '*': ({ context }) => (context ? eq(posts.orgId, context.orgId) : false) },
});
// The `onError` hook prints the error behind a 500, since the client only sees `INTERNAL_SERVER_ERROR`.
const inviteRoutes = crudRoutes({
  service: inviteService,
  context: callerOf,
  authorize: { '*': requireAuth, create: requireRole('admin') },
  hooks: { onError: async (_request, _reply, error) => console.log('  onError:', error.message) },
});
await app.register(userRoutes, { prefix: '/users' });
await app.register(inviteRoutes, { prefix: '/invites' });
await app.register(postRoutes, { prefix: '/posts' });

// 5. A few requests. `userRoutes.create`, `postRoutes.update`… check bodies at compile time, so leaving out
// a required field like `orgId` is a type error. The last request bypasses the types on purpose.
const as = (who: string) => ({ headers: { 'x-user': who } });
function show(response: LightMyRequestResponse): void {
  const { method, url, headers } = response.raw.req;
  console.log(`${method} ${url} as ${headers['x-user'] ?? 'anonymous'} → ${response.statusCode}`, response.body);
}

show(await userRoutes.list()); // 401: no user
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 20 }, as('member'))); // 403: admins only
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, as('admin')));
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, as('admin'))); // 409: email taken
show(await userRoutes.list({ name__ilike: 'an', fields: ['id', 'name'] }, as('member')));
show(await postRoutes.create({ title: 'Org 10 roadmap' }, as('admin')));
show(await postRoutes.create({ title: 'Org 20 notes' }, as('member')));
show(await postRoutes.list({ sort: ['title'] }, as('member'))); // only org 20's post
show(await postRoutes.update(1, { title: 'Hijacked' }, as('member'))); // 404: post 1 belongs to org 10
// `orgId` is omitted from updates, so the types reject it. Sent raw, the route drops it: the post stays in org 20.
show(await app.inject({ method: 'PATCH', url: '/posts/2', payload: { title: 'Moved', orgId: 10 }, ...as('member') }));
// Soft delete is on by default: the row stays in the table with `deleted_at` set, and reads skip it.
show(await postRoutes.delete(2, as('member')));
show(await postRoutes.get(2, {}, as('member'))); // 404
console.log('post 2 in the table:', (await client.query('select title, deleted_at is not null as deleted from posts where id = 2')).rows);

// The invite hook that catches the duplicate-email error. Called directly, without a transaction, the catch works.
console.log('invite without a transaction →', await inviteService.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, {}));
// Through the route, in its transaction, the service throws: a 500, with the reason printed by `onError`.
show(await inviteRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, as('admin')));

await app.close();
await client.close();
