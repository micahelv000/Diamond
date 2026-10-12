// Run with: npx tsx examples/users.ts
// Users and posts CRUD on an in-memory Postgres, behind a stand-in for your auth plugin.
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify from 'fastify';
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
  primaryKey:  'id',
  hidden: ['passwordHash'],
  create: { omit: ['id'] },
  update: { omit: ['email', 'orgId'] },
  filterable: { name: ['ilike'] },
  sortable: ['name','email'],
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
await app.register(
  crudRoutes({ service: userService, context, authorize: { '*': requireAuth, create: requireRole('admin') } }),
  { prefix: '/users' },
);
await app.register(
  crudRoutes({
    service: postService,
    context,
    // A SQL rule scopes list/get/update/delete: callers only ever see and change their own org's posts.
    // (Create has no rows to filter; the hook above stamps the org instead.)
    authorize: { '*': ({ ctx }) => (ctx ? eq(posts.orgId, ctx.orgId) : false) },
  }),
  { prefix: '/posts' },
);

// 5. A few requests.
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: object) => {
  const response = await app.inject({ method, url, payload, headers: who ? { 'x-user': who } : {} });
  console.log(`${method} ${url} as ${who ?? 'anonymous'} → ${response.statusCode}`, response.body || '');
};

await call('GET', '/users',);
await call('POST', '/users', 'member', { email: 'ann@x.io', name: 'Ann', orgId: 10 });
await call('POST', '/users', 'admin', { email: 'ann@x.io', name: 'Ann', orgId: 10 });
await call('POST', '/users', 'admin', { email: 'ann@x.io', name: 'Ann', orgId: 10 });
await call('GET', '/users?name__ilike=an&fields=id,name', 'member');
await call('POST', '/posts', 'admin', { title: 'Org 10 roadmap' });
await call('POST', '/posts', 'member', { title: 'Org 20 notes' });
await call('GET', '/posts?sort=title', 'member');
await call('PATCH', '/posts/1', 'member', { title: 'Hijacked' });
await call('PATCH', '/posts/2', 'member', { title: 'Moved', orgId: 10 });

await app.close();
await client.close();
