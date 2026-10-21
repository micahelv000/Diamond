import { and, eq, is, SQL } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { evaluateAuthorization } from '../src/auth/evaluate.ts';
import { requireAuth, requireRole, type AuthorizeMap } from '../src/index.ts';
import { posts } from './fixtures/schema.ts';

interface TestContext {
  user: { id: number; orgId: number };
  roles: string[];
}

const member: TestContext = { user: { id: 1, orgId: 10 }, roles: ['member'] };
const admin: TestContext = { user: { id: 2, orgId: 10 }, roles: ['admin'] };

const rules: AuthorizeMap<TestContext> = {
  '*': requireAuth,
  list: ({ context }) => (context ? eq(posts.orgId, context.user.orgId) : false),
  delete: requireRole('admin'),
};

describe('evaluateAuthorization', () => {
  test('no rules means open', async () => {
    expect(await evaluateAuthorization({ rules: undefined, op: 'create', context: undefined })).toEqual({ kind: 'allow' });
  });

  test("'*' alone applies to operations without their own rule", async () => {
    expect(await evaluateAuthorization({ rules, op: 'get', context: member })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules, op: 'get', context: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test('a SQL result becomes a scope', async () => {
    const result = await evaluateAuthorization({ rules, op: 'list', context: member });
    expect(result.kind).toBe('scope');
    expect(result.kind === 'scope' && is(result.sql, SQL)).toBe(true);
  });

  test('requireRole denies with 403 semantics and 401 without context', async () => {
    expect(await evaluateAuthorization({ rules, op: 'delete', context: member })).toEqual({ kind: 'deny' });
    expect(await evaluateAuthorization({ rules, op: 'delete', context: admin })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules, op: 'delete', context: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test("'*' always applies: an operation rule adds to it instead of replacing it", async () => {
    const tenant = eq(posts.orgId, 10);
    const combined: AuthorizeMap<TestContext> = { '*': () => tenant, delete: requireRole('admin'), update: () => eq(posts.id, 1) };
    // The admin passes `delete`, and the tenant scope from '*' still applies.
    expect(await evaluateAuthorization({ rules: combined, op: 'delete', context: admin })).toEqual({ kind: 'scope', sql: and(tenant) });
    expect(await evaluateAuthorization({ rules: combined, op: 'delete', context: member })).toEqual({ kind: 'deny' });
    // Two scopes are ANDed.
    const update = await evaluateAuthorization({ rules: combined, op: 'update', context: member });
    expect(update).toEqual({ kind: 'scope', sql: and(tenant, eq(posts.id, 1)) });
    // A false '*' wins over a permissive operation rule.
    const strict: AuthorizeMap<TestContext> = { '*': requireAuth, get: () => true };
    expect(await evaluateAuthorization({ rules: strict, op: 'get', context: undefined })).toEqual({ kind: 'unauthenticated' });
  });

  test("a '*' scope doesn't apply to create, and a create rule returning SQL is a configuration error", async () => {
    const scoped: AuthorizeMap<TestContext> = { '*': ({ context }) => (context ? eq(posts.orgId, context.user.orgId) : false) };
    expect(await evaluateAuthorization({ rules: scoped, op: 'create', context: member })).toEqual({ kind: 'allow' });
    expect(await evaluateAuthorization({ rules: scoped, op: 'create', context: undefined })).toEqual({ kind: 'unauthenticated' });
    const misconfigured: AuthorizeMap<TestContext> = { create: () => eq(posts.orgId, 10) };
    await expect(evaluateAuthorization({ rules: misconfigured, op: 'create', context: member })).rejects.toThrow('create rules must return a boolean');
  });

  test('async rules receive op, id and input', async () => {
    const seen: unknown[] = [];
    const asyncRules: AuthorizeMap<TestContext> = {
      update: async (args) => {
        seen.push(args);
        return true;
      },
    };
    await evaluateAuthorization({ rules: asyncRules, op: 'update', context: member, id: 5, input: { title: 't' } });
    expect(seen).toEqual([{ context: member, op: 'update', id: 5, input: { title: 't' } }]);
  });
});
