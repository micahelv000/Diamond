import { and, eq, is, SQL } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { evaluateAuthorization } from '../src/auth/evaluate.ts';
import { requireAuth, requireRole, type AuthorizeMap } from '../src/index.ts';
import { posts } from './fixtures/schema.ts';

interface Ctx {
  user: { id: number; orgId: number };
  roles: string[];
}

const member: Ctx = { user: { id: 1, orgId: 10 }, roles: ['member'] };
const admin: Ctx = { user: { id: 2, orgId: 10 }, roles: ['admin'] };

const rules: AuthorizeMap<Ctx> = {
  '*': requireAuth,
  list: ({ ctx }) => (ctx ? eq(posts.orgId, ctx.user.orgId) : false),
  delete: requireRole('admin'),
};

describe('evaluateAuthorization', () => {
  test('no rules means open', async () => {
    expect(await evaluateAuthorization({ rules: undefined, op: 'create', ctx: undefined })).toEqual({ kind: 'allow' });
  });

  test("'*' alone applies to operations without their own rule", async () => {
    expect(await evaluateAuthorization({ rules, op: 'get', ctx: member })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules, op: 'get', ctx: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test('a SQL result becomes a scope', async () => {
    const result = await evaluateAuthorization({ rules, op: 'list', ctx: member });
    expect(result.kind).toBe('scope');
    expect(result.kind === 'scope' && is(result.sql, SQL)).toBe(true);
  });

  test('requireRole denies with 403 semantics and 401 without context', async () => {
    expect(await evaluateAuthorization({ rules, op: 'delete', ctx: member })).toEqual({ kind: 'deny' });
    expect(await evaluateAuthorization({ rules, op: 'delete', ctx: admin })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules, op: 'delete', ctx: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test("'*' always applies: an operation rule adds to it instead of replacing it", async () => {
    const tenant = eq(posts.orgId, 10);
    const combined: AuthorizeMap<Ctx> = { '*': () => tenant, delete: requireRole('admin'), update: () => eq(posts.id, 1) };
    // The admin passes `delete`, and the tenant scope from '*' still applies.
    expect(await evaluateAuthorization({ rules: combined, op: 'delete', ctx: admin })).toEqual({ kind: 'scope', sql: and(tenant) });
    expect(await evaluateAuthorization({ rules: combined, op: 'delete', ctx: member })).toEqual({ kind: 'deny' });
    // Two scopes are ANDed.
    const update = await evaluateAuthorization({ rules: combined, op: 'update', ctx: member });
    expect(update).toEqual({ kind: 'scope', sql: and(tenant, eq(posts.id, 1)) });
    // A false '*' wins over a permissive operation rule.
    const strict: AuthorizeMap<Ctx> = { '*': requireAuth, get: () => true };
    expect(await evaluateAuthorization({ rules: strict, op: 'get', ctx: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test("a '*' scope doesn't apply to create, and a create rule returning SQL is a configuration error", async () => {
    const scoped: AuthorizeMap<Ctx> = { '*': ({ ctx }) => (ctx ? eq(posts.orgId, ctx.user.orgId) : false) };
    expect(await evaluateAuthorization({ rules: scoped, op: 'create', ctx: member })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules: scoped, op: 'create', ctx: undefined })).toEqual({ kind: 'unauthenticated' });
    const misconfigured: AuthorizeMap<Ctx> = { create: () => eq(posts.orgId, 10) };
    await expect(evaluateAuthorization({ rules: misconfigured, op: 'create', ctx: member })).rejects.toThrow('create rules must return a boolean');
  });

  test('async rules receive op, id and input', async () => {
    const seen: unknown[] = [];
    const asyncRules: AuthorizeMap<Ctx> = {
      update: async (args) => {
        seen.push(args);
        return true;
      },
    };
    await evaluateAuthorization({ rules: asyncRules, op: 'update', ctx: member, id: 5, input: { title: 't' } });
    expect(seen).toEqual([{ ctx: member, op: 'update', id: 5, input: { title: 't' } }]);
  });
});
