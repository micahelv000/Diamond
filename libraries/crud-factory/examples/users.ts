// Run with: npx tsx examples/users.ts
// Users and posts CRUD on an in-memory Postgres, behind a stand-in for your auth plugin.
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { createRepository, createService, defineEntity, requireAuth, requireRole, UnauthorizedError } from '@diamond/crud-factory';
import { crudRoutes } from '@diamond/crud-factory/fastify';

// 1. Tables (normally your existing drizzle schema).
const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text('password_hash').notNull(),
  orgId: integer('org_id').notNull(),
});
const posts = pgTable('posts', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orgId: integer('org_id').notNull(),
  title: text().notNull(),
});

const client = new PGlite();
await client.exec(`
  create table users (id integer primary key generated always as identity, email text not null unique,
    name text not null, password_hash text not null, org_id integer not null);
  create table posts (id integer primary key generated always as identity, org_id integer not null, title text not null);
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
  hooks: { beforeCreate: ({ input }) => ({ ...input, passwordHash: 'set-by-invite-flow' }) },
});
const postService = createService<typeof postEntity, Caller>(createRepository(db, postEntity), {
  hooks: {
    beforeCreate: ({ input, ctx }) => {
      if (!ctx.auth) throw new UnauthorizedError();
      return { ...input, orgId: ctx.auth.orgId };
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

const context = (request: { user: Caller | null }) => request.user ?? undefined;
const userRoutes = crudRoutes({ service: userService, context, authorize: { '*': requireAuth, create: requireRole('admin') } });
const postRoutes = crudRoutes({
  service: postService,
  context,
  authorize: { '*': ({ ctx }) => (ctx ? eq(posts.orgId, ctx.orgId) : false) },
});
await app.register(userRoutes, { prefix: '/users' });
await app.register(postRoutes, { prefix: '/posts' });

// 5. A few requests. `userRoutes.create`, `postRoutes.update`… check bodies at compile time, so leaving out
// a required field like `orgId` is a type error. The last request bypasses the types on purpose.
const as = (who: string) => ({ headers: { 'x-user': who } });
function show(response: LightMyRequestResponse): void {
  const { method, url, headers } = response.raw.req;
  console.log(`${method} ${url} as ${headers['x-user'] ?? 'anonymous'} → ${response.statusCode}`, response.body);
}

show(await userRoutes.list()); // 401: no user
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: '2' }, as('member'))); // 403: admins only
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, as('admin')));
show(await userRoutes.create({ email: 'ann@x.io', name: 'Ann', orgId: 10 }, as('admin'))); // 409: email taken
show(await userRoutes.list({ name__ilike: 'an', fields: ['id', 'name'] }, as('member')));
show(await postRoutes.create({ title: 'Org 10 roadmap' }, as('admin')));
show(await postRoutes.create({ title: 'Org 20 notes' }, as('member')));
show(await postRoutes.list({ sort: ['title'] }, as('member'))); // only org 20's post
show(await postRoutes.update(1, { title: 'Hijacked' }, as('member'))); // 404: post 1 belongs to org 10
// `orgId` is omitted from updates, so the types reject it. Sent raw, the route drops it: the post stays in org 20.
show(await app.inject({ method: 'PATCH', url: '/posts/2', payload: { title: 'Moved', orgId: 10 }, ...as('member') }));

await app.close();
await client.close();
