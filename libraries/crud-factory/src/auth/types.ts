import type { SQL } from 'drizzle-orm';

/** The CRUD operations a rule can apply to. */
export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

/** Any primary key value. `crudRoutes` narrows it to the entity's primary key type. */
export type AnyId = string | number | bigint;

/** What an `authorize` rule receives about the request. `TId` is the primary key's type. */
export interface RuleArgs<TContext, TId = AnyId> {
  /** The caller's context from the routes' `context` option, or `undefined` for an anonymous caller. */
  context: TContext | undefined;
  /** The operation being attempted. */
  op: Operation;
  /** The id from the URL, typed like the primary key column. Set only for `get`, `update` and `delete`. */
  id?: TId;
  /** The validated request body for `create` and `update`, before any service hook changes it. */
  input?: unknown;
}

/**
 * Decides one request. Return `true` to allow it, `false` to block it (401 for an anonymous caller,
 * 403 otherwise), or a SQL condition to allow it only for matching rows. May be async.
 */
export type AuthorizeRule<TContext, TId = AnyId> = (args: RuleArgs<TContext, TId>) => boolean | SQL | Promise<boolean | SQL>;

/**
 * Authorization rules, one optional rule per operation. If both `'*'` and an operation's rule are set,
 * both must allow the request and their SQL conditions are combined.
 */
export interface AuthorizeMap<TContext, TId = AnyId> {
  /** Applies to every operation, in addition to that operation's own rule. */
  '*'?: AuthorizeRule<TContext, TId>;
  /** Who may list rows. A SQL condition limits which rows are returned. */
  list?: AuthorizeRule<TContext, TId>;
  /** Who may read one row. A row outside a returned SQL condition gives a 404. */
  get?: AuthorizeRule<TContext, TId>;
  /** Who may create rows. Must return a boolean, not SQL, since there are no existing rows to filter. */
  create?: AuthorizeRule<TContext, TId>;
  /** Who may update a row. A row outside a returned SQL condition gives a 404. */
  update?: AuthorizeRule<TContext, TId>;
  /** Who may delete a row. A row outside a returned SQL condition gives a 404. */
  delete?: AuthorizeRule<TContext, TId>;
}

/** The combined outcome of the rules for one request. */
export type AuthorizationResult =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'unauthenticated' }
  | { kind: 'scope'; sql: SQL };
