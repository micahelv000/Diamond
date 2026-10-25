import { and, type SQL } from 'drizzle-orm';
import type { AnyId, AuthorizationResult, AuthorizeMap, AuthorizeRule, Operation } from './types.ts';

/**
 * Runs the `'*'` rule and then the operation's rule. Every rule must pass, and their SQL conditions
 * are combined with AND. With no rules, the operation is allowed.
 */
export async function evaluateAuthorization<TContext, TId = AnyId>(args: {
  rules?: AuthorizeMap<TContext, TId>;
  op: Operation;
  context?: TContext;
  id?: TId;
  input?: unknown;
}): Promise<AuthorizationResult> {
  const { rules, op, context, id, input } = args;
  const scopes: SQL[] = [];
  const keys: readonly (Operation | '*')[] = ['*', op];
  for (const key of keys) {
    const rule: AuthorizeRule<TContext, TId> | undefined = rules?.[key];
    if (!rule) continue;
    const decision = await rule({ context, op, id, input });
    if (decision === false) return context === undefined || context === null ? { kind: 'unauthenticated' } : { kind: 'deny' };
    if (decision === true) continue;
    // A SQL condition filters existing rows, and an insert has none. So a `'*'` condition is ignored for
    // create, but a `create` rule returning SQL is treated as a mistake instead of silently ignored.
    if (op !== 'create') scopes.push(decision);
    else if (key === 'create') throw new Error('The create rule returned SQL; create rules must return a boolean');
  }
  const sql = and(...scopes);
  return sql ? { kind: 'scope', sql } : { kind: 'allow' };
}
