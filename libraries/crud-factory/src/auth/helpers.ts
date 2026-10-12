import type { AuthorizeRule } from './types.ts';

/** Allows any request that has a context, and returns 401 otherwise. */
export const requireAuth: AuthorizeRule<unknown> = ({ ctx }) => ctx !== undefined && ctx !== null;

/** A context that includes the caller's roles. */
export interface RoleContext {
  roles: readonly string[];
}

/** Allows callers with any of the given roles. Returns 401 without a context and 403 without a matching role. */
export function requireRole(...roles: string[]): AuthorizeRule<RoleContext> {
  return ({ ctx }) => ctx !== undefined && ctx.roles.some((role) => roles.includes(role));
}
